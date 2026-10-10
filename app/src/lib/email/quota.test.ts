import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { _setRateLimitStore } from '@/lib/rate-limit'
import {
  EmailQuotaError,
  consumeEmailQuota,
  emailDailyLimit,
  emailQuotaBucket,
} from './quota'

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

/** Records what the limiter was asked for, and answers with a fixed allowance. */
function fakeStore(limitHit = false) {
  const calls: Record<string, unknown>[] = []
  _setRateLimitStore(() => ({
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      calls.push(args)
      return {
        data: [{ allowed: !limitHit, remaining: 0, retry_after_seconds: 7 * 3600 + 100 }],
        error: null,
      }
    },
  }))
  return calls
}

const ORIGINAL = {
  BILLR_EMAIL_DAILY_LIMIT: process.env.BILLR_EMAIL_DAILY_LIMIT,
}

beforeEach(() => setEnv({ ...ORIGINAL, BILLR_EMAIL_DAILY_LIMIT: undefined }))
afterEach(() => {
  _setRateLimitStore(null)
  setEnv(ORIGINAL)
})

describe('emailDailyLimit', () => {
  it('applies no cap when BILLR_EMAIL_DAILY_LIMIT is unset', () => {
    expect(emailDailyLimit({} as NodeJS.ProcessEnv)).toBeNull()
  })

  it('honours the env override', () => {
    setEnv({ BILLR_EMAIL_DAILY_LIMIT: '25' })
    expect(emailDailyLimit()).toBe(25)
  })

  it('ignores a value that would silently switch email off', () => {
    for (const bad of ['0', '-5', 'abc', '2.5', '   ']) {
      setEnv({ BILLR_EMAIL_DAILY_LIMIT: bad })
      expect(emailDailyLimit()).toBeNull()
    }
  })
})

describe('consumeEmailQuota', () => {
  it('spends one send per business per day when a cap is set', async () => {
    setEnv({ BILLR_EMAIL_DAILY_LIMIT: '200' })
    const calls = fakeStore()
    await consumeEmailQuota('business-1')
    expect(calls).toEqual([
      {
        p_bucket: emailQuotaBucket('business-1'),
        p_limit: 200,
        p_window_seconds: 86400,
        p_cost: 1,
      },
    ])
  })

  it('keeps each business on its own allowance', async () => {
    setEnv({ BILLR_EMAIL_DAILY_LIMIT: '200' })
    const calls = fakeStore()
    await consumeEmailQuota('business-1')
    await consumeEmailQuota('business-2')
    expect(calls[0].p_bucket).not.toBe(calls[1].p_bucket)
  })

  it('does not even reach the limiter when no cap is set', async () => {
    const calls = fakeStore()
    await consumeEmailQuota('business-1')
    expect(calls).toEqual([])
  })

  it('explains the wait instead of failing generically', async () => {
    setEnv({ BILLR_EMAIL_DAILY_LIMIT: '200' })
    fakeStore(true)
    await expect(consumeEmailQuota('business-1')).rejects.toThrow(
      'Daily email limit reached for this business, resets in about 7 hours'
    )
    await expect(consumeEmailQuota('business-1')).rejects.toBeInstanceOf(EmailQuotaError)
  })

  it('fails closed when the limiter store is unreachable', async () => {
    setEnv({ BILLR_EMAIL_DAILY_LIMIT: '200' })
    _setRateLimitStore(() => ({
      rpc: async () => ({ data: null, error: { message: 'database unavailable' } }),
    }))
    await expect(consumeEmailQuota('business-1')).rejects.toBeInstanceOf(EmailQuotaError)
  })
})
