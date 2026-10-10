/**
 * Money primitives for the reports layer. No React, no I/O - pure functions
 * so the arithmetic can be unit-tested.
 *
 * Two rules this module exists to enforce:
 *
 * 1. PostgREST hands numeric/DECIMAL columns back as STRINGS. Anything that
 *    reaches a calculation goes through toNumber() first; nothing in this
 *    layer assumes a value is already a number.
 * 2. Round ONCE, at the end of an accumulation, never per step. Rounding each
 *    addend and then summing drifts by a cent per row, which has already bitten
 *    this repo once.
 */

/** Coerces a PostgREST numeric (string), a JSON number, or null/undefined to a finite number. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/** Rounds to cents. Call this once, on a finished total - not on each addend. */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0
  // Scale before rounding so 1.005 does not fall to 1.00 through float error.
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/**
 * Sums raw (possibly string) money values, accumulating at full precision and
 * rounding exactly once.
 */
export function sumMoney(values: readonly unknown[]): number {
  let total = 0
  for (const value of values) total += toNumber(value)
  return roundMoney(total)
}

/** Share of a total, 0-100. Returns 0 rather than NaN/Infinity when the total is 0. */
export function percentOf(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total === 0) return 0
  return (part / total) * 100
}

export interface Delta {
  /** current - previous, rounded once. */
  absolute: number
  /** Percentage change, or null when the previous period was zero (no meaningful percentage). */
  percent: number | null
  direction: 'up' | 'down' | 'flat'
}

/**
 * Period-over-period delta. A zero previous period yields a null percent
 * rather than Infinity or a fabricated "+100%", so the UI can say "no
 * comparable activity" instead of printing a number that is not true.
 */
export function computeDelta(current: number, previous: number): Delta {
  const absolute = roundMoney(current - previous)
  const percent = previous === 0 ? null : ((current - previous) / Math.abs(previous)) * 100
  const direction = absolute > 0 ? 'up' : absolute < 0 ? 'down' : 'flat'
  return { absolute, percent, direction }
}

/** Minutes to decimal hours, rounded to two places for display. */
export function minutesToHours(minutes: number): number {
  if (!Number.isFinite(minutes)) return 0
  return Math.round((minutes / 60) * 100) / 100
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
  }
}

/** Compact form for axis ticks and stat tiles: $4.2K, $1.3M. */
export function formatMoneyCompact(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(amount)
  } catch {
    return `${Math.round(amount).toLocaleString('en-US')} ${currency}`
  }
}

export function formatHours(hours: number): string {
  return `${hours.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}h`
}

export function formatPercent(value: number, digits = 0): string {
  return `${value.toFixed(digits)}%`
}
