import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb, type FakeDb } from './fake-db'

let db: FakeDb

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => db.client }))

const { listOauthConnections, revokeOauthConnection } = await import('./connections')
const { _setOauthServiceClient } = await import('./store')

const USER = '11111111-1111-1111-1111-111111111111'

beforeEach(() => {
  db = createFakeDb({
    api_keys: [
      {
        id: 'key-oauth',
        user_id: USER,
        kind: 'oauth',
        label: 'Claude',
        business_id: 'b1',
        permissions: ['read', 'write'],
        created_at: '2026-09-01T00:00:00Z',
        last_used_at: null,
        expires_at: '2026-10-01T00:00:00Z',
        revoked_at: null,
      },
      {
        id: 'key-superseded',
        user_id: USER,
        kind: 'oauth',
        label: 'Claude',
        business_id: 'b1',
        permissions: ['read', 'write'],
        created_at: '2026-08-15T00:00:00Z',
        last_used_at: null,
        expires_at: '2026-09-15T00:00:00Z',
        revoked_at: null,
      },
      {
        id: 'key-manual',
        user_id: USER,
        kind: 'manual',
        label: 'Pasted key',
        business_id: null,
        permissions: ['read'],
        created_at: '2026-08-01T00:00:00Z',
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
      },
    ],
    oauth_refresh_tokens: [
      // Current token of the family that minted key-oauth.
      { id: 'rt-current', family_id: 'fam-1', api_key_id: 'key-oauth', revoked_at: null },
      // Earlier rotation in the SAME family: still live, so a revoke that only
      // looked at api_key_id would leave the client able to renew with this one.
      { id: 'rt-earlier', family_id: 'fam-1', api_key_id: 'key-superseded', revoked_at: null },
      // A different connection entirely; must survive.
      { id: 'rt-other', family_id: 'fam-2', api_key_id: 'key-other', revoked_at: null },
    ],
  })
  _setOauthServiceClient(() => db.client)
})

afterEach(() => {
  _setOauthServiceClient(null)
})

describe('oauth connections', () => {
  it('lists only OAuth-issued keys, with the granting client name', async () => {
    const connections = await listOauthConnections(USER)
    expect(connections.map((c) => c.id)).toEqual(['key-oauth', 'key-superseded'])
    expect(connections[0]).toMatchObject({
      id: 'key-oauth',
      label: 'Claude',
      clientName: 'Claude',
      permissions: ['read', 'write'],
      businessId: 'b1',
    })
  })

  it('never embeds oauth_clients, which a signed-in caller may not read', async () => {
    // The schema does REVOKE ALL ON oauth_clients FROM PUBLIC, anon,
    // authenticated. PostgREST resource embedding needs SELECT on the embedded
    // table for the querying role, so the old
    // `...,oauth_clients(client_name)` select failed on every real request and
    // the swallowed error left the Connected apps panel permanently empty. The
    // name comes off api_keys.label, which the token endpoint sets to the
    // client's name when it mints the key.
    await listOauthConnections(USER)
    const asked = db.selects.filter((entry) => entry.table === 'api_keys')
    expect(asked).not.toHaveLength(0)
    for (const entry of asked) {
      expect(entry.columns).not.toContain('oauth_clients')
      expect(entry.columns).not.toMatch(/\w+\s*\(/)
    }
  })

  it('still names the app when the row carries nothing but api_keys columns', async () => {
    db.tables.api_keys = [
      {
        id: 'key-only',
        user_id: USER,
        kind: 'oauth',
        label: 'Some MCP Client',
        business_id: 'b1',
        permissions: ['read'],
        created_at: '2026-09-01T00:00:00Z',
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
      },
    ]
    const [connection] = await listOauthConnections(USER)
    expect(connection.clientName).toBe('Some MCP Client')
  })

  it('revokes one connection and reports a second attempt honestly', async () => {
    expect(await revokeOauthConnection(USER, 'key-oauth')).toEqual({ success: true })
    expect(db.tables.api_keys.find((row) => row.id === 'key-oauth')?.revoked_at).toBeTruthy()

    const again = await revokeOauthConnection(USER, 'key-oauth')
    expect(again.success).toBe(false)
  })

  it('revokes the whole refresh family, so the client cannot silently renew', async () => {
    expect(await revokeOauthConnection(USER, 'key-oauth')).toEqual({ success: true })

    const tokens = db.tables.oauth_refresh_tokens
    const byId = (id: string) => tokens.find((row) => row.id === id)
    expect(byId('rt-current')?.revoked_at).toBeTruthy()
    expect(byId('rt-earlier')?.revoked_at).toBeTruthy()
    expect(byId('rt-other')?.revoked_at).toBeNull()

    // The family sweep also kills access keys the family minted earlier.
    const keys = db.tables.api_keys
    expect(keys.find((row) => row.id === 'key-superseded')?.revoked_at).toBeTruthy()
    expect(keys.find((row) => row.id === 'key-manual')?.revoked_at).toBeNull()
  })

  it('leaves other connections\' refresh tokens alone when a revoke finds none of its own', async () => {
    db.tables.oauth_refresh_tokens = db.tables.oauth_refresh_tokens.filter(
      (row) => row.family_id !== 'fam-1'
    )

    expect(await revokeOauthConnection(USER, 'key-oauth')).toEqual({ success: true })
    expect(db.tables.oauth_refresh_tokens[0].revoked_at).toBeNull()
  })

  it('does not touch refresh tokens when the key was not the caller\'s to revoke', async () => {
    const result = await revokeOauthConnection('22222222-2222-2222-2222-222222222222', 'key-oauth')
    expect(result.success).toBe(false)
    expect(db.tables.oauth_refresh_tokens.every((row) => row.revoked_at === null)).toBe(true)
  })

  it('will not revoke a manual key through the connections path', async () => {
    const result = await revokeOauthConnection(USER, 'key-manual')
    expect(result.success).toBe(false)
    expect(db.tables.api_keys.find((row) => row.id === 'key-manual')?.revoked_at).toBeNull()
  })
})
