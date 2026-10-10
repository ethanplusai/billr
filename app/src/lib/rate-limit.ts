import 'server-only'
import { createHash } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Durable, cross-instance rate limiting.
 *
 * The previous implementation was a module-level Map. On Vercel each serverless
 * instance had its own copy and every deploy wiped it, so the effective ceiling
 * was "limit x number of warm instances" and an attacker could reset it by
 * waiting out a deploy. Counters now live in Postgres, which
 * is the only store every instance shares, and the increment is a single
 * INSERT ... ON CONFLICT DO UPDATE so it is atomic under concurrency: there is
 * no read-then-write window for two requests to race through.
 *
 * FAIL CLOSED. If the store cannot be reached, the default is to deny. A rate
 * limiter that silently allows everything the moment the database hiccups is
 * not a rate limiter, and the endpoints these guard (login, MCP, the public pay
 * links) are exactly the ones an attacker would try to knock the database over
 * to bypass. Call sites that would rather stay up than stay guarded must opt in
 * explicitly with onStoreFailure: 'allow', and say why.
 */

export interface RateLimitPolicy {
  /** Requests permitted per window. */
  limit: number
  /** Window length in milliseconds. Clamped server-side to [1s, 24h]. */
  windowMs: number
  /**
   * Behaviour when Postgres is unreachable. Defaults to 'deny' (fail closed).
   */
  onStoreFailure?: 'deny' | 'allow'
}

export interface RateLimitDecision {
  allowed: boolean
  /** Allowance left in the current window, floored at 0. */
  remaining: number
  /** Seconds until the window rolls over, suitable for a Retry-After header. */
  retryAfterSeconds: number
  /** True when the store was unreachable and onStoreFailure decided this. */
  degraded: boolean
}

/** Minimal surface this module needs from a Supabase client, so tests can fake it. */
export interface RateLimitStore {
  rpc(
    fn: 'consume_rate_limit' | 'peek_rate_limit',
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>
}

let storeFactory: (() => RateLimitStore) | null = null

/**
 * Test seam. Swaps the Postgres-backed store for a fake so the atomicity and
 * fail-closed behaviour can be exercised without a database. Not part of the
 * production API; production callers never touch this.
 */
export function _setRateLimitStore(factory: (() => RateLimitStore) | null): void {
  storeFactory = factory
}

function store(): RateLimitStore {
  if (storeFactory) return storeFactory()
  return createServiceClient() as unknown as RateLimitStore
}

/**
 * Builds an opaque bucket key.
 *
 * The identifier is hashed rather than stored in the clear: the counter table
 * would otherwise accumulate email addresses, IP addresses and API-key hashes,
 * which is personal data we have no reason to keep and a length we cannot
 * bound. The namespace stays readable so a bucket is still debuggable.
 */
export function rateLimitKey(namespace: string, identifier: string): string {
  const digest = createHash('sha256').update(identifier).digest('hex').slice(0, 32)
  return `${namespace}:${digest}`
}

interface RpcRow {
  allowed: boolean
  remaining: number
  retry_after_seconds: number
}

/** PostgREST returns a RETURNS TABLE function as an array of rows. */
function firstRow(data: unknown): RpcRow | null {
  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object') return null
  const candidate = row as Partial<RpcRow>
  if (typeof candidate.allowed !== 'boolean') return null
  return {
    allowed: candidate.allowed,
    remaining: typeof candidate.remaining === 'number' ? candidate.remaining : 0,
    retry_after_seconds:
      typeof candidate.retry_after_seconds === 'number' ? candidate.retry_after_seconds : 60,
  }
}

function storeFailure(policy: RateLimitPolicy, reason: string): RateLimitDecision {
  const allow = policy.onStoreFailure === 'allow'
  console.error(
    `rate-limit: store unavailable (${reason}); ${allow ? 'allowing (fail open, opted in)' : 'denying (fail closed)'}`
  )
  return {
    allowed: allow,
    remaining: 0,
    retryAfterSeconds: Math.max(1, Math.ceil(policy.windowMs / 1000)),
    degraded: true,
  }
}

/**
 * Spends one unit of a bucket's allowance and reports whether the caller may
 * proceed. Blocked requests still count, so hammering a tripped bucket keeps it
 * tripped rather than earning a fresh allowance.
 */
export async function consumeRateLimit(
  bucket: string,
  policy: RateLimitPolicy
): Promise<RateLimitDecision> {
  try {
    const { data, error } = await store().rpc('consume_rate_limit', {
      p_bucket: bucket,
      p_limit: policy.limit,
      p_window_seconds: Math.max(1, Math.ceil(policy.windowMs / 1000)),
      p_cost: 1,
    })
    if (error) return storeFailure(policy, error.message)
    const row = firstRow(data)
    if (!row) return storeFailure(policy, 'unexpected response shape')
    return {
      allowed: row.allowed,
      remaining: row.remaining,
      retryAfterSeconds: row.retry_after_seconds,
      degraded: false,
    }
  } catch (err) {
    return storeFailure(policy, err instanceof Error ? err.message : 'unknown error')
  }
}

/**
 * Reads a bucket without spending from it. Used to honour a standing lockout
 * before an attempt is made, so checking the lock does not deepen it.
 */
export async function peekRateLimit(
  bucket: string,
  policy: RateLimitPolicy
): Promise<RateLimitDecision> {
  try {
    const { data, error } = await store().rpc('peek_rate_limit', {
      p_bucket: bucket,
      p_limit: policy.limit,
      p_window_seconds: Math.max(1, Math.ceil(policy.windowMs / 1000)),
    })
    if (error) return storeFailure(policy, error.message)
    const row = firstRow(data)
    if (!row) return storeFailure(policy, 'unexpected response shape')
    return {
      allowed: row.allowed,
      remaining: row.remaining,
      retryAfterSeconds: row.retry_after_seconds,
      degraded: false,
    }
  } catch (err) {
    return storeFailure(policy, err instanceof Error ? err.message : 'unknown error')
  }
}

export interface LayeredCheck {
  bucket: string
  policy: RateLimitPolicy
}

/**
 * Spends from several buckets at once and returns the most restrictive answer.
 *
 * Every layer is consumed even when an earlier one already denies, which is the
 * point of layering: an attacker rotating email addresses must still burn the
 * per-IP allowance, and an attacker rotating IPs must still burn the
 * per-account allowance. Short-circuiting on the first denial would let the
 * cheap layer shield the expensive one.
 */
export async function consumeRateLimits(checks: LayeredCheck[]): Promise<RateLimitDecision> {
  if (checks.length === 0) {
    return { allowed: true, remaining: 0, retryAfterSeconds: 0, degraded: false }
  }
  const results = await Promise.all(checks.map((c) => consumeRateLimit(c.bucket, c.policy)))
  const denied = results.filter((r) => !r.allowed)
  if (denied.length === 0) {
    return {
      allowed: true,
      remaining: Math.min(...results.map((r) => r.remaining)),
      retryAfterSeconds: 0,
      degraded: results.some((r) => r.degraded),
    }
  }
  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: Math.max(...denied.map((r) => r.retryAfterSeconds)),
    degraded: denied.some((r) => r.degraded),
  }
}

// ---------------------------------------------------------------------------
// Client IP
// ---------------------------------------------------------------------------

/**
 * The single-value header this installation's own edge overwrites, or null when
 * there is no such header and nothing but `x-forwarded-for` may be believed.
 *
 * A header is only worth reading if something in front of us REPLACES it on
 * every request. `x-vercel-forwarded-for` qualifies on Vercel and nowhere else:
 * no other proxy sets it, so off Vercel it is simply a name an attacker can
 * choose, and reading it hands every caller a private rate-limit bucket. The
 * same is true of `x-real-ip`, which a reverse proxy may or may not
 * overwrite, so it is opt-in through BILLR_TRUSTED_IP_HEADER rather than
 * trusted by default.
 */
function trustedIpHeader(): string | null {
  const configured = process.env.BILLR_TRUSTED_IP_HEADER?.trim().toLowerCase()
  if (configured) return configured
  if (process.env.VERCEL || process.env.VERCEL_ENV) return 'x-vercel-forwarded-for'
  return null
}

/**
 * Resolves the caller's IP address from proxy headers.
 *
 * The order matters and the obvious choice is the wrong one. `x-forwarded-for`
 * is a list that each proxy APPENDS to, so its FIRST entry is whatever the
 * client sent, which anyone can set to a value of their choosing:
 *
 *     curl -H 'x-forwarded-for: 1.2.3.4' https://invoices.example.org/...
 *
 * Keying a limit on that first entry means an attacker gets a fresh allowance
 * per forged header, i.e. no limit at all. That is what the old
 * `forwarded.split(',')[0]` in the Stripe routes did.
 *
 * So: the platform header above when this installation actually has one, then
 * the LAST entry of `x-forwarded-for`, which is the hop the nearest trusted
 * proxy observed rather than anything the client asserted. A deployment with
 * neither returns null, and ipKey puts every such caller in ONE shared bucket:
 * an unidentifiable flood is still capped, which is the safe direction.
 */
export function clientIpFrom(headers: Headers): string | null {
  const trusted = trustedIpHeader()
  if (trusted) {
    const fromDirect = normaliseIp(headers.get(trusted)?.split(',').pop())
    if (fromDirect) return fromDirect
  }

  const forwarded = headers.get('x-forwarded-for')
  if (!forwarded) return null
  // Last, never first. See above.
  return normaliseIp(forwarded.split(',').pop())
}

function normaliseIp(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  // Only characters that can appear in an IPv4/IPv6 literal (plus a zone id),
  // capped, so a hostile header cannot become an unbounded bucket key.
  if (!trimmed || trimmed.length > 45 || !/^[0-9a-fA-F.:%]+$/.test(trimmed)) return null
  return trimmed.toLowerCase()
}

/**
 * Bucket key for an IP. When no IP can be resolved every such caller shares one
 * bucket rather than being waved through, so an unidentifiable flood is still
 * capped. In practice Vercel always supplies one.
 */
export function ipKey(namespace: string, ip: string | null): string {
  return rateLimitKey(namespace, ip ?? 'unknown')
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * Every limit in the product, in one place, so a call site cannot quietly
 * invent a looser one.
 */
export const RATE_LIMITS = {
  /** Per API key, for non-MCP API-key traffic. */
  apiKey: { limit: 60, windowMs: MINUTE } as RateLimitPolicy,
  /** Per API key, for MCP. Applied as the resolver's own bucket so one MCP request costs exactly one hit. */
  mcp: { limit: 120, windowMs: MINUTE } as RateLimitPolicy,

  /** Per invoice/estimate public id, on the public payment endpoints. */
  publicDocument: { limit: 10, windowMs: MINUTE } as RateLimitPolicy,
  /** Per IP, on the public payment endpoints. Higher than the per-document cap because an office shares an IP. */
  publicDocumentIp: { limit: 30, windowMs: MINUTE } as RateLimitPolicy,

  /** Per email address, all sign-in/sign-up/reset attempts. */
  authIdentifier: { limit: 10, windowMs: 15 * MINUTE } as RateLimitPolicy,
  /** Per IP, all auth attempts. Caps credential spraying across rotated identifiers. */
  authIp: { limit: 30, windowMs: 15 * MINUTE } as RateLimitPolicy,
  /** Per email address, FAILED attempts only. Trips a one-hour lockout on that account. */
  authIdentifierLockout: { limit: 8, windowMs: HOUR } as RateLimitPolicy,
  /** Per IP, FAILED attempts only. Trips a one-hour lockout on that source. */
  authIpLockout: { limit: 20, windowMs: HOUR } as RateLimitPolicy,

  /** Per IP, on the support submit path. The RPC already caps per email address. */
  supportIp: { limit: 10, windowMs: HOUR } as RateLimitPolicy,

  /**
   * Per IP, OAuth dynamic client registration. Registration is necessarily
   * unauthenticated (an agent handed a URL has no credential yet), so this is
   * the only thing standing between it and an unbounded row count. Twenty an
   * hour is far more than any real client needs: one registration lasts.
   */
  oauthRegisterIp: { limit: 20, windowMs: HOUR } as RateLimitPolicy,
  /**
   * Per IP, OAuth token endpoint. Covers code exchange and refresh. A single
   * connect spends one, a refresh spends one, so sixty a minute only trips for
   * something that is guessing.
   */
  oauthTokenIp: { limit: 60, windowMs: MINUTE } as RateLimitPolicy,
} as const
