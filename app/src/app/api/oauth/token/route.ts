import { mcpUrl } from '@/lib/deployment'
import {
  RATE_LIMITS,
  clientIpFrom,
  consumeRateLimit,
  ipKey,
} from '@/lib/rate-limit'
import { resourceMatches, verifyPkce } from '@/lib/oauth/params'
import { formatScope, isSubsetOf, narrowPermissions, parseScope } from '@/lib/oauth/scopes'
import {
  ACCESS_TOKEN_TTL_MS,
  claimRefreshToken,
  consumeAuthorizationCode,
  findClientByClientId,
  findRefreshToken,
  issueAccessToken,
  issueRefreshToken,
  pruneExpiredCodes,
  revokeApiKeyById,
  revokeRefreshFamily,
} from '@/lib/oauth/store'

/**
 * OAuth 2.1 token endpoint. Public clients, PKCE proof, rotating refresh
 * tokens.
 *
 * The access token it returns is a real api_keys row (kind 'oauth'), which is
 * the whole point: resolveApiKey stays the single gate in front of the MCP
 * surface and nothing downstream has to learn what an OAuth token is.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE: Record<string, string> = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/**
 * RFC 6749 section 5.2. Deliberately terse and identical for every reason a
 * grant can fail: "which of the three things you got wrong" is exactly what an
 * attacker probing stolen material wants told.
 */
function oauthError(code: string, description: string, status = 400): Response {
  return new Response(JSON.stringify({ error: code, error_description: description }), {
    status,
    headers: NO_STORE,
  })
}

async function readForm(req: Request): Promise<Record<string, string>> {
  const contentType = req.headers.get('content-type') ?? ''
  const out: Record<string, string> = {}
  if (contentType.includes('application/json')) {
    try {
      const body = (await req.json()) as Record<string, unknown>
      for (const [key, value] of Object.entries(body ?? {})) {
        if (typeof value === 'string') out[key] = value
      }
    } catch {
      return out
    }
    return out
  }
  // application/x-www-form-urlencoded is what RFC 6749 mandates and what every
  // MCP client sends.
  const text = await req.text()
  for (const [key, value] of new URLSearchParams(text)) out[key] = value
  return out
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: NO_STORE })
}

export async function POST(req: Request): Promise<Response> {
  const decision = await consumeRateLimit(
    ipKey('oauth:token:ip', clientIpFrom(req.headers)),
    RATE_LIMITS.oauthTokenIp
  )
  if (!decision.allowed) {
    return new Response(
      JSON.stringify({
        error: 'temporarily_unavailable',
        error_description: 'Too many token requests from this address. Try again shortly.',
      }),
      { status: 429, headers: { ...NO_STORE, 'Retry-After': String(decision.retryAfterSeconds) } }
    )
  }

  const form = await readForm(req)
  const grantType = form.grant_type

  if (grantType === 'authorization_code') return exchangeCode(form)
  if (grantType === 'refresh_token') return refresh(form)
  if (!grantType) return oauthError('invalid_request', 'grant_type is required')
  return oauthError('unsupported_grant_type', `Unsupported grant_type "${grantType}"`)
}

function tokenResponse(input: {
  accessToken: string
  refreshToken: string
  permissions: readonly string[]
}): Response {
  return new Response(
    JSON.stringify({
      access_token: input.accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: input.refreshToken,
      scope: formatScope(input.permissions),
    }),
    { status: 200, headers: NO_STORE }
  )
}

async function exchangeCode(form: Record<string, string>): Promise<Response> {
  const { code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier } = form

  if (!code || !clientId || !redirectUri) {
    return oauthError('invalid_request', 'code, client_id and redirect_uri are required')
  }
  if (!verifier) return oauthError('invalid_request', 'code_verifier is required')

  const client = await findClientByClientId(clientId)
  if (!client) return oauthError('invalid_client', 'Unknown client', 401)

  const lookup = await consumeAuthorizationCode(code)
  if (lookup.status === 'unknown') {
    return oauthError('invalid_grant', 'Authorization code is invalid or expired')
  }
  if (lookup.status === 'reused') {
    // A second redemption means the code leaked. Everything it ever issued goes
    // with it: the family id IS the code's row id, so one call covers every
    // token minted from this authorization.
    await revokeRefreshFamily(lookup.record.id)
    return oauthError('invalid_grant', 'Authorization code is invalid or expired')
  }

  const record = lookup.record
  if (Date.parse(record.expires_at) <= Date.now()) {
    return oauthError('invalid_grant', 'Authorization code is invalid or expired')
  }
  if (record.oauth_client_id !== client.id) {
    return oauthError('invalid_grant', 'Authorization code is invalid or expired')
  }
  if (record.redirect_uri !== redirectUri) {
    return oauthError('invalid_grant', 'redirect_uri does not match the authorization request')
  }
  if (!verifyPkce(verifier, record.code_challenge)) {
    return oauthError('invalid_grant', 'PKCE verification failed')
  }
  if (!resourceMatches(form.resource, mcpUrl())) {
    return oauthError('invalid_target', 'Unknown resource')
  }

  const permissions = narrowPermissions(record.permissions)
  const access = await issueAccessToken({
    userId: record.user_id,
    businessId: record.business_id,
    permissions,
    clientRowId: client.id,
    label: client.client_name,
  })
  if (!access) return oauthError('temporarily_unavailable', 'Could not issue a token', 503)

  const refreshToken = await issueRefreshToken({
    // The authorization code's row id is the rotation family id, so a replayed
    // code and a replayed refresh token burn down exactly the same set.
    familyId: record.id,
    clientRowId: client.id,
    userId: record.user_id,
    businessId: record.business_id,
    permissions,
    apiKeyId: access.keyId,
    resource: record.resource,
  })
  if (!refreshToken) {
    await revokeApiKeyById(access.keyId)
    return oauthError('temporarily_unavailable', 'Could not issue a token', 503)
  }

  pruneExpiredCodes()
  return tokenResponse({ accessToken: access.secret, refreshToken, permissions })
}

async function refresh(form: Record<string, string>): Promise<Response> {
  const { refresh_token: presented, client_id: clientId } = form
  if (!presented || !clientId) {
    return oauthError('invalid_request', 'refresh_token and client_id are required')
  }

  const client = await findClientByClientId(clientId)
  if (!client) return oauthError('invalid_client', 'Unknown client', 401)

  const record = await findRefreshToken(presented)
  if (!record) return oauthError('invalid_grant', 'Refresh token is invalid or expired')

  if (record.used_at || record.revoked_at) {
    // Reuse of a rotated token: the client kept a copy it should have thrown
    // away, or somebody else got hold of it. We cannot tell which, so the whole
    // family is revoked and the real client must send its user through consent
    // again.
    await revokeRefreshFamily(record.family_id)
    return oauthError('invalid_grant', 'Refresh token is invalid or expired')
  }
  if (record.oauth_client_id !== client.id) {
    return oauthError('invalid_grant', 'Refresh token is invalid or expired')
  }
  if (Date.parse(record.expires_at) <= Date.now()) {
    return oauthError('invalid_grant', 'Refresh token is invalid or expired')
  }
  if (!resourceMatches(form.resource, mcpUrl())) {
    return oauthError('invalid_target', 'Unknown resource')
  }

  // A refresh may narrow the grant, never widen it.
  let permissions = narrowPermissions(record.permissions)
  if (form.scope) {
    const asked = parseScope(form.scope)
    if (asked.length === 0 || !isSubsetOf(asked, permissions)) {
      return oauthError('invalid_scope', 'Requested scope exceeds the original grant')
    }
    permissions = narrowPermissions(asked, record.permissions)
  }

  if (!(await claimRefreshToken(record.id))) {
    // Lost the race with a concurrent rotation of the same token; treat it as
    // the reuse it is.
    await revokeRefreshFamily(record.family_id)
    return oauthError('invalid_grant', 'Refresh token is invalid or expired')
  }

  const access = await issueAccessToken({
    userId: record.user_id,
    businessId: record.business_id,
    permissions,
    clientRowId: client.id,
    label: client.client_name,
  })
  if (!access) return oauthError('temporarily_unavailable', 'Could not issue a token', 503)

  const next = await issueRefreshToken({
    familyId: record.family_id,
    clientRowId: client.id,
    userId: record.user_id,
    businessId: record.business_id,
    permissions,
    apiKeyId: access.keyId,
    resource: record.resource,
  })
  if (!next) {
    await revokeApiKeyById(access.keyId)
    return oauthError('temporarily_unavailable', 'Could not issue a token', 503)
  }

  // The superseded access key stops working the moment its replacement exists,
  // so a rotated-away token cannot keep calling tools for another 30 days.
  await revokeApiKeyById(record.api_key_id)

  return tokenResponse({ accessToken: access.secret, refreshToken: next, permissions })
}
