import 'server-only'
import { headers } from 'next/headers'
import {
  RATE_LIMITS,
  clientIpFrom,
  consumeRateLimit,
  consumeRateLimits,
  ipKey,
  peekRateLimit,
  rateLimitKey,
} from '@/lib/rate-limit'

/**
 * Rate limiting and abuse lockout for the authentication endpoints.
 *
 * Sign-in, sign-up and password-reset used to run straight from the browser
 * against Supabase Auth, so there was no server of ours in the path and nothing
 * to limit. They now go through the server actions in ./actions.ts, which call
 * into here first.
 *
 * Four buckets, deliberately layered:
 *
 *   attempts per email    stops one account being ground through a wordlist
 *   attempts per IP       stops one source spraying many accounts, so rotating
 *                         the email address does not buy a fresh allowance
 *   failures per email    one hour lockout on an account under attack
 *   failures per IP       one hour lockout on a source that keeps guessing
 *
 * The attempt buckets are spent on every request. The failure buckets are spent
 * only when the credentials were actually wrong, and are read with peek (which
 * does not increment) before the attempt, so checking a lockout never deepens
 * it and a legitimate user's successful sign-ins never push them toward one.
 *
 * All of it fails closed: the limiter defaults to denying when Postgres is
 * unreachable, and these call sites do not opt out of that.
 */

interface AuthGuardBlock {
  blocked: true
  /** Copy safe to show a person. Deliberately identical for every reason, so it cannot be used to probe. */
  message: string
  retryAfterSeconds: number
}

interface AuthGuardPass {
  blocked: false
  ip: string | null
}

export type AuthGuardResult = AuthGuardBlock | AuthGuardPass

const BLOCKED_MESSAGE =
  'Too many attempts. Please wait a few minutes and try again.'

const LOCKED_MESSAGE =
  'Too many failed attempts. Access from here is paused for up to an hour. Please try again later, or reset your password.'

function normaliseIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase()
}

async function clientIp(): Promise<string | null> {
  return clientIpFrom(await headers())
}

/**
 * Runs before an authentication attempt. Returns a block result the caller must
 * return to the user verbatim, or a pass carrying the resolved IP so the caller
 * can hand it back to recordAuthFailure without resolving it twice.
 */
export async function guardAuthAttempt(
  action: 'signin' | 'signup' | 'reset',
  identifier: string
): Promise<AuthGuardResult> {
  const ip = await clientIp()
  const id = normaliseIdentifier(identifier)

  // Standing lockouts first, read-only, so a locked-out attacker cannot extend
  // their own lockout forever and a check costs nothing.
  const [idLock, ipLock] = await Promise.all([
    peekRateLimit(rateLimitKey('authfail:id', id), RATE_LIMITS.authIdentifierLockout),
    peekRateLimit(ipKey('authfail:ip', ip), RATE_LIMITS.authIpLockout),
  ])

  if (!idLock.allowed || !ipLock.allowed) {
    return {
      blocked: true,
      message: LOCKED_MESSAGE,
      retryAfterSeconds: Math.max(idLock.retryAfterSeconds, ipLock.retryAfterSeconds),
    }
  }

  // Then spend the attempt allowance. Both layers are spent even if one denies.
  const attempt = await consumeRateLimits([
    { bucket: rateLimitKey(`auth:${action}:id`, id), policy: RATE_LIMITS.authIdentifier },
    { bucket: ipKey('auth:ip', ip), policy: RATE_LIMITS.authIp },
  ])

  if (!attempt.allowed) {
    return {
      blocked: true,
      message: BLOCKED_MESSAGE,
      retryAfterSeconds: attempt.retryAfterSeconds,
    }
  }

  return { blocked: false, ip }
}

/**
 * Records a failed attempt against both lockout buckets. Call this only when
 * the credentials were rejected, never when the call merely errored for some
 * other reason, or an outage would lock out the whole user base.
 */
export async function recordAuthFailure(identifier: string, ip: string | null): Promise<void> {
  const id = normaliseIdentifier(identifier)
  await Promise.all([
    consumeRateLimit(rateLimitKey('authfail:id', id), RATE_LIMITS.authIdentifierLockout),
    consumeRateLimit(ipKey('authfail:ip', ip), RATE_LIMITS.authIpLockout),
  ])
}
