import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from './validate-config.mjs'
const base = {
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55421',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_example',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_example',
}
test('an independent installation needs no Stripe or email credentials', () =>
  assert.equal(validateConfig(base).app, 'http://localhost:3000'))
for (const [name, overrides] of Object.entries({
  'missing database': { NEXT_PUBLIC_SUPABASE_URL: '' },
  'shared keys': { NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_secret_example' },
  'public secret': { NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_secret_another' },
  'public service JWT': {
    NEXT_PUBLIC_SUPABASE_ANON_KEY: `x.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.x`,
  },
  'remote plaintext': { NEXT_PUBLIC_APP_URL: 'http://example.org' },
  'URL credentials': { NEXT_PUBLIC_APP_URL: 'https://user:pass@example.org' },
}))
  test(`rejects ${name}`, () =>
    assert.throws(() => validateConfig({ ...base, ...overrides })))
const stripeTest = {
  STRIPE_SECRET_KEY: 'sk_test_example',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_example',
  STRIPE_WEBHOOK_SECRET: 'whsec_example',
}
test('card payments with a matching test pair are accepted', () =>
  assert.equal(validateConfig({ ...base, ...stripeTest }).app, 'http://localhost:3000'))
for (const [name, overrides, message] of [
  ['a partial Stripe setup', { STRIPE_SECRET_KEY: 'sk_test_example' }, /all three/],
  ['mixed Stripe modes', { ...stripeTest, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_example' }, /different modes/],
  ['a webhook secret that is not one', { ...stripeTest, STRIPE_WEBHOOK_SECRET: 'sk_test_example' }, /whsec_/],
  ['a publishable key in the secret slot', { ...stripeTest, STRIPE_SECRET_KEY: 'pk_test_example' }, /STRIPE_SECRET_KEY must start/],
])
  test(`rejects ${name}`, () => assert.throws(() => validateConfig({ ...base, ...overrides }), message))
for (const value of ['true', 'false', ''])
  test(`accepts BILLR_OPEN_SIGNUP=${value || '(empty)'}`, () =>
    assert.equal(validateConfig({ ...base, BILLR_OPEN_SIGNUP: value }).app, 'http://localhost:3000'))
test('rejects a BILLR_OPEN_SIGNUP value that would silently mean closed', () =>
  assert.throws(() => validateConfig({ ...base, BILLR_OPEN_SIGNUP: 'yes' }), /BILLR_OPEN_SIGNUP/))

test('a container cannot reach a loopback Supabase without an internal URL', () =>
  assert.throws(
    () => validateConfig({ ...base, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:56421', BILLR_CONTAINER: 'true' }),
    /SUPABASE_INTERNAL_URL.*http:\/\/host\.docker\.internal:56421/,
  ))
test('a container treats 0.0.0.0 as loopback too', () =>
  assert.throws(
    () => validateConfig({ ...base, NEXT_PUBLIC_SUPABASE_URL: 'http://0.0.0.0:56421', BILLR_CONTAINER: 'true' }),
    /Inside the container, 0\.0\.0\.0 is the container itself.*http:\/\/host\.docker\.internal:56421/,
  ))
test('a container with an internal URL for the local database is accepted', () =>
  assert.equal(
    validateConfig({
      ...base,
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:56421',
      SUPABASE_INTERNAL_URL: 'http://host.docker.internal:56421',
      BILLR_CONTAINER: 'true',
    }).app,
    'http://localhost:3000',
  ))
test('a container talking to a public Supabase needs no internal URL', () =>
  assert.equal(
    validateConfig({
      ...base,
      NEXT_PUBLIC_APP_URL: 'https://invoices.example.org',
      NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.org',
      BILLR_CONTAINER: 'true',
    }).app,
    'https://invoices.example.org',
  ))
test('outside a container a loopback Supabase needs no internal URL', () =>
  assert.equal(validateConfig({ ...base, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:56421' }).app, 'http://localhost:3000'))
for (const value of ['host.docker.internal:56421', 'http://host.docker.internal:56421/rest', 'ftp://db.example.org'])
  test(`rejects SUPABASE_INTERNAL_URL ${value}`, () =>
    assert.throws(() => validateConfig({ ...base, SUPABASE_INTERNAL_URL: value }), /SUPABASE_INTERNAL_URL must be an HTTP\(S\) origin/))
