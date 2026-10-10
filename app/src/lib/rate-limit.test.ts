import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  RATE_LIMITS,
  _setRateLimitStore,
  clientIpFrom,
  consumeRateLimit,
  consumeRateLimits,
  ipKey,
  peekRateLimit,
  rateLimitKey,
  type RateLimitStore,
} from './rate-limit'

/**
 * A fake that models the contract of the consume_rate_limit RPC: fixed windows keyed on (bucket, floor(now / window)), and a
 * single atomic read-modify-write, like INSERT ... ON CONFLICT DO UPDATE.
 *
 * The `await` before the counter is touched simulates the network round trip.
 * The counter mutation itself is synchronous, which is what makes it atomic:
 * no other pending call can interleave between reading and writing. That is
 * exactly the property the SQL statement has and the old in-memory limiter's
 * filter/push/set sequence did not.
 */
function atomicStore(clock: { now: number }) {
  const rows = new Map<string, { windowStart: number; hits: number }>()

  const key = (bucket: string, windowSeconds: number) => {
    const windowStart = Math.floor(clock.now / (windowSeconds * 1000)) * (windowSeconds * 1000)
    return { rowKey: `${bucket}@${windowStart}`, windowStart }
  }

  const store: RateLimitStore & { rowCount: () => number } = {
    rowCount: () => rows.size,
    async rpc(fn, args) {
      const bucket = args.p_bucket as string
      const limit = args.p_limit as number
      const windowSeconds = args.p_window_seconds as number
      // Round trip. Everything after this point runs without interleaving.
      await Promise.resolve()
      const { rowKey, windowStart } = key(bucket, windowSeconds)
      const existing = rows.get(rowKey)

      let hits: number
      if (fn === 'peek_rate_limit') {
        hits = existing?.hits ?? 0
      } else {
        hits = (existing?.hits ?? 0) + 1
        rows.set(rowKey, { windowStart, hits })
      }

      const allowed = fn === 'peek_rate_limit' ? hits < limit : hits <= limit
      const windowEnd = windowStart + windowSeconds * 1000
      return {
        data: [
          {
            allowed,
            remaining: Math.max(limit - hits, 0),
            retry_after_seconds: Math.max(Math.ceil((windowEnd - clock.now) / 1000), 1),
          },
        ],
        error: null,
      }
    },
  }
  return store
}

/** A store that reads, yields, then writes: the race the RPC exists to avoid. */
function racyStore() {
  const rows = new Map<string, number>()
  const store: RateLimitStore = {
    async rpc(_fn, args) {
      const bucket = args.p_bucket as string
      const limit = args.p_limit as number
      const hits = rows.get(bucket) ?? 0
      await Promise.resolve()
      await Promise.resolve()
      const next = hits + 1
      rows.set(bucket, next)
      return {
        data: [{ allowed: next <= limit, remaining: Math.max(limit - next, 0), retry_after_seconds: 60 }],
        error: null,
      }
    },
  }
  return store
}

const POLICY = { limit: 3, windowMs: 60_000 }

/** Installs one shared fake store (a single factory instance, as in production). */
function useAtomicStore() {
  const clock = { now: 1_700_000_000_000 }
  const store = atomicStore(clock)
  _setRateLimitStore(() => store)
  return { clock, store }
}

afterEach(() => {
  _setRateLimitStore(null)
  vi.restoreAllMocks()
})

describe('rateLimitKey', () => {
  it('is deterministic', () => {
    expect(rateLimitKey('auth', 'a@b.com')).toBe(rateLimitKey('auth', 'a@b.com'))
  })

  it('does not leak the identifier into the stored key', () => {
    const key = rateLimitKey('auth', 'victim@example.com')
    expect(key.startsWith('auth:')).toBe(true)
    expect(key).not.toContain('victim@example.com')
  })

  it('produces a bounded key regardless of identifier length', () => {
    const key = rateLimitKey('auth', 'x'.repeat(10_000))
    expect(key.length).toBeLessThanOrEqual(200)
  })

  it('separates namespaces', () => {
    expect(rateLimitKey('auth', 'same')).not.toBe(rateLimitKey('support', 'same'))
  })
})

describe('clientIpFrom', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('prefers the header Vercel sets over anything the client sent', () => {
    vi.stubEnv('VERCEL', '1')
    const headers = new Headers({
      'x-vercel-forwarded-for': '9.9.9.9',
      'x-forwarded-for': '1.2.3.4, 9.9.9.9',
      'x-real-ip': '8.8.8.8',
    })
    expect(clientIpFrom(headers)).toBe('9.9.9.9')
  })

  it('ignores the platform headers off the platform that sets them', () => {
    // Off Vercel. Nothing in front of the app writes x-vercel-forwarded-for or
    // necessarily overwrites x-real-ip, so believing either hands the caller a
    // private rate-limit bucket per forged value, i.e. no limit at all.
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('VERCEL_ENV', '')
    const headers = new Headers({
      'x-vercel-forwarded-for': '203.0.113.7',
      'x-real-ip': '203.0.113.8',
      'x-forwarded-for': '1.2.3.4, 198.51.100.9',
    })
    expect(clientIpFrom(headers)).toBe('198.51.100.9')
  })

  it('shares one bucket when an install has no proxy header at all', () => {
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('VERCEL_ENV', '')
    const forged = new Headers({ 'x-vercel-forwarded-for': '203.0.113.7' })
    const other = new Headers({ 'x-real-ip': '203.0.113.8' })
    expect(clientIpFrom(forged)).toBeNull()
    expect(clientIpFrom(other)).toBeNull()
    expect(ipKey('probe', clientIpFrom(forged))).toBe(ipKey('probe', clientIpFrom(other)))
  })

  it('lets the operator name the header their own proxy overwrites', () => {
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('VERCEL_ENV', '')
    vi.stubEnv('BILLR_TRUSTED_IP_HEADER', 'X-Real-IP')
    const headers = new Headers({
      'x-real-ip': '203.0.113.8',
      'x-forwarded-for': '1.2.3.4, 198.51.100.9',
    })
    expect(clientIpFrom(headers)).toBe('203.0.113.8')
  })

  it('never takes the spoofable first x-forwarded-for entry', () => {
    // An attacker sends `x-forwarded-for: 1.2.3.4`; the proxy appends the real
    // peer. Keying on the first entry would hand out a fresh allowance per
    // forged value.
    const headers = new Headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' })
    expect(clientIpFrom(headers)).toBe('203.0.113.7')
  })

  it('falls back to x-forwarded-for when the platform header is absent', () => {
    vi.stubEnv('VERCEL', '1')
    expect(clientIpFrom(new Headers({ 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9')
  })

  it('returns null when there is nothing to go on', () => {
    expect(clientIpFrom(new Headers())).toBeNull()
  })

  it('rejects a junk or oversized header value', () => {
    vi.stubEnv('VERCEL', '1')
    expect(clientIpFrom(new Headers({ 'x-vercel-forwarded-for': 'not-an-ip' }))).toBeNull()
    expect(clientIpFrom(new Headers({ 'x-vercel-forwarded-for': '1'.repeat(100) }))).toBeNull()
  })

  it('handles ipv6', () => {
    vi.stubEnv('VERCEL', '1')
    expect(clientIpFrom(new Headers({ 'x-vercel-forwarded-for': '2001:db8::1' }))).toBe('2001:db8::1')
  })
})

describe('ipKey', () => {
  it('puts unidentifiable callers in one shared bucket rather than waving them through', () => {
    expect(ipKey('ns', null)).toBe(ipKey('ns', null))
    expect(ipKey('ns', null)).not.toBe(ipKey('ns', '1.2.3.4'))
  })
})

describe('consumeRateLimit', () => {
  beforeEach(() => {
    useAtomicStore()
  })

  it('allows up to the limit and then denies', async () => {
    expect((await consumeRateLimit('b', POLICY)).allowed).toBe(true)
    expect((await consumeRateLimit('b', POLICY)).allowed).toBe(true)
    const third = await consumeRateLimit('b', POLICY)
    expect(third.allowed).toBe(true)
    expect(third.remaining).toBe(0)
    expect((await consumeRateLimit('b', POLICY)).allowed).toBe(false)
  })

  it('keeps a tripped bucket tripped: blocked requests still count', async () => {
    for (let i = 0; i < 10; i += 1) await consumeRateLimit('b', POLICY)
    // Backing off for one request must not restore any allowance.
    expect((await consumeRateLimit('b', POLICY)).allowed).toBe(false)
  })

  it('rolls over at the window boundary', async () => {
    const { clock } = useAtomicStore()

    for (let i = 0; i < 4; i += 1) await consumeRateLimit('b', POLICY)
    expect((await consumeRateLimit('b', POLICY)).allowed).toBe(false)

    clock.now += 60_000
    expect((await consumeRateLimit('b', POLICY)).allowed).toBe(true)
  })

  it('keeps buckets independent', async () => {
    for (let i = 0; i < 4; i += 1) await consumeRateLimit('one', POLICY)
    expect((await consumeRateLimit('two', POLICY)).allowed).toBe(true)
  })

  it('reports a retry-after within the window', async () => {
    const result = await consumeRateLimit('b', POLICY)
    expect(result.retryAfterSeconds).toBeGreaterThan(0)
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(60)
  })
})

describe('atomicity under concurrency', () => {
  it('admits exactly the limit when 200 requests race the same bucket', async () => {
    useAtomicStore()

    const results = await Promise.all(
      Array.from({ length: 200 }, () => consumeRateLimit('hot', { limit: 5, windowMs: 60_000 }))
    )
    expect(results.filter((r) => r.allowed).length).toBe(5)
  })

  it('a read-then-write store over-admits, which is why the counter is one statement', async () => {
    // Documents the failure mode the SQL counter avoids. If someone ever
    // rewrites consume_rate_limit as SELECT-then-UPDATE, this is what happens.
    _setRateLimitStore(() => racyStore())

    const results = await Promise.all(
      Array.from({ length: 200 }, () => consumeRateLimit('hot', { limit: 5, windowMs: 60_000 }))
    )
    expect(results.filter((r) => r.allowed).length).toBeGreaterThan(5)
  })
})

describe('fail closed', () => {
  it('denies when the store returns an error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    _setRateLimitStore(() => ({
      rpc: async () => ({ data: null, error: { message: 'connection refused' } }),
    }))

    const result = await consumeRateLimit('b', POLICY)
    expect(result.allowed).toBe(false)
    expect(result.degraded).toBe(true)
  })

  it('denies when the store throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    _setRateLimitStore(() => ({
      rpc: async () => {
        throw new Error('socket hang up')
      },
    }))

    const result = await consumeRateLimit('b', POLICY)
    expect(result.allowed).toBe(false)
    expect(result.degraded).toBe(true)
  })

  it('denies when the store answers with an unexpected shape', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    _setRateLimitStore(() => ({ rpc: async () => ({ data: { nope: true }, error: null }) }))

    const result = await consumeRateLimit('b', POLICY)
    expect(result.allowed).toBe(false)
    expect(result.degraded).toBe(true)
  })

  it('allows only when a call site has explicitly opted into failing open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    _setRateLimitStore(() => ({
      rpc: async () => ({ data: null, error: { message: 'down' } }),
    }))

    const result = await consumeRateLimit('b', { ...POLICY, onStoreFailure: 'allow' })
    expect(result.allowed).toBe(true)
    expect(result.degraded).toBe(true)
  })

  it('every shipped policy fails closed', () => {
    for (const [name, policy] of Object.entries(RATE_LIMITS)) {
      expect(policy.onStoreFailure ?? 'deny', `${name} must fail closed`).toBe('deny')
    }
  })

  it('peek fails closed too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    _setRateLimitStore(() => ({
      rpc: async () => ({ data: null, error: { message: 'down' } }),
    }))

    const result = await peekRateLimit('b', POLICY)
    expect(result.allowed).toBe(false)
  })
})

describe('peekRateLimit', () => {
  it('does not spend allowance', async () => {
    useAtomicStore()

    for (let i = 0; i < 20; i += 1) await peekRateLimit('b', POLICY)
    expect((await consumeRateLimit('b', POLICY)).allowed).toBe(true)
  })

  it('reports a standing block without deepening it', async () => {
    useAtomicStore()

    for (let i = 0; i < 3; i += 1) await consumeRateLimit('b', POLICY)
    expect((await peekRateLimit('b', POLICY)).allowed).toBe(false)
  })
})

describe('consumeRateLimits (layered)', () => {
  it('spends every layer even when one already denies', async () => {
    useAtomicStore()

    // Exhaust the per-identifier layer.
    for (let i = 0; i < 5; i += 1) await consumeRateLimit('id', { limit: 2, windowMs: 60_000 })

    // Two layered attempts. Both are denied by the id layer, but the ip layer
    // must still have been charged twice, otherwise rotating the identifier
    // would cost an attacker nothing.
    await consumeRateLimits([
      { bucket: 'id', policy: { limit: 2, windowMs: 60_000 } },
      { bucket: 'ip', policy: { limit: 3, windowMs: 60_000 } },
    ])
    await consumeRateLimits([
      { bucket: 'id', policy: { limit: 2, windowMs: 60_000 } },
      { bucket: 'ip', policy: { limit: 3, windowMs: 60_000 } },
    ])

    const ipOnly = await consumeRateLimit('ip', { limit: 3, windowMs: 60_000 })
    expect(ipOnly.allowed).toBe(true)
    expect(ipOnly.remaining).toBe(0)
  })

  it('denies when any single layer denies', async () => {
    useAtomicStore()

    for (let i = 0; i < 3; i += 1) await consumeRateLimit('ip', { limit: 2, windowMs: 60_000 })

    const result = await consumeRateLimits([
      { bucket: 'id', policy: { limit: 100, windowMs: 60_000 } },
      { bucket: 'ip', policy: { limit: 2, windowMs: 60_000 } },
    ])
    expect(result.allowed).toBe(false)
    expect(result.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('is a no-op for an empty check list', async () => {
    useAtomicStore()
    expect((await consumeRateLimits([])).allowed).toBe(true)
  })
})
