import 'server-only'

/**
 * Card payments run on this installation's own Stripe account, configured
 * entirely from three environment variables. Nothing about Stripe lives in
 * the database, and one account serves every business on the install.
 */
const STRIPE_ENV_KEYS = [
  'STRIPE_SECRET_KEY',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
] as const

type StripeEnvKey = (typeof STRIPE_ENV_KEYS)[number]
type StripeMode = 'test' | 'live'
export type StripeSetup =
  | { configured: true; mode: StripeMode }
  | { configured: false; missing: StripeEnvKey[]; problem: string | null }

type StripeEnv = Partial<Record<StripeEnvKey, string | undefined>>

function readStripeEnv(): StripeEnv {
  // Named one by one: Next.js only inlines NEXT_PUBLIC_ values it can see.
  return {
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  }
}

function keyMode(value: string, prefixes: string[]): StripeMode | null {
  for (const prefix of prefixes) {
    if (value.startsWith(`${prefix}_test_`)) return 'test'
    if (value.startsWith(`${prefix}_live_`)) return 'live'
  }
  return null
}

function off(problem: string): StripeSetup {
  return { configured: false, missing: [], problem }
}

/** Whether card payments are on, and if not, exactly why. Never returns a key. */
export function stripeSetup(env: StripeEnv = readStripeEnv()): StripeSetup {
  const value = (key: StripeEnvKey) => env[key]?.trim() ?? ''
  const missing = STRIPE_ENV_KEYS.filter((key) => !value(key))
  if (missing.length) return { configured: false, missing, problem: null }

  const secretMode = keyMode(value('STRIPE_SECRET_KEY'), ['sk', 'rk'])
  if (!secretMode)
    return off('STRIPE_SECRET_KEY must start with sk_test_, sk_live_, rk_test_ or rk_live_.')
  const publishableMode = keyMode(value('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY'), ['pk'])
  if (!publishableMode)
    return off('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY must start with pk_test_ or pk_live_.')
  if (secretMode !== publishableMode)
    return off(
      'The secret key and the publishable key are from different modes (one test, one live). Use a matching pair.',
    )
  if (!value('STRIPE_WEBHOOK_SECRET').startsWith('whsec_'))
    return off('STRIPE_WEBHOOK_SECRET must start with whsec_ (the endpoint signing secret).')
  return { configured: true, mode: secretMode }
}

export function stripePaymentsConfigured(env?: StripeEnv): boolean {
  return stripeSetup(env).configured
}
