import {
  RATE_LIMITS,
  clientIpFrom,
  consumeRateLimit,
  ipKey,
} from '@/lib/rate-limit'
import { normaliseClientName, validateRedirectUris } from '@/lib/oauth/params'
import { OAUTH_SCOPES } from '@/lib/oauth/scopes'
import { registerClient } from '@/lib/oauth/store'

/**
 * RFC 7591 dynamic client registration.
 *
 * Open registration is the only way an agent that was handed nothing but a URL
 * can become a client, so it is deliberately unauthenticated. What keeps it
 * from being a problem:
 *
 *   - Public clients only. No secret is issued, so a registration is worth
 *     nothing on its own: it still has to survive the consent screen, which
 *     shows a person the client's name before anything is granted.
 *   - Redirect URIs are restricted to https:// or loopback http:// and matched
 *     exactly at authorize time, so a registration cannot be used as a redirect.
 *   - Per-IP rate limit, fail closed, same durable limiter as every other
 *     endpoint.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function error(status: number, code: string, description: string): Response {
  return new Response(JSON.stringify({ error: code, error_description: description }), {
    status,
    headers: NO_STORE,
  })
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: NO_STORE })
}

export async function POST(req: Request): Promise<Response> {
  const decision = await consumeRateLimit(
    ipKey('oauth:register:ip', clientIpFrom(req.headers)),
    RATE_LIMITS.oauthRegisterIp
  )
  if (!decision.allowed) {
    return new Response(
      JSON.stringify({
        error: 'temporarily_unavailable',
        error_description: 'Too many registrations from this address. Try again later.',
      }),
      { status: 429, headers: { ...NO_STORE, 'Retry-After': String(decision.retryAfterSeconds) } }
    )
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return error(400, 'invalid_client_metadata', 'Body must be JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return error(400, 'invalid_client_metadata', 'Body must be a JSON object')
  }

  const input = body as Record<string, unknown>

  const redirects = validateRedirectUris(input.redirect_uris)
  if (!redirects.ok) {
    return error(400, 'invalid_redirect_uri', redirects.reason ?? 'Invalid redirect_uris')
  }

  // Public clients only: there is nowhere in a CLI or desktop agent to keep a
  // secret, and PKCE is the proof we actually rely on.
  const authMethod = input.token_endpoint_auth_method
  if (authMethod !== undefined && authMethod !== 'none') {
    return error(
      400,
      'invalid_client_metadata',
      'Only public clients are supported; token_endpoint_auth_method must be "none"'
    )
  }

  const grantTypes = input.grant_types
  if (grantTypes !== undefined) {
    if (
      !Array.isArray(grantTypes) ||
      !grantTypes.every((g) => g === 'authorization_code' || g === 'refresh_token')
    ) {
      return error(
        400,
        'invalid_client_metadata',
        'grant_types must be a subset of ["authorization_code","refresh_token"]'
      )
    }
  }

  const responseTypes = input.response_types
  if (responseTypes !== undefined) {
    if (!Array.isArray(responseTypes) || !responseTypes.every((r) => r === 'code')) {
      return error(400, 'invalid_client_metadata', 'Only the "code" response type is supported')
    }
  }

  const clientName = normaliseClientName(input.client_name)
  const client = await registerClient({ clientName, redirectUris: redirects.uris })
  if (!client) {
    return error(500, 'invalid_client_metadata', 'Could not register this client')
  }

  return new Response(
    JSON.stringify({
      client_id: client.client_id,
      client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: OAUTH_SCOPES.join(' '),
    }),
    { status: 201, headers: NO_STORE }
  )
}
