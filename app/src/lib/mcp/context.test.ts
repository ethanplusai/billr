import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resolveApiKey = vi.fn()
vi.mock('@/lib/api-keys/resolver', () => ({ resolveApiKey: (...args: unknown[]) => resolveApiKey(...args) }))

const { getMcpContext } = await import('./context')

beforeEach(() => {
  resolveApiKey.mockReset()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://invoices.example.org')
  // createScopedDb builds a service client on the success path; it only needs
  // these to be present, never reachable.
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key')
})

afterEach(() => vi.unstubAllEnvs())

function request(auth?: string): Request {
  return new Request('https://invoices.example.org/api/mcp', {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
  })
}

describe('MCP 401', () => {
  it('points the client at the protected-resource document', async () => {
    resolveApiKey.mockResolvedValue({ error: 'invalid' })
    const res = (await getMcpContext(request())) as Response

    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="billr", resource_metadata="https://invoices.example.org/.well-known/oauth-protected-resource/api/mcp"'
    )
    const body = await res.json()
    expect(body.error).toBe('Missing or invalid access token')
    expect(body.error_description).toMatch(/OAuth/)
  })

  it('still rate limits without advertising discovery', async () => {
    resolveApiKey.mockResolvedValue({ error: 'rate_limited' })
    const res = (await getMcpContext(request())) as Response
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('60')
  })

  it('passes an OAuth-issued key through unchanged, like any other key', async () => {
    resolveApiKey.mockResolvedValue({
      userId: 'u1',
      keyId: 'k1',
      businessIds: ['b1'],
      permissions: ['read', 'write'],
    })
    const ctx = await getMcpContext(request('Bearer billr_at_' + 'a'.repeat(48)))
    expect(ctx).not.toBeInstanceOf(Response)
    expect(resolveApiKey).toHaveBeenCalledWith('billr_at_' + 'a'.repeat(48), expect.anything())
  })
})
