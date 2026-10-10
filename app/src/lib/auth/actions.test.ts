import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Integration tests for the sign-up server action.
 *
 * These call the real action and assert the wire between the agreement check,
 * the rate-limit guard and Supabase Auth: the agreement must stop a request
 * before any authentication call, and the recorded versions and timestamp must
 * come from the server rather than from the caller.
 */

const {
  createClientMock,
  guardAuthAttempt,
  recordAuthFailure,
  signUp,
  signOut,
  signInWithPassword,
  signupIsOpen,
  admitAccount,
} = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  guardAuthAttempt: vi.fn(),
  recordAuthFailure: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
  signInWithPassword: vi.fn(),
  signupIsOpen: vi.fn(),
  admitAccount: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }))
vi.mock('./guard', () => ({ guardAuthAttempt, recordAuthFailure }))
vi.mock('./admission', () => ({ signupIsOpen, admitAccount }))

import { signInAction, signUpAction } from './actions'
import { ACCESS_CHECK_FAILED_MESSAGE, SIGNUP_CLOSED_MESSAGE } from './signup-closed'

const VALID = {
  email: 'person@example.com',
  password: 'correct-horse-battery',
  fullName: 'Harper Lane',
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-20T22:00:00Z'))
  createClientMock.mockReset()
  createClientMock.mockResolvedValue({ auth: { signUp, signOut, signInWithPassword } })
  guardAuthAttempt.mockReset()
  guardAuthAttempt.mockResolvedValue({ blocked: false, ip: '203.0.113.5' })
  recordAuthFailure.mockReset()
  signUp.mockReset()
  signUp.mockResolvedValue({
    data: { user: { id: 'user-1' }, session: { access_token: 'x' } },
    error: null,
  })
  signupIsOpen.mockReset()
  signupIsOpen.mockResolvedValue(true)
  admitAccount.mockReset()
  admitAccount.mockResolvedValue(true)
  signOut.mockReset()
  signInWithPassword.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('signUpAction', () => {
  it('creates the account with the name as its only metadata', async () => {
    const result = await signUpAction(VALID)

    expect(result).toEqual({ success: true, hasSession: true })
    expect(signUp).toHaveBeenCalledTimes(1)
    expect(signUp).toHaveBeenCalledWith({
      email: 'person@example.com',
      password: 'correct-horse-battery',
      options: { data: { full_name: 'Harper Lane' } },
    })
  })

  it('reports no session when confirmation email is required', async () => {
    signUp.mockResolvedValue({ data: { session: null }, error: null })
    expect(await signUpAction(VALID)).toEqual({ success: true, hasSession: false })
  })

  it('reports a rate limit without touching Supabase Auth', async () => {
    guardAuthAttempt.mockResolvedValue({
      blocked: true,
      message: 'Too many attempts.',
      retryAfterSeconds: 900,
    })

    const result = await signUpAction(VALID)

    expect(result).toEqual({
      success: false,
      error: 'Too many attempts.',
      retryAfterSeconds: 900,
    })
    expect(createClientMock).not.toHaveBeenCalled()
  })

  it('records a failed attempt when Supabase rejects the sign-up', async () => {
    signUp.mockResolvedValue({ data: null, error: { message: 'already registered' } })

    const result = await signUpAction(VALID)

    expect(result).toEqual({ success: false, error: 'already registered' })
    expect(recordAuthFailure).toHaveBeenCalledWith(VALID.email, '203.0.113.5')
  })
})

describe('sign-up after the first account', () => {
  it('refuses before creating anything when sign-up is closed', async () => {
    signupIsOpen.mockResolvedValue(false)
    expect(await signUpAction(VALID)).toEqual({ success: false, error: SIGNUP_CLOSED_MESSAGE })
    expect(signUp).not.toHaveBeenCalled()
  })

  it('signs out an account that lost the race to be first', async () => {
    admitAccount.mockResolvedValue(false)
    expect(await signUpAction(VALID)).toEqual({ success: false, error: SIGNUP_CLOSED_MESSAGE })
    expect(signOut).toHaveBeenCalled()
  })

  it('admits the owner and keeps the session', async () => {
    expect(await signUpAction(VALID)).toEqual({ success: true, hasSession: true })
    expect(admitAccount).toHaveBeenCalledWith('user-1')
  })

  it('lets an existing-address placeholder through to the check-your-email message', async () => {
    signUp.mockResolvedValue({ data: { user: { id: 'placeholder' }, session: null }, error: null })
    admitAccount.mockResolvedValue(null)
    expect(await signUpAction(VALID)).toEqual({ success: true, hasSession: false })
    expect(signOut).not.toHaveBeenCalled()
  })

  it('signs out and asks for a retry when access cannot be checked', async () => {
    admitAccount.mockRejectedValue(new Error('could not check access'))
    expect(await signUpAction(VALID)).toEqual({ success: false, error: ACCESS_CHECK_FAILED_MESSAGE })
    expect(signOut).toHaveBeenCalled()
  })
})

describe('signInAction', () => {
  it('signs in an admitted account', async () => {
    signInWithPassword.mockResolvedValue({ data: { user: { id: 'owner' } }, error: null })
    expect(await signInAction({ email: 'person@example.com', password: 'pw' })).toEqual({ success: true })
  })

  it('signs out an account that was never admitted', async () => {
    signInWithPassword.mockResolvedValue({ data: { user: { id: 'stranger' } }, error: null })
    admitAccount.mockResolvedValue(false)
    expect(await signInAction({ email: 'person@example.com', password: 'pw' })).toEqual({
      success: false,
      error: SIGNUP_CLOSED_MESSAGE,
    })
    expect(signOut).toHaveBeenCalled()
  })

  it('signs out without claiming sign-up is closed when access cannot be checked', async () => {
    signInWithPassword.mockResolvedValue({ data: { user: { id: 'owner' } }, error: null })
    admitAccount.mockRejectedValue(new Error('could not check access'))
    expect(await signInAction({ email: 'person@example.com', password: 'pw' })).toEqual({
      success: false,
      error: ACCESS_CHECK_FAILED_MESSAGE,
    })
    expect(signOut).toHaveBeenCalled()
  })
})
