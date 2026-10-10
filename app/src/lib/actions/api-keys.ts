'use server'

import { KEY_PROFILES, type KeyProfile } from '@/lib/mcp/permissions'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { generateApiKey } from '@/lib/api-keys/crypto'
import {
  listOauthConnections,
  revokeOauthConnection,
  type OauthConnection,
} from '@/lib/oauth/connections'

export async function createApiKeyAction(
  label: string,
  businessId: string | null,
  profile: KeyProfile = 'draft'
): Promise<{ secret: string } | { error: string }> {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return { error: 'Not signed in' }
  if (!Object.hasOwn(KEY_PROFILES, profile)) return { error: 'Invalid permission profile' }
  if (label.length > 200) return { error: 'Label is too long' }
  if (!label.trim()) return { error: 'Label is required' }

  // Validate business access before inserting
  if (businessId) {
    const { data: member } = await supabase
      .from('business_members')
      .select('business_id')
      .eq('user_id', auth.user.id)
      .eq('business_id', businessId)
      .maybeSingle()
    if (!member) return { error: 'You do not have access to that business' }
  }

  const { secret, hash, prefix } = generateApiKey()
  const { error } = await supabase.from('api_keys').insert({
    user_id: auth.user.id,
    permissions: [...KEY_PROFILES[profile]],
    expires_at: new Date(Date.now()+90*86400000).toISOString(),
    business_id: businessId,
    label: label.trim(),
    key_hash: hash,
    key_prefix: prefix,
  })
  if (error) {
    console.error('createApiKeyAction:', error)
    return { error: 'Could not create key' }
  }

  revalidatePath('/agents')
  return { secret } // shown once; only the hash is stored
}

export async function revokeApiKeyAction(
  keyId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return { success: false, error: 'Not signed in' }

  const { data, error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId)
    .eq('user_id', auth.user.id)
    .is('revoked_at', null)
    .select('id')
  if (error) {
    console.error('revokeApiKeyAction:', error)
    return { success: false, error: 'Could not revoke key' }
  }
  if (!data?.length) return { success: false, error: 'Key not found or already revoked' }
  revalidatePath('/agents')
  return { success: true }
}

// Manual keys only. OAuth access tokens are api_keys rows too (kind='oauth'),
// and without this filter every approved MCP connection would show up in the
// hand-made key list with a Revoke button that leaves its refresh token alive.
// They get their own list via listOauthConnectionsAction.
export async function listApiKeysAction() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('api_keys')
    .select('id, label, business_id, key_prefix, last_used_at, created_at, revoked_at, permissions, expires_at')
    .eq('kind', 'manual')
    .order('created_at', { ascending: false })
  return data ?? []
}

export async function listOauthConnectionsAction(): Promise<OauthConnection[]> {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return []
  return listOauthConnections(auth.user.id)
}

export async function revokeOauthConnectionAction(
  keyId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return { success: false, error: 'Not signed in' }

  const result = await revokeOauthConnection(auth.user.id, keyId)
  if (result.success) revalidatePath('/agents')
  return result
}
