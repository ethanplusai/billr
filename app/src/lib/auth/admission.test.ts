import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase } from '@/lib/mcp/fake-supabase'
import { admitAccount, openSignup, signupIsOpen } from './admission'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('openSignup', () => {
  it('is on only for the word true, in any case and with spaces', () => {
    expect(openSignup({ BILLR_OPEN_SIGNUP: 'true' })).toBe(true)
    expect(openSignup({ BILLR_OPEN_SIGNUP: ' TRUE ' })).toBe(true)
    expect(openSignup({ BILLR_OPEN_SIGNUP: '1' })).toBe(false)
    expect(openSignup({ BILLR_OPEN_SIGNUP: 'yes' })).toBe(false)
    expect(openSignup({})).toBe(false)
  })
})

describe('signupIsOpen', () => {
  it('is open on a fresh installation', async () => {
    const db = createFakeSupabase({ 'rpc.install_has_account': { data: false, error: null } })
    expect(await signupIsOpen(db as never)).toBe(true)
  })

  it('is closed once the owner exists', async () => {
    const db = createFakeSupabase({ 'rpc.install_has_account': { data: true, error: null } })
    expect(await signupIsOpen(db as never)).toBe(false)
  })

  it('stays open with BILLR_OPEN_SIGNUP=true, without asking the database', async () => {
    vi.stubEnv('BILLR_OPEN_SIGNUP', 'true')
    const db = createFakeSupabase({ 'rpc.install_has_account': { data: true, error: null } })
    expect(await signupIsOpen(db as never)).toBe(true)
    expect(db.calls).toHaveLength(0)
  })

  it('fails closed when the database cannot answer', async () => {
    const db = createFakeSupabase({ 'rpc.install_has_account': { data: null, error: { message: 'down' } } })
    expect(await signupIsOpen(db as never)).toBe(false)
  })
})

describe('admitAccount', () => {
  it('passes the open-signup setting and returns the decision', async () => {
    vi.stubEnv('BILLR_OPEN_SIGNUP', 'true')
    const db = createFakeSupabase({ 'rpc.admit_install_account': { data: true, error: null } })
    expect(await admitAccount('user-1', db as never)).toBe(true)
    expect(db.calls[0]?.payload).toEqual({ p_user_id: 'user-1', p_open: true })
  })

  it('reports a refusal', async () => {
    const db = createFakeSupabase({ 'rpc.admit_install_account': { data: false, error: null } })
    expect(await admitAccount('user-2', db as never)).toBe(false)
  })

  it('reports an unknown user as no decision', async () => {
    const db = createFakeSupabase({ 'rpc.admit_install_account': { data: null, error: null } })
    expect(await admitAccount('user-3', db as never)).toBeNull()
  })

  it('throws, never admits, when the database cannot answer', async () => {
    const db = createFakeSupabase({ 'rpc.admit_install_account': { data: null, error: { message: 'down' } } })
    await expect(admitAccount('user-4', db as never)).rejects.toThrow(/could not check access/)
  })
})
