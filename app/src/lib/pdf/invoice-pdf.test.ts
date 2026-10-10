import { afterEach, describe, it, expect, vi } from 'vitest'

// A public address, so the SSRF deny list is not what refuses anything below:
// the origin pin is. Without the mock a made-up host simply fails to resolve
// and the test would pass for the wrong reason.
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}))

import { fetchLogo, isBlockedLogoAddress } from './invoice-pdf'

describe('isBlockedLogoAddress (SSRF guard)', () => {
  it('allows public IPv4 addresses', () => {
    expect(isBlockedLogoAddress('8.8.8.8')).toBe(false)
    expect(isBlockedLogoAddress('1.1.1.1')).toBe(false)
    expect(isBlockedLogoAddress('93.184.216.34')).toBe(false)
  })

  it('allows public IPv6 addresses', () => {
    expect(isBlockedLogoAddress('2606:4700:4700::1111')).toBe(false)
  })

  it('rejects loopback 127/8', () => {
    expect(isBlockedLogoAddress('127.0.0.1')).toBe(true)
    expect(isBlockedLogoAddress('127.1.2.3')).toBe(true)
  })

  it('rejects private 10/8', () => {
    expect(isBlockedLogoAddress('10.0.0.1')).toBe(true)
    expect(isBlockedLogoAddress('10.255.255.255')).toBe(true)
  })

  it('rejects private 172.16/12', () => {
    expect(isBlockedLogoAddress('172.16.0.1')).toBe(true)
    expect(isBlockedLogoAddress('172.31.255.255')).toBe(true)
    // just outside the range stays allowed
    expect(isBlockedLogoAddress('172.15.0.1')).toBe(false)
    expect(isBlockedLogoAddress('172.32.0.1')).toBe(false)
  })

  it('rejects private 192.168/16', () => {
    expect(isBlockedLogoAddress('192.168.0.1')).toBe(true)
    expect(isBlockedLogoAddress('192.168.1.100')).toBe(true)
  })

  it('rejects link-local / cloud metadata 169.254/16', () => {
    expect(isBlockedLogoAddress('169.254.169.254')).toBe(true)
  })

  it('rejects 0.0.0.0', () => {
    expect(isBlockedLogoAddress('0.0.0.0')).toBe(true)
  })

  it('rejects IPv6 loopback and unique-local/link-local', () => {
    expect(isBlockedLogoAddress('::1')).toBe(true)
    expect(isBlockedLogoAddress('fc00::1')).toBe(true)
    expect(isBlockedLogoAddress('fd12:3456::1')).toBe(true)
    expect(isBlockedLogoAddress('fe80::1')).toBe(true)
  })

  it('rejects IPv4-mapped IPv6 loopback', () => {
    expect(isBlockedLogoAddress('::ffff:127.0.0.1')).toBe(true)
  })
})

/**
 * The public PDF route reaches fetchLogo with no session at all,
 * and the URL comes from businesses.logo_url. Anything that is not this
 * installation's own storage origin must be refused before a single packet
 * leaves the server, so the route cannot be used to fetch an arbitrary host.
 */
describe('fetchLogo origin pinning', () => {
  const SUPABASE = 'https://example-install.supabase.co'
  const good = `${SUPABASE}/storage/v1/object/public/logos/b1/logo.png`

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  function stubFetch() {
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it.each([
    'https://evil.example/logo.png',
    'https://example-install.supabase.co.evil.example/logo.png',
    'https://example-install.supabase.co/rest/v1/businesses?select=*',
    'http://169.254.169.254/latest/meta-data/',
    'javascript:alert(1)',
  ])('never fetches %s', async (url) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
    const fetchMock = stubFetch()

    expect(await fetchLogo(url)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches a logo on this installation storage origin', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE)
    const fetchMock = stubFetch()

    const logo = await fetchLogo(good)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(logo?.format).toBe('png')
  })

  it('refuses everything when no Supabase URL is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    const fetchMock = stubFetch()

    expect(await fetchLogo(good)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
