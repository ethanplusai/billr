'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { appUrl } from '@/lib/mcp/shared'
import { guardAuthAttempt, recordAuthFailure } from './guard'
import { parseSignUpInput } from './signup-input'
import { admitAccount, signupIsOpen } from './admission'
import { ACCESS_CHECK_FAILED_MESSAGE, SIGNUP_CLOSED_MESSAGE } from './signup-closed'

/**
 * Server actions for sign-in, sign-up and password-reset requests.
 *
 * These exist so authentication passes through a server we control. Before this
 * the auth pages called supabase.auth.* straight from the browser, which meant
 * there was no point in the request path where a rate limit could be applied:
 * an attacker could grind passwords against Supabase Auth at whatever rate it
 * would accept, and nothing of ours would ever see it.
 *
 * Running the calls through @/lib/supabase/server also puts session cookie
 * handling on the server, which is where it belongs.
 *
 * Password RESET completion (updateUser after following the emailed link) is
 * deliberately still client-side: that flow needs the recovery session that
 * Supabase establishes from the URL fragment, which never reaches the server,
 * and it is not a credential-guessing surface because it already requires a
 * valid single-use recovery token.
 */

export interface AuthActionResult {
  success: boolean
  error?: string
  /** Set when the caller was rate limited or locked out, for a Retry-After style hint. */
  retryAfterSeconds?: number
}

const emailSchema = z.string().trim().min(1).max(320).email()

const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
})

const resetSchema = z.object({ email: emailSchema })

// Generic on purpose. Distinguishing "no such account" from "wrong password"
// turns the login form into an account-enumeration oracle.
const INVALID_CREDENTIALS = 'That email or password is not right. Please try again.'

/**
 * Asks whether this account may use the installation. Returns the decision, or
 * 'unavailable' when the database could not answer (never an admission).
 */
async function admission(userId: string): Promise<boolean | null | 'unavailable'> {
  try {
    return await admitAccount(userId)
  } catch {
    return 'unavailable'
  }
}

export async function signInAction(input: {
  email: string
  password: string
}): Promise<AuthActionResult> {
  const parsed = signInSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: INVALID_CREDENTIALS }
  }
  const { email, password } = parsed.data

  const guard = await guardAuthAttempt('signin', email)
  if (guard.blocked) {
    return { success: false, error: guard.message, retryAfterSeconds: guard.retryAfterSeconds }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    await recordAuthFailure(email, guard.ip)
    return { success: false, error: INVALID_CREDENTIALS }
  }

  // Sign-up closes after the first account. An account that was never
  // admitted (for example one made directly against Supabase Auth) gets no
  // session here.
  const admitted = data.user ? await admission(data.user.id) : false
  if (admitted !== true) {
    await supabase.auth.signOut()
    return {
      success: false,
      error: admitted === 'unavailable' ? ACCESS_CHECK_FAILED_MESSAGE : SIGNUP_CLOSED_MESSAGE,
    }
  }

  return { success: true }
}

export interface SignUpActionResult extends AuthActionResult {
  /** True when Supabase returned an active session (email autoconfirm is on). */
  hasSession?: boolean
}

export async function signUpAction(input: {
  email: string
  password: string
  fullName: string
}): Promise<SignUpActionResult> {
  const parsed = parseSignUpInput(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error }
  }
  const { email, password, fullName } = parsed.data

  const guard = await guardAuthAttempt('signup', email)
  if (guard.blocked) {
    return { success: false, error: guard.message, retryAfterSeconds: guard.retryAfterSeconds }
  }

  if (!(await signupIsOpen())) {
    return { success: false, error: SIGNUP_CLOSED_MESSAGE }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
    },
  })

  if (error) {
    // A rejected sign-up is a failed attempt: sign-up is the other endpoint an
    // attacker can use to enumerate which addresses are already registered.
    await recordAuthFailure(email, guard.ip)
    return { success: false, error: error.message }
  }

  // Settles the race between two first sign-ups: only one becomes the owner.
  if (data.user) {
    const admitted = await admission(data.user.id)
    if (admitted === false || admitted === 'unavailable') {
      await supabase.auth.signOut()
      return {
        success: false,
        error: admitted === 'unavailable' ? ACCESS_CHECK_FAILED_MESSAGE : SIGNUP_CLOSED_MESSAGE,
      }
    }
  }

  return { success: true, hasSession: !!data.session }
}

export async function requestPasswordResetAction(input: {
  email: string
}): Promise<AuthActionResult> {
  const parsed = resetSchema.safeParse(input)
  // Always report success for a malformed or unknown address: the reset form
  // must not reveal whether an account exists.
  if (!parsed.success) return { success: true }

  const { email } = parsed.data

  const guard = await guardAuthAttempt('reset', email)
  if (guard.blocked) {
    return { success: false, error: guard.message, retryAfterSeconds: guard.retryAfterSeconds }
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${appUrl()}/api/auth/callback?next=/reset-password`,
  })

  if (error) {
    console.error('requestPasswordResetAction:', error.message)
    // Still a success from the caller's point of view, for the same
    // enumeration reason. The attempt allowance was already spent.
    return { success: true }
  }

  return { success: true }
}

/** Whether the sign-up page should show the form. */
export async function signupStatusAction(): Promise<{ open: boolean }> {
  return { open: await signupIsOpen() }
}
