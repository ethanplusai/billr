/**
 * The one rule for calendar dates in this app.
 *
 * ----------------------------------------------------------------------------
 * THE RULE
 *
 *   1. Every business date lives in a Postgres DATE column: invoices.issue_date,
 *      invoices.due_date, invoices.paid_at, payments.payment_date,
 *      expenses.date, time_entries.date, estimates.expiry_date. A DATE has no
 *      time and no timezone. It is a calendar day, nothing more.
 *
 *   2. In TypeScript a calendar day is the string 'yyyy-MM-dd'. Never a Date.
 *      Strings compare and sort correctly, survive JSON, and cannot drift.
 *
 *   3. Crossing between the two forms goes through this module, always:
 *        string -> Date   parseDay      (LOCAL midnight)
 *        Date   -> string toISODate     (LOCAL calendar fields)
 *        now    -> string todayISO
 *
 *   4. Two constructs are banned outright:
 *        new Date('2026-01-05')          parses as UTC midnight, so
 *                                        format(...) renders "Jan 4" for
 *                                        everyone west of Greenwich
 *        someDate.toISOString().slice(0, 10)
 *                                        converts a LOCAL midnight Date to UTC,
 *                                        so a date picked on Jan 5 in New York
 *                                        is stored as Jan 4
 *      They are exact inverses of each other's bug and cancel out only by luck.
 *
 * ----------------------------------------------------------------------------
 * WHY THIS IS COHERENT ACROSS THE STACK
 *
 * The awkward case is "today", because the browser and the server sit in
 * different zones. The rule is that "today" is always the calendar day of the
 * clock doing the asking, read through its LOCAL fields:
 *
 *   in the browser  the user's own day, which is the day they mean when they
 *                   pick a date or look at an overdue badge
 *   on the server   the deployment's day. On Vercel the runtime is UTC, so
 *                   todayISO() on the server equals Postgres CURRENT_DATE, and
 *                   a server-side "is this overdue" answer agrees with any SQL
 *                   that compares against CURRENT_DATE
 *
 * That is the same rule the reports layer already documents and follows (see
 * src/lib/reports/date-ranges.ts, which re-exports these helpers rather than
 * keeping a second copy). Nothing in the app converts a calendar date to or
 * from UTC, because there is nothing to convert: a DATE is not an instant.
 *
 * Timestamps are the other category and are unaffected. created_at,
 * last_sent_at, last_viewed_at are TIMESTAMPTZ, i.e. real instants, and stay as
 * ISO-8601 strings via toISOString(). Only the day-precision fields above use
 * this module.
 */

/**
 * Parses 'yyyy-MM-dd' to LOCAL midnight.
 *
 * Never use `new Date(isoDateString)` for this: the ECMAScript spec parses a
 * bare date-only string as UTC, which lands on the previous calendar day for
 * anyone at a negative offset.
 */
export function parseDay(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

/**
 * Formats a Date as 'yyyy-MM-dd' from its LOCAL calendar fields.
 *
 * Never use `date.toISOString().slice(0, 10)` for this: it shifts to UTC first,
 * so a local-midnight Date from a date picker comes back as the day before.
 */
export function toISODate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Today as a calendar date string, per the rule above. */
export function todayISO(now: Date = new Date()): string {
  return toISODate(now)
}

/** True for a well-formed 'yyyy-MM-dd' string. */
export function isISODate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/**
 * Adds days to a calendar date string, staying in string form.
 * Handles month and year boundaries and DST via the local Date arithmetic.
 */
export function addDaysISO(iso: string, days: number): string {
  const date = parseDay(iso)
  date.setDate(date.getDate() + days)
  return toISODate(date)
}
