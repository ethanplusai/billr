import 'server-only'
import { consumeRateLimit, rateLimitKey, type RateLimitPolicy } from '@/lib/rate-limit'

/**
 * Optional outbound email cap per business, set with BILLR_EMAIL_DAILY_LIMIT.
 * Mail leaves from your own Resend account and domain, so there is no cap
 * unless you ask for one.
 *
 * WINDOW SHAPE: the durable limiter uses fixed windows keyed on the epoch
 * floored to the window length, and clamps the window to at most 24 hours.
 * So this is a 24-hour window that rolls over on a fixed boundary rather than
 * a true sliding window: "resets in about N hours" is exact, and a burst that
 * straddles the boundary can reach up to twice the limit across it.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Thrown when a business has spent its daily allowance. */
export class EmailQuotaError extends Error {
  /** Whole hours until the window rolls over, floored at 1. */
  readonly resetsInHours: number
  constructor(resetsInHours: number) {
    super(
      `Daily email limit reached for this business, resets in about ${resetsInHours} ${
        resetsInHours === 1 ? 'hour' : 'hours'
      }.`
    )
    this.name = 'EmailQuotaError'
    this.resetsInHours = resetsInHours
  }
}

/**
 * Resolves the cap in force, or null for "no cap".
 *
 * BILLR_EMAIL_DAILY_LIMIT applies when it is a positive whole
 * number. Anything else (blank, zero, negative, fractional, not a number) is
 * ignored with a warning rather than honoured: a typo'd "0" or "abc" must not
 * silently switch every outbound email off, which is a far worse failure than
 * sending uncapped.
 */
export function emailDailyLimit(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.BILLR_EMAIL_DAILY_LIMIT?.trim()
  if (raw) {
    const parsed = Number(raw)
    if (Number.isInteger(parsed) && parsed > 0) return parsed
    console.error(
      `email quota: ignoring BILLR_EMAIL_DAILY_LIMIT=${raw} (want a positive whole number of sends per day)`
    )
  }
  return null
}

/**
 * The limiter policy for one business's daily allowance. Built here rather
 * than added to RATE_LIMITS because the limit is not a constant: it depends
 * on the operator's env.
 *
 * FAILS CLOSED, like every other policy in the product. It costs little: the
 * send path cannot complete without Postgres anyway (prepareDelivery reads
 * and writes email_deliveries), so a store outage was going to stop the send
 * either way, and failing open here would hand an unbounded send budget to
 * exactly the moment the database is struggling.
 */
function emailQuotaPolicy(limit: number): RateLimitPolicy {
  return { limit, windowMs: DAY_MS }
}

/** Bucket key. The business id is hashed by rateLimitKey, like every other bucket. */
export function emailQuotaBucket(businessId: string): string {
  return rateLimitKey('email:send', businessId)
}

/**
 * Spends one send from the business's daily allowance, or throws
 * EmailQuotaError. A no-op (and no round trip) when no cap applies, which is
 * the default.
 */
export async function consumeEmailQuota(businessId: string): Promise<void> {
  const limit = emailDailyLimit()
  if (limit === null) return
  const decision = await consumeRateLimit(emailQuotaBucket(businessId), emailQuotaPolicy(limit))
  if (decision.allowed) return
  throw new EmailQuotaError(Math.max(1, Math.round(decision.retryAfterSeconds / 3600)))
}
