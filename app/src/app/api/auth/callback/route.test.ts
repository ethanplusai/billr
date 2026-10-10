import { beforeEach, describe, expect, it, vi } from 'vitest'

const { exchange, getUser, signOut, admitAccount } = vi.hoisted(() => ({
  exchange: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
  admitAccount: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { exchangeCodeForSession: exchange, getUser, signOut } })),
}))
vi.mock('@/lib/auth/admission', () => ({ admitAccount }))

import { GET } from './route'

const ORIGIN = 'http://localhost:3000'

function signedIn(id = 'user-1') {
  exchange.mockResolvedValue({ error: null })
  getUser.mockResolvedValue({ data: { user: { id } } })
}

describe('authentication callback', () => {
  beforeEach(() => {
    exchange.mockReset()
    getUser.mockReset()
    signOut.mockReset()
    admitAccount.mockReset()
    admitAccount.mockResolvedValue(true)
  })

  it('exchanges the code and returns an admitted account to the requested local page', async () => {
    signedIn()
    const response = await GET(
      new Request(`${ORIGIN}/api/auth/callback?code=example&next=%2Fagents%3Ftab%3Dkeys`),
    )
    expect(exchange).toHaveBeenCalledWith('example')
    expect(admitAccount).toHaveBeenCalledWith('user-1')
    expect(response.headers.get('location')).toBe(`${ORIGIN}/agents?tab=keys`)
  })

  it('does not allow an external destination after authentication', async () => {
    signedIn()
    const response = await GET(
      new Request(`${ORIGIN}/api/auth/callback?code=example&next=%2F%2Fevil.example`),
    )
    expect(response.headers.get('location')).toBe(`${ORIGIN}/dashboard`)
  })

  it('signs out a new GitHub or Google account once sign-up is closed', async () => {
    signedIn('stranger')
    admitAccount.mockResolvedValue(false)
    const response = await GET(new Request(`${ORIGIN}/api/auth/callback?code=example&next=%2Fdashboard`))
    expect(signOut).toHaveBeenCalled()
    expect(response.headers.get('location')).toBe(`${ORIGIN}/login?error=signup_closed`)
  })

  it('signs out and says so honestly when access cannot be checked', async () => {
    signedIn('owner')
    admitAccount.mockRejectedValue(new Error('could not check access'))
    const response = await GET(new Request(`${ORIGIN}/api/auth/callback?code=example&next=%2Fdashboard`))
    expect(signOut).toHaveBeenCalled()
    expect(response.headers.get('location')).toBe(`${ORIGIN}/login?error=access_check`)
  })

  it('sends a failed exchange back to sign-in with the destination kept', async () => {
    exchange.mockResolvedValue({ error: { message: 'expired' } })
    const response = await GET(
      new Request(`${ORIGIN}/api/auth/callback?code=example&next=%2Finvoices`),
    )
    expect(response.headers.get('location')).toBe(`${ORIGIN}/login?error=auth&redirect=%2Finvoices`)
    expect(admitAccount).not.toHaveBeenCalled()
  })
})
