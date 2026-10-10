import { describe, it, expect } from 'vitest'
import {
  bucketKeyFor,
  chooseBucket,
  enumerateBuckets,
  formatBucketLabel,
  formatRangeLabel,
  isValidRange,
  parseDay,
  previousRange,
  rangeLengthInDays,
  resolveRange,
  toISODate,
} from '@/lib/reports/date-ranges'

// A Thursday, mid-quarter, so month/quarter/year boundaries are all distinct.
const TODAY = new Date(2026, 7, 27) // 27 Aug 2026, local

describe('parseDay', () => {
  it('parses to LOCAL midnight, so the calendar day never shifts', () => {
    const d = parseDay('2026-03-01')
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(2)
    expect(d.getDate()).toBe(1)
    expect(d.getHours()).toBe(0)
  })
  it('round-trips through toISODate', () => {
    expect(toISODate(parseDay('2025-12-31'))).toBe('2025-12-31')
  })
})

describe('resolveRange', () => {
  it('this month runs from the 1st to today', () => {
    expect(resolveRange('this_month', TODAY)).toEqual({ start: '2026-08-01', end: '2026-08-27' })
  })
  it('last month is a whole calendar month', () => {
    expect(resolveRange('last_month', TODAY)).toEqual({ start: '2026-07-01', end: '2026-07-31' })
  })
  it('quarter to date starts at the quarter boundary', () => {
    expect(resolveRange('quarter_to_date', TODAY)).toEqual({ start: '2026-07-01', end: '2026-08-27' })
  })
  it('year to date starts on 1 January', () => {
    expect(resolveRange('year_to_date', TODAY)).toEqual({ start: '2026-01-01', end: '2026-08-27' })
  })
  it('last 12 months starts 11 months back at the month boundary', () => {
    expect(resolveRange('last_12_months', TODAY)).toEqual({ start: '2025-09-01', end: '2026-08-27' })
  })
  it('custom passes the caller range through', () => {
    const custom = { start: '2026-02-03', end: '2026-02-09' }
    expect(resolveRange('custom', TODAY, custom)).toEqual(custom)
  })
})

describe('previousRange', () => {
  it('this month compares to the same stretch of last month', () => {
    const range = resolveRange('this_month', TODAY)
    expect(previousRange(range, 'this_month')).toEqual({ start: '2026-07-01', end: '2026-07-27' })
  })
  it('clamps a long month back into a short one', () => {
    // 1-31 March compared to February, which has 28 days in 2026.
    const range = { start: '2026-03-01', end: '2026-03-31' }
    expect(previousRange(range, 'this_month')).toEqual({ start: '2026-02-01', end: '2026-02-28' })
  })
  it('last month compares to the whole month before it', () => {
    const range = resolveRange('last_month', TODAY)
    expect(previousRange(range, 'last_month')).toEqual({ start: '2026-06-01', end: '2026-06-30' })
  })
  it('quarter to date compares to the same stretch of the previous quarter', () => {
    const range = resolveRange('quarter_to_date', TODAY)
    expect(previousRange(range, 'quarter_to_date')).toEqual({ start: '2026-04-01', end: '2026-05-28' })
  })
  it('year to date compares to the same stretch of last year', () => {
    const range = resolveRange('year_to_date', TODAY)
    expect(previousRange(range, 'year_to_date')).toEqual({ start: '2025-01-01', end: '2025-08-27' })
  })
  it('a custom range compares to the equal-length window immediately before it', () => {
    const range = { start: '2026-02-10', end: '2026-02-19' } // 10 days
    const prev = previousRange(range, 'custom')
    expect(prev).toEqual({ start: '2026-01-31', end: '2026-02-09' })
    expect(rangeLengthInDays(prev)).toBe(rangeLengthInDays(range))
  })
  it('never overlaps the range it compares against', () => {
    const range = { start: '2026-05-01', end: '2026-05-31' }
    expect(previousRange(range, 'custom').end < range.start).toBe(true)
  })
})

describe('chooseBucket', () => {
  it('uses days for a month or less', () => {
    expect(chooseBucket({ start: '2026-08-01', end: '2026-08-27' })).toBe('day')
    expect(chooseBucket({ start: '2026-01-01', end: '2026-01-31' })).toBe('day')
  })
  it('uses weeks for a quarter', () => {
    expect(chooseBucket({ start: '2026-01-01', end: '2026-03-31' })).toBe('week')
  })
  it('uses months for anything longer', () => {
    expect(chooseBucket({ start: '2025-09-01', end: '2026-08-27' })).toBe('month')
  })
})

describe('enumerateBuckets', () => {
  it('emits one month start per month, inclusive of both ends', () => {
    expect(enumerateBuckets({ start: '2026-01-15', end: '2026-03-02' }, 'month')).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ])
  })
  it('starts weeks on Monday, matching Postgres date_trunc', () => {
    // 2026-08-27 is a Thursday; its week starts Monday 2026-08-24.
    expect(enumerateBuckets({ start: '2026-08-27', end: '2026-09-01' }, 'week')).toEqual([
      '2026-08-24',
      '2026-08-31',
    ])
  })
  it('emits every day for a day bucket', () => {
    expect(enumerateBuckets({ start: '2026-02-27', end: '2026-03-01' }, 'day')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ])
  })
})

describe('bucketKeyFor', () => {
  it('maps a date onto its bucket start', () => {
    expect(bucketKeyFor('2026-08-27', 'month')).toBe('2026-08-01')
    expect(bucketKeyFor('2026-08-27', 'week')).toBe('2026-08-24')
    expect(bucketKeyFor('2026-08-27', 'day')).toBe('2026-08-27')
  })
})

describe('labels and validation', () => {
  it('labels buckets by unit', () => {
    expect(formatBucketLabel('2026-08-01', 'month')).toBe('Aug 2026')
    expect(formatBucketLabel('2026-08-24', 'week')).toBe('Aug 24')
  })
  it('drops the repeated year in a same-year range label', () => {
    expect(formatRangeLabel({ start: '2026-01-01', end: '2026-03-31' })).toBe('Jan 1 to Mar 31, 2026')
    expect(formatRangeLabel({ start: '2025-12-01', end: '2026-01-31' })).toBe('Dec 1, 2025 to Jan 31, 2026')
  })
  it('rejects malformed or inverted custom ranges', () => {
    expect(isValidRange({ start: '2026-01-01', end: '2026-01-31' })).toBe(true)
    expect(isValidRange({ start: '2026-02-01', end: '2026-01-31' })).toBe(false)
    expect(isValidRange({ start: '', end: '2026-01-31' })).toBe(false)
    expect(isValidRange({ start: '01/01/2026', end: '2026-01-31' })).toBe(false)
  })
})
