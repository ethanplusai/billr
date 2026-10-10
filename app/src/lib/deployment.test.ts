import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_DOCS_URL, DOCS_URL, appOrigin, mcpUrl } from './deployment'
afterEach(() => vi.unstubAllEnvs())
describe('installation isolation', () => {
  it('defaults to local services', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(appOrigin()).toBe('http://localhost:3000')
    expect(mcpUrl()).toBe('http://localhost:3000/api/mcp')
  })
  it('generates links for this installation', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://invoices.example.org')
    expect(mcpUrl()).toBe('https://invoices.example.org/api/mcp')
  })
  it.each([
    'https://user:password@example.org',
    'https://example.org/subpath',
    'https://example.org?token=x',
    'javascript:alert(1)',
  ])('rejects ambiguous base URL %s', (value) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', value)
    expect(() => appOrigin()).toThrow()
  })
  it('points the docs links at the repository', () => {
    expect(DOCS_URL).toBe('https://github.com/ethanplusai/billr#readme')
    expect(AGENT_DOCS_URL).toMatch(/^https:\/\/github\.com\/ethanplusai\/billr\//)
  })
})
