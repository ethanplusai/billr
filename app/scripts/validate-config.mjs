import { pathToFileURL } from 'node:url'
import dotenv from 'dotenv'

// Hosts that mean "this machine". Inside a container every one of them is the
// container itself.
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0']

export function validateConfig(env) {
  const required = [
    'NEXT_PUBLIC_APP_URL',
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]
  for (const key of required) {
    if (
      !env[key]?.trim() ||
      /replace-with|your_supabase|your-project/.test(env[key])
    )
      throw Error(`Configure ${key} for your installation`)
  }
  const origin = (value, name) => {
    const url = new URL(value)
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw Error(`${name} must be an HTTP(S) origin`)
    if (
      url.protocol !== 'https:' &&
      !LOOPBACK.includes(url.hostname)
    )
      throw Error(`${name} must use HTTPS outside localhost`)
    return url
  }
  const app = origin(env.NEXT_PUBLIC_APP_URL, 'NEXT_PUBLIC_APP_URL')
  const db = origin(env.NEXT_PUBLIC_SUPABASE_URL, 'NEXT_PUBLIC_SUPABASE_URL')
  // The server-to-server origin may be plain HTTP: it is usually a Docker
  // network name or the host gateway, never something a browser sees.
  const internal = env.SUPABASE_INTERNAL_URL?.trim()
  if (internal) {
    let url
    try {
      url = new URL(internal)
    } catch {
      throw Error('SUPABASE_INTERNAL_URL must be an HTTP(S) origin')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw Error('SUPABASE_INTERNAL_URL must be an HTTP(S) origin')
  }
  if (
    env.BILLR_CONTAINER === 'true' &&
    !internal &&
    LOOPBACK.includes(db.hostname)
  )
    throw Error(
      `Inside the container, ${db.hostname} is the container itself, not your machine. Set SUPABASE_INTERNAL_URL to an address the container can reach; for the local development database that is http://host.docker.internal:${db.port || '80'} (see docs/self-hosting.md)`,
    )
  if (env.NEXT_PUBLIC_SUPABASE_ANON_KEY === env.SUPABASE_SERVICE_ROLE_KEY)
    throw Error('The public and service-role keys must be different')
  const publicKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (publicKey.startsWith('sb_secret_'))
    throw Error('A Supabase secret cannot be used as the browser key')
  if (publicKey.split('.').length === 3) {
    let payload
    try {
      payload = JSON.parse(
        Buffer.from(publicKey.split('.')[1], 'base64url').toString(),
      )
    } catch {
      throw Error('Invalid public Supabase key')
    }
    if (payload.role !== 'anon')
      throw Error('The browser JWT must have the anon role')
  }
  if (
    env.RESEND_API_KEY &&
    !env.RESEND_INVOICE_FROM
  )
    throw Error('Configure your own verified invoice email sender')
  const openSignup = env.BILLR_OPEN_SIGNUP?.trim().toLowerCase()
  if (openSignup && !['true', 'false'].includes(openSignup))
    throw Error('BILLR_OPEN_SIGNUP must be true, false or empty')
  // Card payments: the three Stripe values come as a set, from one mode.
  const stripe = ['STRIPE_SECRET_KEY', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET']
  const stripeSet = stripe.filter((key) => env[key]?.trim())
  if (stripeSet.length && stripeSet.length < stripe.length)
    throw Error(
      `Card payments need all three of ${stripe.join(', ')}; missing ${stripe
        .filter((key) => !env[key]?.trim())
        .join(', ')}`,
    )
  if (stripeSet.length) {
    const mode = (value, prefixes) => {
      for (const prefix of prefixes) {
        if (value.startsWith(`${prefix}_test_`)) return 'test'
        if (value.startsWith(`${prefix}_live_`)) return 'live'
      }
      return null
    }
    const secret = mode(env.STRIPE_SECRET_KEY.trim(), ['sk', 'rk'])
    const publishable = mode(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.trim(), ['pk'])
    if (!secret)
      throw Error('STRIPE_SECRET_KEY must start with sk_test_, sk_live_, rk_test_ or rk_live_')
    if (!publishable)
      throw Error('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY must start with pk_test_ or pk_live_')
    if (secret !== publishable)
      throw Error('The Stripe secret and publishable keys are from different modes (one test, one live)')
    if (!env.STRIPE_WEBHOOK_SECRET.trim().startsWith('whsec_'))
      throw Error('STRIPE_WEBHOOK_SECRET must start with whsec_')
  }
  return { app: app.origin }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  dotenv.config({ path: '.env.local', quiet: true })
  try {
    validateConfig(process.env)
    console.log(
      'Installation configuration validated (no secret values printed).',
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
