import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizationServerMetadata,
  matchesResourceSuffix,
  mcpResourcePath,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
} from './metadata'

afterEach(() => vi.unstubAllEnvs())

function installation() {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://invoices.example.org')
}

describe('protected resource metadata', () => {
  it('describes the resource under the installation origin', () => {
    installation()
    const doc = protectedResourceMetadata()
    expect(doc.resource).toBe('https://invoices.example.org/api/mcp')
    expect(doc.authorization_servers).toEqual(['https://invoices.example.org'])
    expect(doc.scopes_supported).toEqual(['read', 'write', 'send', 'delete', 'payments'])
    expect(doc.bearer_methods_supported).toEqual(['header'])
  })

  it('publishes the metadata in RFC 9728 path-suffix form', () => {
    installation()
    expect(protectedResourceMetadataUrl()).toBe(
      'https://invoices.example.org/.well-known/oauth-protected-resource/api/mcp'
    )
    expect(mcpResourcePath()).toBe('/api/mcp')
  })

  it('answers the suffix route only for this installation resource path', () => {
    installation()
    expect(matchesResourceSuffix(['api', 'mcp'])).toBe(true)
    expect(matchesResourceSuffix(['api', 'mcp', 'extra'])).toBe(false)
    expect(matchesResourceSuffix(['somebody', 'else'])).toBe(false)
    expect(matchesResourceSuffix(undefined)).toBe(false)
  })
})

describe('authorization server metadata', () => {
  it('puts every endpoint on the installation origin', () => {
    installation()
    const doc = authorizationServerMetadata()
    expect(doc.issuer).toBe('https://invoices.example.org')
    expect(doc.authorization_endpoint).toBe('https://invoices.example.org/oauth/authorize')
    expect(doc.token_endpoint).toBe('https://invoices.example.org/api/oauth/token')
    expect(doc.registration_endpoint).toBe('https://invoices.example.org/api/oauth/register')
    expect(doc.response_types_supported).toEqual(['code'])
    expect(doc.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    expect(doc.code_challenge_methods_supported).toEqual(['S256'])
    expect(doc.token_endpoint_auth_methods_supported).toEqual(['none'])
    expect(doc.scopes_supported).toEqual(['read', 'write', 'send', 'delete', 'payments'])
    expect(doc.resource_indicators_supported).toBe(true)
  })
})
