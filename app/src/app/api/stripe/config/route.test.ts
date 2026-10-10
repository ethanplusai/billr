import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/stripe/config', () => {
  it('says card payment is available when all three keys are set and consistent', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_example')
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_example')
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_example')
    const response = await GET()
    expect(await response.json()).toEqual({ available: true })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('says it is unavailable, and nothing else, when a key is missing', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_example')
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', '')
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '')
    expect(await (await GET()).json()).toEqual({ available: false })
  })
})
