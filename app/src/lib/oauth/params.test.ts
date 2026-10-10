import { describe, expect, it } from 'vitest'
import {
  buildRedirect,
  challengeFromVerifier,
  generateSecret,
  isAllowedRedirectUri,
  isValidCodeChallenge,
  isValidCodeVerifier,
  matchesRegisteredRedirect,
  normaliseClientName,
  resourceMatches,
  validateRedirectUris,
  verifyPkce,
} from './params'

describe('redirect URI rules', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'https://example.org/cb?x=1',
    'http://localhost:33418/callback',
    'http://127.0.0.1:8976/oauth',
    'http://localhost/cb',
    // RFC 8252 s7.3: the IPv6 loopback literal, which an IPv6-only machine is
    // the only address a native client can bind.
    'http://[::1]:33418/callback',
    'http://[::1]/cb',
  ])('accepts %s', (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(true)
  })

  it('accepts an IPv6 loopback redirect through registration too', () => {
    const result = validateRedirectUris([
      'http://[::1]:33418/callback',
      'http://127.0.0.1:33418/callback',
    ])
    expect(result.ok).toBe(true)
    expect(result.uris).toHaveLength(2)
  })

  it.each([
    // Only the loopback address itself. ::2 and the IPv4-mapped form are
    // routable or ambiguous, and neither is what RFC 8252 asks for.
    'http://[::2]/cb',
    'http://[::ffff:127.0.0.1]/cb',
    'http://[2001:db8::1]/cb',
  ])('rejects the non-loopback IPv6 literal %s', (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(false)
  })

  it.each([
    'http://example.org/cb',
    'http://localhost.evil.com/cb',
    'ftp://example.org/cb',
    'cursor://anysphere.cursor-deeplink/mcp/callback',
    'https://example.org/cb#frag',
    'https://user:pass@example.org/cb',
    'not a url',
    '',
  ])('rejects %s', (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(false)
  })

  it('requires a non-empty, bounded array at registration', () => {
    expect(validateRedirectUris(['https://a.example/cb']).ok).toBe(true)
    expect(validateRedirectUris([]).ok).toBe(false)
    expect(validateRedirectUris('https://a.example/cb').ok).toBe(false)
    expect(validateRedirectUris(undefined).ok).toBe(false)
    expect(validateRedirectUris(Array(11).fill('https://a.example/cb')).ok).toBe(false)
  })

  it('rejects the whole registration when any entry is disallowed', () => {
    const result = validateRedirectUris(['https://a.example/cb', 'http://evil.example/cb'])
    expect(result.ok).toBe(false)
    expect(result.uris).toEqual([])
  })

  it('de-duplicates', () => {
    const result = validateRedirectUris(['https://a.example/cb', 'https://a.example/cb'])
    expect(result.uris).toEqual(['https://a.example/cb'])
  })

  it('matches registered URIs exactly, never by prefix', () => {
    const registered = ['https://a.example/cb']
    expect(matchesRegisteredRedirect('https://a.example/cb', registered)).toBe(true)
    expect(matchesRegisteredRedirect('https://a.example/cb/../evil', registered)).toBe(false)
    expect(matchesRegisteredRedirect('https://a.example/cb?x=1', registered)).toBe(false)
    expect(matchesRegisteredRedirect('https://a.example', registered)).toBe(false)
  })
})

describe('client name', () => {
  it('falls back, strips control characters and caps length', () => {
    expect(normaliseClientName(undefined)).toBe('MCP client')
    expect(normaliseClientName('   ')).toBe('MCP client')
    expect(normaliseClientName('Claude\nCode')).toBe('Claude Code')
    expect(normaliseClientName('x'.repeat(500))).toHaveLength(200)
  })
})

describe('PKCE', () => {
  it('accepts a verifier that hashes to the stored challenge', () => {
    const verifier = generateSecret(48)
    expect(isValidCodeVerifier(verifier)).toBe(true)
    const challenge = challengeFromVerifier(verifier)
    expect(isValidCodeChallenge(challenge)).toBe(true)
    expect(verifyPkce(verifier, challenge)).toBe(true)
  })

  it('rejects the wrong verifier, a malformed one, and a missing one', () => {
    const challenge = challengeFromVerifier(generateSecret(48))
    expect(verifyPkce(generateSecret(48), challenge)).toBe(false)
    expect(verifyPkce('short', challenge)).toBe(false)
    expect(verifyPkce(undefined, challenge)).toBe(false)
  })

  it('rejects a challenge that is not a base64url SHA-256 digest', () => {
    expect(isValidCodeChallenge('plain-challenge')).toBe(false)
    expect(isValidCodeChallenge('a'.repeat(42))).toBe(false)
    expect(isValidCodeChallenge('a/b+c'.padEnd(43, 'a'))).toBe(false)
  })
})

describe('resource indicator', () => {
  const resource = 'https://mcp.example.org'
  it('is optional', () => {
    expect(resourceMatches(undefined, resource)).toBe(true)
    expect(resourceMatches(null, resource)).toBe(true)
  })
  it('accepts this installation with or without a trailing slash', () => {
    expect(resourceMatches('https://mcp.example.org', resource)).toBe(true)
    expect(resourceMatches('https://mcp.example.org/', resource)).toBe(true)
  })
  it('rejects another audience', () => {
    expect(resourceMatches('https://evil.example', resource)).toBe(false)
    expect(resourceMatches('https://mcp.example.org/other', resource)).toBe(false)
    expect(resourceMatches('nonsense', resource)).toBe(false)
  })
  it('matches a path-bearing resource', () => {
    expect(resourceMatches('https://x.example/api/mcp/', 'https://x.example/api/mcp')).toBe(true)
    expect(resourceMatches('https://x.example/api', 'https://x.example/api/mcp')).toBe(false)
  })
})

describe('redirect building', () => {
  it('preserves the client query and drops empty values', () => {
    const url = buildRedirect('https://a.example/cb?keep=1', {
      code: 'abc',
      state: '',
      iss: 'https://invoices.example.org',
    })
    expect(url).toBe('https://a.example/cb?keep=1&code=abc&iss=https%3A%2F%2Finvoices.example.org')
  })
})
