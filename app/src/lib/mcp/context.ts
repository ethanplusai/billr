import 'server-only'
import { resolveApiKey } from '@/lib/api-keys/resolver'
import { protectedResourceMetadataUrl } from '@/lib/oauth/metadata'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { createScopedDb, type ScopedDb } from './scoped-db'

// MCP callers get 120 requests / 60s per key. This is applied
// as the resolver's own per-key bucket rather than a second bucket layered on
// top, so a single MCP request costs exactly one rate-limit hit. The counter is
// durable and shared across instances and fails closed.
const MCP_RATE_LIMIT = RATE_LIMITS.mcp

export interface McpCtx {
  userId: string
  keyId: string
  businessIds: string[]
  permissions?: string[]
  db: ScopedDb
}

function jsonError(status: number, body: Record<string, unknown>, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

/**
 * Authenticates and scopes an incoming MCP request.
 *
 * Returns the request context ({ userId, businessIds, db }) on success, or a
 * Response to send back verbatim (401 invalid key, 429 rate limited) on
 * failure. Every MCP tool handler must be built from the returned ctx;
 * never reach for a raw service client directly.
 */
export async function getMcpContext(req: Request): Promise<McpCtx | Response> {
  const auth = req.headers.get('authorization') ?? ''
  const secret = auth.startsWith('Bearer ') ? auth.slice(7) : ''

  const resolved = await resolveApiKey(secret, { rateLimit: MCP_RATE_LIMIT })
  if ('error' in resolved) {
    if (resolved.error === 'rate_limited') {
      return jsonError(429, { error: 'Rate limit exceeded' }, { 'Retry-After': '60' })
    }
    // WWW-Authenticate points MCP clients at the resource metadata endpoint
    // (RFC 9728 / the MCP auth spec) so they can discover how to authenticate
    // instead of just seeing an opaque 401. This one header is what turns
    // "pasting the MCP URL fails" into "pasting it starts a sign-in":
    // the client reads the metadata document, finds this installation as the
    // authorization server, registers itself and runs the consent flow.
    return jsonError(
      401,
      {
        error: 'Missing or invalid access token',
        error_description:
          'Send a Billr API key or an OAuth access token as "Authorization: Bearer ...", or connect through OAuth using the resource metadata in the WWW-Authenticate header.',
      },
      {
        'WWW-Authenticate': `Bearer realm="billr", resource_metadata="${protectedResourceMetadataUrl()}"`,
      }
    )
  }

  const scope = { userId: resolved.userId, businessIds: resolved.businessIds }
  return {
    userId: resolved.userId,
    keyId: resolved.keyId,
    businessIds: resolved.businessIds,
    permissions: resolved.permissions,
    db: createScopedDb(scope),
  }
}
