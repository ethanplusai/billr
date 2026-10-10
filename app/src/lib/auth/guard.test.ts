import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const headerStore = { value: new Headers() }

vi.mock('next/headers', () => ({
  headers: async () => headerStore.value,
}))

import { _setRateLimitStore, type RateLimitStore } from '@/lib/rate-limit'
import { guardAuthAttempt, recordAuthFailure } from './guard'

/** Same contract as the consume_rate_limit / peek_rate_limit RPCs. */
function fakeStore() {
  const rows = new Map<string, number>()
  const store: RateLimitStore & { hitsFor: (prefix: string) => number } = {
    hitsFor(prefix) {
      let total = 0
      for (const [k, v] of rows) if (k.startsWith(prefix)) total += v
      return total
    },
    async rpc(fn, args) {
      const bucket = args.p_bucket as string
      const limit = args.p_limit as number
      await Promise.resolve()
      let hits: number
      if (fn === 'peek_rate_limit') {
        hits = rows.get(bucket) ?? 0
      } else {
        hits = (rows.get(bucket) ?? 0) + 1
        rows.set(bucket, hits)
      }
      return {
        data: [
          {
            allowed: fn === 'peek_rate_limit' ? hits < limit : hits <= limit,
            remaining: Math.max(limit - hits, 0),
            retry_after_seconds: 900,
          },
        ],
        error: null,
      }
    },
  }
  return store
}

let store: ReturnType<typeof fakeStore>

beforeEach(() => {
  store = fakeStore()
  _setRateLimitStore(() => store)
  // clientIpFrom only believes x-vercel-forwarded-for when it is actually
  // running on Vercel, which is the platform that overwrites it. These cases
  // run behind Vercel's edge, so say so.
  vi.stubEnv('VERCEL', '1')
  headerStore.value = new Headers({ 'x-vercel-forwarded-for': '203.0.113.5' })
})

afterEach(() => {
  _setRateLimitStore(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('guardAuthAttempt', () => {
  it('passes a first attempt and reports the resolved IP', async () => {
    const result = await guardAuthAttempt('signin', 'user@example.com')
    expect(result.blocked).toBe(false)
    if (!result.blocked) expect(result.ip).toBe('203.0.113.5')
  })

  it('treats an identifier case-insensitively', async () => {
    for (let i = 0; i < 10; i += 1) await guardAuthAttempt('signin', 'user@example.com')
    // The 11th attempt on the same account, spelled differently, must still be
    // the 11th attempt.
    const result = await guardAuthAttempt('signin', 'USER@Example.COM')
    expect(result.blocked).toBe(true)
  })

  it('caps attempts per IP so rotating the email address buys nothing', async () => {
    // Each attempt uses a fresh address, so the per-identifier bucket is never
    // near its limit. The per-IP bucket (30 / 15 min) must still stop it.
    let blockedAt = -1
    for (let i = 0; i < 40; i += 1) {
      const result = await guardAuthAttempt('signin', `throwaway-${i}@example.com`)
      if (result.blocked && blockedAt === -1) blockedAt = i
    }
    expect(blockedAt).toBe(30)
  })

  it('does not let one IP exhaust another IP', async () => {
    for (let i = 0; i < 40; i += 1) await guardAuthAttempt('signin', `a-${i}@example.com`)
    headerStore.value = new Headers({ 'x-vercel-forwarded-for': '198.51.100.9' })
    const result = await guardAuthAttempt('signin', 'fresh@example.com')
    expect(result.blocked).toBe(false)
  })

  it('locks the account out after enough recorded failures', async () => {
    // 8 failures / hour on the identifier bucket.
    for (let i = 0; i < 8; i += 1) await recordAuthFailure('victim@example.com', '203.0.113.5')

    const result = await guardAuthAttempt('signin', 'victim@example.com')
    expect(result.blocked).toBe(true)
    if (result.blocked) expect(result.message).toContain('failed attempts')
  })

  it('checks a standing lockout without deepening it', async () => {
    for (let i = 0; i < 8; i += 1) await recordAuthFailure('victim@example.com', '203.0.113.5')
    const before = store.hitsFor('authfail:id')

    for (let i = 0; i < 5; i += 1) await guardAuthAttempt('signin', 'victim@example.com')

    // peek, not consume: a locked-out caller banging on the door must not be
    // able to extend their own lockout indefinitely.
    expect(store.hitsFor('authfail:id')).toBe(before)
  })

  it('keeps sign-in, sign-up and reset attempt buckets separate per identifier', async () => {
    for (let i = 0; i < 10; i += 1) await guardAuthAttempt('signin', 'user@example.com')
    expect((await guardAuthAttempt('signin', 'user@example.com')).blocked).toBe(true)
    // Different action, same address: still allowed by the identifier bucket
    // (the shared per-IP bucket is the layer that spans actions).
    expect((await guardAuthAttempt('reset', 'user@example.com')).blocked).toBe(false)
  })

  it('fails closed when the counter store is unreachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    _setRateLimitStore(() => ({
      rpc: async () => ({ data: null, error: { message: 'connection refused' } }),
    }))

    const result = await guardAuthAttempt('signin', 'user@example.com')
    expect(result.blocked).toBe(true)
  })

  it('still applies a limit when no IP can be resolved', async () => {
    headerStore.value = new Headers()
    let blocked = false
    for (let i = 0; i < 40; i += 1) {
      const result = await guardAuthAttempt('signin', `nope-${i}@example.com`)
      if (result.blocked) blocked = true
    }
    expect(blocked).toBe(true)
  })
})
