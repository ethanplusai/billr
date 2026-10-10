import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_LOGO_URL_LENGTH,
  isAllowedLogoUrl,
  supabaseStorageOrigin,
} from './logo-url'

const SUPABASE = 'https://example-install.supabase.co'
const good = `${SUPABASE}/storage/v1/object/public/logos/b1/logo-1.png`

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isAllowedLogoUrl', () => {
  it('accepts an upload on this installation storage origin', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
    expect(isAllowedLogoUrl(good)).toBe(true)
  })

  it.each([
    // Low-2: zod 4 `z.string().url()` accepts all four of these.
    'javascript:alert(1)',
    'data:image/png;base64,iVBORw0KGgo=',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
  ])('refuses the scheme in %s', (value) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
    expect(isAllowedLogoUrl(value)).toBe(false)
  })

  it.each([
    // Low-3: any of these would be fetched server-side by the public PDF route.
    'https://evil.example/logo.png',
    'https://example-install.supabase.co.evil.example/storage/v1/object/public/logos/b1/x.png',
    'http://example-install.supabase.co/storage/v1/object/public/logos/b1/x.png',
    'https://example-install.supabase.co:8443/storage/v1/object/public/logos/b1/x.png',
    'https://user:pw@example-install.supabase.co/storage/v1/object/public/logos/b1/x.png',
  ])('refuses the origin in %s', (value) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
    expect(isAllowedLogoUrl(value)).toBe(false)
  })

  it.each([
    `${SUPABASE}/storage/v1/object/public/receipts/b1/x.png`,
    `${SUPABASE}/rest/v1/businesses?select=*`,
    `${SUPABASE}/storage/v1/object/public/logos`,
    `${SUPABASE}/`,
  ])('refuses the path in %s', (value) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
    expect(isAllowedLogoUrl(value)).toBe(false)
  })

  it('refuses everything when no Supabase URL is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    expect(isAllowedLogoUrl(good)).toBe(false)
    expect(supabaseStorageOrigin()).toBeNull()
  })

  it('validates against the configured storage origin', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://storage.example.org')
    expect(isAllowedLogoUrl(good)).toBe(false)
    expect(
      isAllowedLogoUrl('https://storage.example.org/storage/v1/object/public/logos/b1/l.png'),
    ).toBe(true)
  })

  it('allows the CLI local stack, which is http on loopback', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:56421')
    expect(
      isAllowedLogoUrl('http://127.0.0.1:56421/storage/v1/object/public/logos/b1/l.png'),
    ).toBe(true)
  })

  it('refuses a non-string, an empty string and an over-long value', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
    expect(isAllowedLogoUrl(undefined)).toBe(false)
    expect(isAllowedLogoUrl('')).toBe(false)
    expect(isAllowedLogoUrl(good + 'x'.repeat(MAX_LOGO_URL_LENGTH))).toBe(false)
  })
})
