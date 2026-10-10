import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _setRateLimitStore } from '@/lib/rate-limit'
import { allowAllRateLimitStore, createFakeDb, type FakeDb, type Row } from '@/lib/oauth/fake-db'
import { challengeFromVerifier, generateSecret } from '@/lib/oauth/params'
import {
  _setOauthServiceClient,
  issueAuthorizationCode,
  registerClient,
} from '@/lib/oauth/store'
import { POST } from './route'

const REDIRECT = 'http://localhost:51873/callback'
const USER = '11111111-1111-1111-1111-111111111111'
const BUSINESS = '22222222-2222-2222-2222-222222222222'

let db: FakeDb

beforeEach(() => {
  db = createFakeDb()
  _setOauthServiceClient(() => db.client)
  _setRateLimitStore(() => allowAllRateLimitStore())
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://invoices.example.org')
})

afterEach(() => {
  _setOauthServiceClient(null)
  _setRateLimitStore(null)
  vi.unstubAllEnvs()
})

function post(form: Record<string, string>): Request {
  return new Request('https://invoices.example.org/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
}

async function seedClient(name = 'Claude Code') {
  const client = await registerClient({ clientName: name, redirectUris: [REDIRECT] })
  if (!client) throw new Error('seed failed')
  return client
}

async function seedCode(options: {
  clientRowId: string
  challenge: string
  permissions?: ('read' | 'write' | 'send' | 'delete' | 'payments')[]
  resource?: string | null
}) {
  const code = await issueAuthorizationCode({
    clientRowId: options.clientRowId,
    userId: USER,
    businessId: BUSINESS,
    redirectUri: REDIRECT,
    codeChallenge: options.challenge,
    permissions: options.permissions ?? ['read', 'write'],
    resource: options.resource ?? null,
  })
  if (!code) throw new Error('seed failed')
  return code
}

function keys(): Row[] {
  return db.tables.api_keys ?? []
}

function refreshRows(): Row[] {
  return db.tables.oauth_refresh_tokens ?? []
}

describe('authorization code grant', () => {
  it('exchanges a code for an api_keys-backed access token and a refresh token', async () => {
    const client = await seedClient()
    const verifier = generateSecret(48)
    const code = await seedCode({
      clientRowId: client.id,
      challenge: challengeFromVerifier(verifier),
      permissions: ['read', 'write', 'send'],
    })

    const res = await POST(
      post({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        resource: 'https://invoices.example.org/api/mcp',
      })
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json()
    expect(body.token_type).toBe('Bearer')
    expect(body.access_token).toMatch(/^billr_at_[0-9a-f]{48}$/)
    expect(body.refresh_token).toMatch(/^billr_rt_/)
    expect(body.expires_in).toBe(30 * 86400)
    expect(body.scope).toBe('read write send')

    // The access token IS an api_keys row, so resolveApiKey needs no new path.
    expect(keys()).toHaveLength(1)
    expect(keys()[0]).toMatchObject({
      kind: 'oauth',
      business_id: BUSINESS,
      user_id: USER,
      label: 'Claude Code',
      oauth_client_id: client.id,
      permissions: ['read', 'write', 'send'],
    })
    const expiresAt = Date.parse(keys()[0].expires_at as string)
    expect(expiresAt - Date.now()).toBeGreaterThan(29 * 86400_000)
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(30 * 86400_000)
    expect(refreshRows()).toHaveLength(1)
  })

  it('refuses the wrong PKCE verifier and issues nothing', async () => {
    const client = await seedClient()
    const code = await seedCode({
      clientRowId: client.id,
      challenge: challengeFromVerifier(generateSecret(48)),
    })

    const res = await POST(
      post({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_verifier: generateSecret(48),
      })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
    expect(keys()).toHaveLength(0)
  })

  it('requires a code_verifier at all', async () => {
    const client = await seedClient()
    const verifier = generateSecret(48)
    const code = await seedCode({
      clientRowId: client.id,
      challenge: challengeFromVerifier(verifier),
    })
    const res = await POST(
      post({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
      })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_request')
  })

  it('redeems a code exactly once and burns the grant when it is replayed', async () => {
    const client = await seedClient()
    const verifier = generateSecret(48)
    const code = await seedCode({
      clientRowId: client.id,
      challenge: challengeFromVerifier(verifier),
    })
    const form = {
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }

    expect((await POST(post(form))).status).toBe(200)

    const replay = await POST(post(form))
    expect(replay.status).toBe(400)
    expect((await replay.json()).error).toBe('invalid_grant')

    // Replay means the code leaked, so everything it issued is revoked.
    expect(keys()).toHaveLength(1)
    expect(keys()[0].revoked_at).toBeTruthy()
    expect(refreshRows()[0].revoked_at).toBeTruthy()
  })

  it('refuses an expired code', async () => {
    const client = await seedClient()
    const verifier = generateSecret(48)
    const code = await seedCode({
      clientRowId: client.id,
      challenge: challengeFromVerifier(verifier),
    })
    db.tables.oauth_authorization_codes[0].expires_at = new Date(Date.now() - 1000).toISOString()

    const res = await POST(
      post({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
    expect(keys()).toHaveLength(0)
  })

  it('refuses an unknown client and a redirect_uri that is not the one in the code', async () => {
    const client = await seedClient()
    const verifier = generateSecret(48)
    const challenge = challengeFromVerifier(verifier)

    const unknown = await POST(
      post({
        grant_type: 'authorization_code',
        code: await seedCode({ clientRowId: client.id, challenge }),
        client_id: 'billr_client_deadbeef',
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      })
    )
    expect(unknown.status).toBe(401)
    expect((await unknown.json()).error).toBe('invalid_client')

    const mismatched = await POST(
      post({
        grant_type: 'authorization_code',
        code: await seedCode({ clientRowId: client.id, challenge }),
        client_id: client.client_id,
        redirect_uri: 'http://localhost:51873/other',
        code_verifier: verifier,
      })
    )
    expect(mismatched.status).toBe(400)
    expect((await mismatched.json()).error).toBe('invalid_grant')
  })

  it('refuses a code minted for a different client', async () => {
    const mine = await seedClient('Mine')
    const other = await seedClient('Other')
    const verifier = generateSecret(48)
    const code = await seedCode({
      clientRowId: other.id,
      challenge: challengeFromVerifier(verifier),
    })

    const res = await POST(
      post({
        grant_type: 'authorization_code',
        code,
        client_id: mine.client_id,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
  })

  it('refuses a resource indicator naming another audience', async () => {
    const client = await seedClient()
    const verifier = generateSecret(48)
    const code = await seedCode({
      clientRowId: client.id,
      challenge: challengeFromVerifier(verifier),
    })
    const res = await POST(
      post({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        resource: 'https://mcp.evil.example',
      })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_target')
  })
})

describe('refresh grant', () => {
  async function connect(permissions?: ('read' | 'write' | 'send' | 'delete' | 'payments')[]) {
    const client = await seedClient()
    const verifier = generateSecret(48)
    const code = await seedCode({
      clientRowId: client.id,
      challenge: challengeFromVerifier(verifier),
      permissions,
    })
    const res = await POST(
      post({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      })
    )
    return { client, tokens: await res.json() }
  }

  it('rotates: new tokens, old refresh spent, superseded key revoked', async () => {
    const { client, tokens } = await connect()

    const res = await POST(
      post({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
      })
    )
    expect(res.status).toBe(200)
    const next = await res.json()
    expect(next.access_token).not.toBe(tokens.access_token)
    expect(next.refresh_token).not.toBe(tokens.refresh_token)
    expect(next.scope).toBe('read write')

    expect(keys()).toHaveLength(2)
    expect(keys()[0].revoked_at).toBeTruthy()
    expect(keys()[1].revoked_at).toBeFalsy()
    expect(refreshRows()).toHaveLength(2)
    expect(refreshRows()[0].used_at).toBeTruthy()
    expect(refreshRows()[1].family_id).toBe(refreshRows()[0].family_id)
  })

  it('treats reuse of a rotated refresh token as theft and burns the family', async () => {
    const { client, tokens } = await connect()
    const form = {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    }
    expect((await POST(post(form))).status).toBe(200)

    const replay = await POST(post(form))
    expect(replay.status).toBe(400)
    expect((await replay.json()).error).toBe('invalid_grant')

    expect(keys().every((key) => !!key.revoked_at)).toBe(true)
    expect(refreshRows().every((row) => !!row.revoked_at)).toBe(true)
  })

  it('lets a refresh narrow the grant but never widen it', async () => {
    const { client, tokens } = await connect(['read', 'write', 'send'])

    const narrowed = await POST(
      post({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
        scope: 'read',
      })
    )
    expect(narrowed.status).toBe(200)
    const body = await narrowed.json()
    expect(body.scope).toBe('read')
    expect(keys()[1].permissions).toEqual(['read'])

    const widened = await POST(
      post({
        grant_type: 'refresh_token',
        refresh_token: body.refresh_token,
        client_id: client.client_id,
        scope: 'read write send delete',
      })
    )
    expect(widened.status).toBe(400)
    expect((await widened.json()).error).toBe('invalid_scope')
  })

  it('refuses an unknown refresh token, an expired one, and the wrong client', async () => {
    const { client, tokens } = await connect()

    const unknown = await POST(
      post({
        grant_type: 'refresh_token',
        refresh_token: 'billr_rt_nonsense',
        client_id: client.client_id,
      })
    )
    expect(unknown.status).toBe(400)
    expect((await unknown.json()).error).toBe('invalid_grant')

    const other = await seedClient('Other')
    const wrongClient = await POST(
      post({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: other.client_id,
      })
    )
    expect(wrongClient.status).toBe(400)

    refreshRows()[0].expires_at = new Date(Date.now() - 1000).toISOString()
    const expired = await POST(
      post({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
      })
    )
    expect(expired.status).toBe(400)
    expect((await expired.json()).error).toBe('invalid_grant')
  })
})

describe('grant type handling', () => {
  it('rejects a missing or unsupported grant_type', async () => {
    const missing = await POST(post({}))
    expect(missing.status).toBe(400)
    expect((await missing.json()).error).toBe('invalid_request')

    const unsupported = await POST(post({ grant_type: 'password' }))
    expect(unsupported.status).toBe(400)
    expect((await unsupported.json()).error).toBe('unsupported_grant_type')
  })

  it('fails closed when the rate limiter denies', async () => {
    _setRateLimitStore(() => ({
      rpc: async () => ({
        data: [{ allowed: false, remaining: 0, retry_after_seconds: 60 }],
        error: null,
      }),
    }))
    const res = await POST(post({ grant_type: 'authorization_code' }))
    expect(res.status).toBe(429)
  })
})
