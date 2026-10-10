import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { revokeRefreshTokensForApiKey } from './store'

/**
 * Connections a person granted through the OAuth consent screen.
 *
 * These go through the caller's OWN Supabase client, not the service role:
 * api_keys already carries owner RLS, so the database
 * enforces "your keys only" without this module having to be trusted to add the
 * filter. The 1b Agents UI renders these next to manual keys.
 *
 * The listing reads ONE table. It used to embed `oauth_clients(client_name)`,
 * which no signed-in caller may read: the schema states
 * `REVOKE ALL ON oauth_clients FROM PUBLIC, anon, authenticated`, and PostgREST
 * resource embedding needs SELECT on the embedded table for the QUERYING role.
 * So every real request failed, the error was swallowed, and the Connected apps
 * panel showed its empty state no matter how many apps were connected. The name
 * is already on the row we are allowed to read: the token endpoint writes
 * `label: client.client_name` when it mints the key (src/lib/oauth/store.ts,
 * issueAccessToken). Widening oauth_clients to client roles to re-enable the
 * join would hand every signed-in user the whole registration table, which is
 * the opposite trade.
 *
 * The one thing RLS cannot do for us is the refresh side: oauth_refresh_tokens
 * has no policies at all, so revoking borrows ./store.ts's service client for
 * that single step, after the user's own client has proved the key is theirs.
 */

export interface OauthConnection {
  id: string
  label: string
  businessId: string | null
  permissions: string[]
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  clientName: string | null
}

interface ConnectionRow {
  id: string
  label: string
  business_id: string | null
  permissions: string[]
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
}

export async function listOauthConnections(userId: string): Promise<OauthConnection[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('api_keys')
    .select(
      'id, label, business_id, permissions, created_at, last_used_at, expires_at, revoked_at'
    )
    .eq('user_id', userId)
    .eq('kind', 'oauth')
    .order('created_at', { ascending: false })

  if (error || !data) {
    if (error) console.error('oauth: listOauthConnections failed', error.message)
    return []
  }

  return (data as unknown as ConnectionRow[]).map((row) => ({
    id: row.id,
    label: row.label,
    businessId: row.business_id,
    permissions: row.permissions,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    // The granting application's name, as recorded on the key when it was
    // minted. Not a join: see the module comment.
    clientName: row.label,
  }))
}

/**
 * Revokes one connection, refresh tokens and all.
 *
 * The `user_id` filter is belt to RLS's braces, and the `revoked_at IS NULL`
 * filter makes a double revoke report honestly rather than silently moving the
 * timestamp. Order matters: the RLS-checked UPDATE is the authorization check,
 * so the service-role refresh sweep only ever runs for a key the caller just
 * proved they own. Without that sweep a revoke is cosmetic, because the client
 * still holds a refresh token and the next rotation mints a new access key.
 */
export async function revokeOauthConnection(
  userId: string,
  keyId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId)
    .eq('user_id', userId)
    .eq('kind', 'oauth')
    .is('revoked_at', null)
    .select('id')

  if (error) {
    console.error('oauth: revokeOauthConnection failed', error.message)
    return { success: false, error: 'Could not revoke this connection' }
  }
  if (!data?.length) return { success: false, error: 'Connection not found or already revoked' }

  await revokeRefreshTokensForApiKey(keyId)
  return { success: true }
}
