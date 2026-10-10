import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _setRateLimitStore } from '@/lib/rate-limit'
import { allowAllRateLimitStore, createFakeDb, type FakeDb } from '@/lib/oauth/fake-db'
import { _setOauthServiceClient } from '@/lib/oauth/store'
import { POST } from './route'

let db: FakeDb

beforeEach(() => {
  db = createFakeDb()
  _setOauthServiceClient(() => db.client)
  _setRateLimitStore(() => allowAllRateLimitStore())
})

afterEach(() => {
  _setOauthServiceClient(null)
  _setRateLimitStore(null)
  vi.unstubAllEnvs()
})

function post(body: unknown, contentType = 'application/json'): Request {
  return new Request('https://invoices.example.org/api/oauth/register', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('dynamic client registration', () => {
  it('registers a public client and stores name plus redirect URIs', async () => {
    const res = await POST(
      post({
        client_name: 'Claude',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      })
    )
    expect(res.status).toBe(201)
    expect(res.headers.get('Cache-Control')).toBe('no-store')

    const body = await res.json()
    expect(body.client_id).toMatch(/^billr_client_[0-9a-f]{32}$/)
    expect(body.token_endpoint_auth_method).toBe('none')
    expect(body).not.toHaveProperty('client_secret')
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token'])
    expect(body.scope).toBe('read write send delete payments')

    expect(db.tables.oauth_clients).toHaveLength(1)
    expect(db.tables.oauth_clients[0]).toMatchObject({
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    })
  })

  it('accepts a loopback redirect on any port, which is how CLIs connect', async () => {
    const res = await POST(
      post({ client_name: 'Claude Code', redirect_uris: ['http://localhost:51873/callback'] })
    )
    expect(res.status).toBe(201)
  })

  it('names an unnamed client rather than storing an empty label', async () => {
    const res = await POST(post({ redirect_uris: ['https://a.example/cb'] }))
    expect(res.status).toBe(201)
    expect((await res.json()).client_name).toBe('MCP client')
  })

  it.each([
    ['plain http to a remote host', ['http://evil.example/cb']],
    ['a custom scheme', ['myapp://callback']],
    ['a fragment', ['https://a.example/cb#x']],
    ['no redirect URIs at all', []],
  ])('rejects %s', async (_label, redirect_uris) => {
    const res = await POST(post({ client_name: 'x', redirect_uris }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_redirect_uri')
    expect(db.tables.oauth_clients ?? []).toHaveLength(0)
  })

  it('rejects a confidential client, because no secret is ever issued', async () => {
    const res = await POST(
      post({
        client_name: 'x',
        redirect_uris: ['https://a.example/cb'],
        token_endpoint_auth_method: 'client_secret_basic',
      })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_client_metadata')
  })

  it('rejects grants and response types we do not implement', async () => {
    const implicit = await POST(
      post({
        redirect_uris: ['https://a.example/cb'],
        response_types: ['token'],
      })
    )
    expect(implicit.status).toBe(400)

    const password = await POST(
      post({
        redirect_uris: ['https://a.example/cb'],
        grant_types: ['password'],
      })
    )
    expect(password.status).toBe(400)
  })

  it('rejects a body that is not a JSON object', async () => {
    expect((await POST(post('not json'))).status).toBe(400)
    expect((await POST(post([1, 2]))).status).toBe(400)
  })

  it('fails closed when the rate limiter denies', async () => {
    _setRateLimitStore(() => ({
      rpc: async () => ({
        data: [{ allowed: false, remaining: 0, retry_after_seconds: 900 }],
        error: null,
      }),
    }))
    const res = await POST(post({ redirect_uris: ['https://a.example/cb'] }))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('900')
  })
})
