import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { hashApiKey, isValidKeyFormat } from './crypto'
import { RATE_LIMITS, consumeRateLimit, rateLimitKey, type RateLimitPolicy } from '@/lib/rate-limit'

export interface ResolvedKey {
  userId: string
  keyId: string
  businessIds: string[]
  permissions: string[]
}

export interface ResolveApiKeyOptions {
  /**
   * Overrides the per-key rate-limit policy for this call site. Defaults to
   * RATE_LIMITS.apiKey (60 requests / 60s). The MCP server passes a higher
   * allowance (RATE_LIMITS.mcp, 120/60s) rather than running a second bucket of
   * its own, so every request is counted exactly once.
   */
  rateLimit?: RateLimitPolicy
}

export async function resolveApiKey(
  secret: string,
  opts?: ResolveApiKeyOptions
): Promise<ResolvedKey | { error: 'invalid' | 'rate_limited' }> {
  if (!isValidKeyFormat(secret)) return { error: 'invalid' }

  const hash = hashApiKey(secret)
  // Durable, shared across instances. Fails closed: if the
  // counter store is unreachable the key is treated as rate limited rather than
  // waved through, because this is the only gate in front of the MCP surface.
  const decision = await consumeRateLimit(rateLimitKey('apikey', hash), opts?.rateLimit ?? RATE_LIMITS.apiKey)
  if (!decision.allowed) return { error: 'rate_limited' }

  const supabase = createServiceClient()
  const { data: key } = await supabase
    .from('api_keys')
    .select('id, user_id, business_id, revoked_at, expires_at, permissions')
    .eq('key_hash', hash)
    .maybeSingle()

  if (!key || key.revoked_at || (key.expires_at && Date.parse(key.expires_at) <= Date.now())) return { error: 'invalid' }

  let businessIds: string[]
  if (key.business_id) {
    const { data: member } = await supabase
      .from('business_members')
      .select('business_id')
      .eq('user_id', key.user_id)
      .eq('business_id', key.business_id)
      .maybeSingle()
    if (!member) return { error: 'invalid' }
    businessIds = [key.business_id]
  } else {
    const { data: memberships } = await supabase
      .from('business_members')
      .select('business_id')
      .eq('user_id', key.user_id)
    businessIds = (memberships ?? []).map((m) => m.business_id)
  }

  // Best-effort usage stamp; never block the request on it
  void supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', key.id)
    .then(() => {}, () => {})

  return { userId: key.user_id, keyId: key.id, businessIds, permissions: key.permissions }
}
