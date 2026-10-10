// SERVICE-ROLE MODULE. Bypasses RLS.
//
// One of the few sanctioned service-role importers, alongside src/lib/api-keys/resolver.ts,
// /api/v1/me and src/lib/mcp/scoped-db.ts. The OAuth endpoints run with no
// session at all by construction: /api/oauth/register and /api/oauth/token are
// called by an agent process that has not signed in to anything, and the rows
// they touch (oauth_clients, oauth_authorization_codes, oauth_refresh_tokens)
// carry credential material that RLS deliberately exposes to nobody. Keeping
// every one of those queries in this one module means the service client has
// exactly one new door, and it only opens onto the three OAuth tables plus the
// api_keys row a token grant mints. Anything a signed-in user does with their
// connections goes through ./connections.ts on their own RLS-checked client.
// Do not add service-role callers elsewhere without a review that says why.
import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { generateAccessToken } from '@/lib/api-keys/crypto'
import { generateClientId, generateSecret, hashSecret } from './params'
import type { OauthScope } from './scopes'

type ServiceClient = ReturnType<typeof createServiceClient>

let clientFactory: (() => ServiceClient) | null = null

/**
 * Test seam, mirroring src/lib/rate-limit.ts. Lets the code/refresh/token flows
 * be exercised against a fake query builder instead of a database. Production
 * never calls this.
 */
export function _setOauthServiceClient(factory: (() => ServiceClient) | null): void {
  clientFactory = factory
}

function svc(): ServiceClient {
  return clientFactory ? clientFactory() : createServiceClient()
}

const CODE_TTL_MS = 10 * 60_000
export const ACCESS_TOKEN_TTL_MS = 30 * 86_400_000
const REFRESH_TOKEN_TTL_MS = 90 * 86_400_000

const REFRESH_PREFIX = 'billr_rt_'

export interface OauthClientRecord {
  id: string
  client_id: string
  client_name: string
  redirect_uris: string[]
  created_at: string
}

interface AuthorizationCodeRecord {
  id: string
  oauth_client_id: string
  user_id: string
  business_id: string
  redirect_uri: string
  code_challenge: string
  permissions: string[]
  resource: string | null
  expires_at: string
}

export interface RefreshTokenRecord {
  id: string
  family_id: string
  oauth_client_id: string
  user_id: string
  business_id: string
  permissions: string[]
  api_key_id: string | null
  resource: string | null
  expires_at: string
  used_at: string | null
  revoked_at: string | null
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export async function registerClient(input: {
  clientName: string
  redirectUris: string[]
}): Promise<OauthClientRecord | null> {
  const { data, error } = await svc()
    .from('oauth_clients')
    .insert({
      client_id: generateClientId(),
      client_name: input.clientName,
      redirect_uris: input.redirectUris,
    })
    .select('id, client_id, client_name, redirect_uris, created_at')
    .maybeSingle()
  if (error || !data) {
    console.error('oauth: registerClient failed', error?.message)
    return null
  }
  return data as OauthClientRecord
}

export async function findClientByClientId(clientId: string): Promise<OauthClientRecord | null> {
  const { data, error } = await svc()
    .from('oauth_clients')
    .select('id, client_id, client_name, redirect_uris, created_at')
    .eq('client_id', clientId)
    .maybeSingle()
  if (error || !data) return null
  return data as OauthClientRecord
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

export async function issueAuthorizationCode(input: {
  clientRowId: string
  userId: string
  businessId: string
  redirectUri: string
  codeChallenge: string
  permissions: readonly OauthScope[]
  resource: string | null
}): Promise<string | null> {
  const code = generateSecret(32)
  const { error } = await svc()
    .from('oauth_authorization_codes')
    .insert({
      code_hash: hashSecret(code),
      oauth_client_id: input.clientRowId,
      user_id: input.userId,
      business_id: input.businessId,
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      permissions: [...input.permissions],
      resource: input.resource,
      expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    })
  if (error) {
    console.error('oauth: issueAuthorizationCode failed', error.message)
    return null
  }
  return code
}

export type CodeLookup =
  | { status: 'ok'; record: AuthorizationCodeRecord }
  | { status: 'reused'; record: AuthorizationCodeRecord }
  | { status: 'unknown' }

const CODE_COLUMNS =
  'id, oauth_client_id, user_id, business_id, redirect_uri, code_challenge, permissions, resource, expires_at'

/**
 * Redeems a code exactly once.
 *
 * The claim is an UPDATE ... WHERE used_at IS NULL, so two simultaneous
 * redemptions serialise on the row and only one comes back with a row. When the
 * claim misses we look the code up again: a code that exists but is already
 * spent is a replay, and the caller revokes everything that code ever issued
 * (OAuth 2.1 section 4.1.3) rather than merely refusing this one request.
 */
export async function consumeAuthorizationCode(code: string): Promise<CodeLookup> {
  const hash = hashSecret(code)
  const client = svc()
  const { data } = await client
    .from('oauth_authorization_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('code_hash', hash)
    .is('used_at', null)
    .select(CODE_COLUMNS)
    .maybeSingle()

  if (data) return { status: 'ok', record: data as AuthorizationCodeRecord }

  const { data: spent } = await client
    .from('oauth_authorization_codes')
    .select(CODE_COLUMNS)
    .eq('code_hash', hash)
    .maybeSingle()
  if (!spent) return { status: 'unknown' }
  return { status: 'reused', record: spent as AuthorizationCodeRecord }
}

/** Best-effort housekeeping; never blocks a token request. */
export function pruneExpiredCodes(): void {
  const cutoff = new Date(Date.now() - 86_400_000).toISOString()
  void svc()
    .from('oauth_authorization_codes')
    .delete()
    .lt('expires_at', cutoff)
    .then(
      () => {},
      () => {}
    )
}

// ---------------------------------------------------------------------------
// Access tokens (api_keys rows, so resolveApiKey stays the only gate)
// ---------------------------------------------------------------------------

export async function issueAccessToken(input: {
  userId: string
  businessId: string
  permissions: readonly string[]
  clientRowId: string
  label: string
}): Promise<{ secret: string; keyId: string; expiresAt: string } | null> {
  const { secret, hash, prefix } = generateAccessToken()
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString()
  const { data, error } = await svc()
    .from('api_keys')
    .insert({
      user_id: input.userId,
      business_id: input.businessId,
      label: input.label,
      key_hash: hash,
      key_prefix: prefix,
      permissions: [...input.permissions],
      expires_at: expiresAt,
      kind: 'oauth',
      oauth_client_id: input.clientRowId,
    })
    .select('id')
    .maybeSingle()
  if (error || !data) {
    console.error('oauth: issueAccessToken failed', error?.message)
    return null
  }
  return { secret, keyId: (data as { id: string }).id, expiresAt }
}

export async function revokeApiKeyById(keyId: string | null): Promise<void> {
  if (!keyId) return
  const { error } = await svc()
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId)
    .is('revoked_at', null)
  if (error) console.error('oauth: revokeApiKeyById failed', error.message)
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

const REFRESH_COLUMNS =
  'id, family_id, oauth_client_id, user_id, business_id, permissions, api_key_id, resource, expires_at, used_at, revoked_at'

export async function issueRefreshToken(input: {
  familyId: string
  clientRowId: string
  userId: string
  businessId: string
  permissions: readonly string[]
  apiKeyId: string
  resource: string | null
}): Promise<string | null> {
  const token = `${REFRESH_PREFIX}${generateSecret(32)}`
  const { error } = await svc()
    .from('oauth_refresh_tokens')
    .insert({
      token_hash: hashSecret(token),
      family_id: input.familyId,
      oauth_client_id: input.clientRowId,
      user_id: input.userId,
      business_id: input.businessId,
      permissions: [...input.permissions],
      api_key_id: input.apiKeyId,
      resource: input.resource,
      expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString(),
    })
  if (error) {
    console.error('oauth: issueRefreshToken failed', error.message)
    return null
  }
  return token
}

export async function findRefreshToken(token: string): Promise<RefreshTokenRecord | null> {
  const { data, error } = await svc()
    .from('oauth_refresh_tokens')
    .select(REFRESH_COLUMNS)
    .eq('token_hash', hashSecret(token))
    .maybeSingle()
  if (error || !data) return null
  return data as RefreshTokenRecord
}

/**
 * Claims a refresh token for rotation. Same single-use UPDATE as the code path,
 * so two clients racing with the same token cannot both be handed a new one.
 */
export async function claimRefreshToken(tokenId: string): Promise<boolean> {
  const { data } = await svc()
    .from('oauth_refresh_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('id', tokenId)
    .is('used_at', null)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle()
  return !!data
}

/**
 * Burns down a whole rotation family: every refresh token in it and every
 * access key those tokens minted. Called when a rotated refresh token or a
 * spent authorization code is presented again, which means the material leaked
 * and we cannot tell the thief from the client.
 */
export async function revokeRefreshFamily(familyId: string): Promise<void> {
  const client = svc()
  const now = new Date().toISOString()
  const { data } = await client
    .from('oauth_refresh_tokens')
    .select('api_key_id')
    .eq('family_id', familyId)

  const keyIds = ((data ?? []) as { api_key_id: string | null }[])
    .map((row) => row.api_key_id)
    .filter((id): id is string => !!id)

  if (keyIds.length > 0) {
    const { error } = await client
      .from('api_keys')
      .update({ revoked_at: now })
      .in('id', keyIds)
      .is('revoked_at', null)
    if (error) console.error('oauth: revokeRefreshFamily keys failed', error.message)
  }

  const { error } = await client
    .from('oauth_refresh_tokens')
    .update({ revoked_at: now })
    .eq('family_id', familyId)
    .is('revoked_at', null)
  if (error) console.error('oauth: revokeRefreshFamily tokens failed', error.message)
}

/**
 * Burns down every rotation family that can mint a replacement for one access
 * key. This is what a human clicking Revoke in the Agents UI needs: clearing
 * `api_keys.revoked_at` alone stops the current token but leaves the client
 * holding a refresh token, so the next silent rotation would hand it a fresh
 * 30-day key and the connection would come back on its own.
 *
 * It runs here rather than in ./connections.ts because oauth_refresh_tokens is
 * RLS-locked with no policies: no browser session can read or write it, so the
 * query has to use this module's service client. The caller has already proved
 * the key is theirs through their own RLS-checked UPDATE.
 */
export async function revokeRefreshTokensForApiKey(keyId: string): Promise<void> {
  const { data, error } = await svc()
    .from('oauth_refresh_tokens')
    .select('family_id')
    .eq('api_key_id', keyId)
  if (error) {
    console.error('oauth: revokeRefreshTokensForApiKey lookup failed', error.message)
    return
  }

  const families = [
    ...new Set(
      ((data ?? []) as { family_id: string | null }[])
        .map((row) => row.family_id)
        .filter((id): id is string => !!id)
    ),
  ]

  // Family-wide, not token-wide: a rotated family shares one lineage, so a
  // sibling token issued before this key would otherwise survive the revoke.
  for (const familyId of families) await revokeRefreshFamily(familyId)
}
