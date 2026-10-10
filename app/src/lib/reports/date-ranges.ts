/**
 * Date-range presets, comparison periods and time bucketing for reports.
 * Pure - no React, no I/O.
 *
 * Timezone discipline: this file follows, and no longer defines, the app-wide
 * calendar-date rule. See src/lib/dates.ts for the full statement of it. In
 * short: every date reported on lives in a Postgres DATE column, a DATE has no
 * timezone, so nothing here converts to or from UTC. Calendar dates are
 * 'yyyy-MM-dd' strings, parsed to LOCAL midnight. Postgres buckets with
 * date_trunc on the same DATE columns, so the server and the client agree on
 * which day a row belongs to.
 *
 * parseDay / toISODate / todayISO moved to src/lib/dates.ts so the rest of the
 * app (invoice pages, MCP tools, PDF rendering, Stripe reconciliation) shares
 * one implementation instead of each hand-rolling a variant. They are
 * re-exported here so every existing import keeps working.
 */

import { parseDay, toISODate, todayISO } from '@/lib/dates'
import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  endOfMonth,
  format,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
  subMonths,
  subQuarters,
  subYears,
} from 'date-fns'

export type BucketUnit = 'day' | 'week' | 'month'

export interface ReportRange {
  /** Inclusive start, 'yyyy-MM-dd'. */
  start: string
  /** Inclusive end, 'yyyy-MM-dd'. */
  end: string
}

export type RangePresetId =
  | 'this_month'
  | 'last_month'
  | 'quarter_to_date'
  | 'year_to_date'
  | 'last_12_months'
  | 'custom'

export const RANGE_PRESETS: { id: RangePresetId; label: string }[] = [
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'quarter_to_date', label: 'Quarter to date' },
  { id: 'year_to_date', label: 'Year to date' },
  { id: 'last_12_months', label: 'Last 12 months' },
  { id: 'custom', label: 'Custom range' },
]

export { parseDay, toISODate, todayISO }

export function resolveRange(
  preset: RangePresetId,
  today: Date,
  custom?: ReportRange
): ReportRange {
  switch (preset) {
    case 'this_month':
      return { start: toISODate(startOfMonth(today)), end: toISODate(today) }
    case 'last_month': {
      const prev = subMonths(today, 1)
      return { start: toISODate(startOfMonth(prev)), end: toISODate(endOfMonth(prev)) }
    }
    case 'quarter_to_date':
      return { start: toISODate(startOfQuarter(today)), end: toISODate(today) }
    case 'year_to_date':
      return { start: toISODate(startOfYear(today)), end: toISODate(today) }
    case 'last_12_months':
      return { start: toISODate(startOfMonth(subMonths(today, 11))), end: toISODate(today) }
    case 'custom':
      return custom ?? { start: toISODate(startOfMonth(today)), end: toISODate(today) }
  }
}

/**
 * The period a range is compared against.
 *
 * Calendar-aligned presets compare to the equivalent calendar period (this
 * month vs last month, QTD vs the same stretch of the previous quarter, YTD vs
 * the same stretch of last year) because that is the comparison a business
 * owner means. A custom range has no calendar meaning, so it compares to the
 * equal-length window immediately before it.
 */
export function previousRange(range: ReportRange, preset: RangePresetId): ReportRange {
  const start = parseDay(range.start)
  const end = parseDay(range.end)

  switch (preset) {
    case 'this_month': {
      const prevStart = subMonths(start, 1)
      // Day-of-month aligned, clamped to the previous month's length so
      // "March 1-31 vs February" does not spill into March.
      const prevEnd = clampToMonth(prevStart, end.getDate())
      return { start: toISODate(prevStart), end: toISODate(prevEnd) }
    }
    case 'last_month': {
      const prevStart = subMonths(start, 1)
      return { start: toISODate(prevStart), end: toISODate(endOfMonth(prevStart)) }
    }
    case 'quarter_to_date': {
      const prevStart = subQuarters(start, 1)
      const daysIn = differenceInCalendarDays(end, start)
      return { start: toISODate(prevStart), end: toISODate(addDays(prevStart, daysIn)) }
    }
    case 'year_to_date': {
      const prevStart = subYears(start, 1)
      const daysIn = differenceInCalendarDays(end, start)
      return { start: toISODate(prevStart), end: toISODate(addDays(prevStart, daysIn)) }
    }
    case 'last_12_months': {
      const prevStart = subMonths(start, 12)
      const daysIn = differenceInCalendarDays(end, start)
      return { start: toISODate(prevStart), end: toISODate(addDays(prevStart, daysIn)) }
    }
    case 'custom':
    default: {
      const daysIn = differenceInCalendarDays(end, start)
      const prevEnd = addDays(start, -1)
      return { start: toISODate(addDays(prevEnd, -daysIn)), end: toISODate(prevEnd) }
    }
  }
}

function clampToMonth(monthAnchor: Date, dayOfMonth: number): Date {
  const last = endOfMonth(monthAnchor).getDate()
  return new Date(monthAnchor.getFullYear(), monthAnchor.getMonth(), Math.min(dayOfMonth, last))
}

/** Inclusive day count of a range. */
export function rangeLengthInDays(range: ReportRange): number {
  return differenceInCalendarDays(parseDay(range.end), parseDay(range.start)) + 1
}

/**
 * Bucket granularity for a range: enough points to show a shape, few enough
 * that the axis stays readable. Chosen from the range alone so the server and
 * the chart never disagree about the bucket.
 */
export function chooseBucket(range: ReportRange): BucketUnit {
  const days = rangeLengthInDays(range)
  if (days <= 31) return 'day'
  if (days <= 120) return 'week'
  return 'month'
}

/** Every bucket start in a range, matching Postgres date_trunc (weeks start Monday). */
export function enumerateBuckets(range: ReportRange, bucket: BucketUnit): string[] {
  const end = parseDay(range.end)
  let cursor = truncateToBucket(parseDay(range.start), bucket)
  const out: string[] = []
  // Hard stop well past any realistic range so a bad input cannot spin.
  for (let i = 0; i < 2000 && cursor <= end; i += 1) {
    out.push(toISODate(cursor))
    cursor =
      bucket === 'day' ? addDays(cursor, 1) : bucket === 'week' ? addDays(cursor, 7) : addMonths(cursor, 1)
  }
  return out
}

function truncateToBucket(date: Date, bucket: BucketUnit): Date {
  if (bucket === 'day') return date
  if (bucket === 'week') return startOfWeek(date, { weekStartsOn: 1 })
  return startOfMonth(date)
}

/** Which bucket a calendar date falls into, as a bucket-start date string. */
export function bucketKeyFor(iso: string, bucket: BucketUnit): string {
  return toISODate(truncateToBucket(parseDay(iso), bucket))
}

export function formatBucketLabel(iso: string, bucket: BucketUnit): string {
  const date = parseDay(iso)
  if (bucket === 'day') return format(date, 'MMM d')
  if (bucket === 'week') return format(date, 'MMM d')
  return format(date, 'MMM yyyy')
}

export function formatRangeLabel(range: ReportRange): string {
  const start = parseDay(range.start)
  const end = parseDay(range.end)
  const sameYear = start.getFullYear() === end.getFullYear()
  return sameYear
    ? `${format(start, 'MMM d')} to ${format(end, 'MMM d, yyyy')}`
    : `${format(start, 'MMM d, yyyy')} to ${format(end, 'MMM d, yyyy')}`
}

/** True when a custom range is usable (both ends present, start not after end). */
export function isValidRange(range: ReportRange): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.start) || !/^\d{4}-\d{2}-\d{2}$/.test(range.end)) return false
  return range.start <= range.end
}
