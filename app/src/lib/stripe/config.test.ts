import { afterEach, describe, expect, it, vi } from 'vitest'
import { stripePaymentsConfigured, stripeSetup } from './config'

const TEST = {
  STRIPE_SECRET_KEY: 'sk_test_example',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_example',
  STRIPE_WEBHOOK_SECRET: 'whsec_example',
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('stripeSetup', () => {
  it('is configured in test mode with a matching test pair and a webhook secret', () => {
    expect(stripeSetup(TEST)).toEqual({ configured: true, mode: 'test' })
  })

  it('is configured in live mode with a matching live pair', () => {
    expect(
      stripeSetup({
        STRIPE_SECRET_KEY: 'sk_live_example',
        NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_example',
        STRIPE_WEBHOOK_SECRET: 'whsec_example',
      }),
    ).toEqual({ configured: true, mode: 'live' })
  })

  it('accepts a restricted secret key', () => {
    expect(stripeSetup({ ...TEST, STRIPE_SECRET_KEY: 'rk_test_example' })).toEqual({
      configured: true,
      mode: 'test',
    })
  })

  it('names every missing variable', () => {
    expect(stripeSetup({})).toEqual({
      configured: false,
      missing: ['STRIPE_SECRET_KEY', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET'],
      problem: null,
    })
  })

  it('treats a value of only spaces as missing', () => {
    expect(stripeSetup({ ...TEST, STRIPE_WEBHOOK_SECRET: '   ' })).toEqual({
      configured: false,
      missing: ['STRIPE_WEBHOOK_SECRET'],
      problem: null,
    })
  })

  it('refuses a test secret key with a live publishable key', () => {
    expect(stripeSetup({ ...TEST, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_example' })).toMatchObject({
      configured: false,
      missing: [],
      problem: expect.stringMatching(/different modes/),
    })
  })

  it('refuses a publishable key pasted into the secret key slot', () => {
    expect(stripeSetup({ ...TEST, STRIPE_SECRET_KEY: 'pk_test_example' })).toMatchObject({
      configured: false,
      problem: expect.stringMatching(/STRIPE_SECRET_KEY must start with/),
    })
  })

  it('refuses a publishable key with an unknown prefix', () => {
    expect(stripeSetup({ ...TEST, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'test_example' })).toMatchObject({
      configured: false,
      problem: expect.stringMatching(/NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY must start with/),
    })
  })

  it('refuses a webhook secret that is not a signing secret', () => {
    expect(stripeSetup({ ...TEST, STRIPE_WEBHOOK_SECRET: 'sk_test_example' })).toMatchObject({
      configured: false,
      problem: expect.stringMatching(/whsec_/),
    })
  })

  it('reads the process environment by default', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', TEST.STRIPE_SECRET_KEY)
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', TEST.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', TEST.STRIPE_WEBHOOK_SECRET)
    expect(stripePaymentsConfigured()).toBe(true)
  })
})

describe('stripePaymentsConfigured', () => {
  it('answers yes or no for callers that need nothing more', () => {
    expect(stripePaymentsConfigured(TEST)).toBe(true)
    expect(stripePaymentsConfigured({})).toBe(false)
  })
})
