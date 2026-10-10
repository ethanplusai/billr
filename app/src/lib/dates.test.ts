import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { addDaysISO, isISODate, parseDay, toISODate, todayISO } from './dates'

describe('parseDay', () => {
  it('parses to LOCAL midnight, not UTC midnight', () => {
    const d = parseDay('2026-01-05')
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(0)
    expect(d.getDate()).toBe(5)
    expect(d.getHours()).toBe(0)
  })

  it('does not shift the day the way `new Date(iso)` does west of Greenwich', () => {
    // new Date('2026-01-05') is UTC midnight; read through local fields it is
    // Jan 4 anywhere at a negative offset. parseDay is stable everywhere.
    expect(parseDay('2026-01-05').getDate()).toBe(5)
  })
})

describe('toISODate', () => {
  it('formats from LOCAL calendar fields', () => {
    expect(toISODate(new Date(2026, 0, 5))).toBe('2026-01-05')
  })

  it('zero pads', () => {
    expect(toISODate(new Date(2026, 8, 9))).toBe('2026-09-09')
  })

  it('does not shift the day the way `toISOString().slice(0, 10)` does', () => {
    // A date picker hands back local midnight. toISOString() converts to UTC
    // first, which is the previous day at any negative offset.
    expect(toISODate(new Date(2026, 0, 5, 0, 0, 0))).toBe('2026-01-05')
  })
})

describe('round trip', () => {
  const days = [
    '2026-01-01',
    '2026-01-05',
    '2026-02-28',
    '2024-02-29',
    '2026-03-08', // US DST start
    '2026-03-29', // EU DST start
    '2026-06-30',
    '2026-11-01', // US DST end
    '2026-12-31',
  ]

  it('string -> Date -> string is the identity, including across DST', () => {
    for (const day of days) {
      expect(toISODate(parseDay(day)), day).toBe(day)
    }
  })
})

describe('todayISO', () => {
  it('reads the local calendar day of the supplied clock', () => {
    expect(todayISO(new Date(2026, 7, 27, 23, 59))).toBe('2026-08-27')
    expect(todayISO(new Date(2026, 7, 27, 0, 1))).toBe('2026-08-27')
  })

  it('is a well-formed calendar date for the real clock', () => {
    expect(isISODate(todayISO())).toBe(true)
  })
})

describe('addDaysISO', () => {
  it('crosses month and year boundaries', () => {
    expect(addDaysISO('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysISO('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('does not lose a day across a DST transition', () => {
    expect(addDaysISO('2026-03-07', 1)).toBe('2026-03-08')
    expect(addDaysISO('2026-11-01', 1)).toBe('2026-11-02')
  })

  it('handles a leap day', () => {
    expect(addDaysISO('2024-02-28', 1)).toBe('2024-02-29')
  })
})

describe('isISODate', () => {
  it('accepts and rejects the obvious cases', () => {
    expect(isISODate('2026-01-05')).toBe(true)
    expect(isISODate('2026-1-5')).toBe(false)
    expect(isISODate('05/01/2026')).toBe(false)
    expect(isISODate('')).toBe(false)
  })
})

/**
 * Guard, in the same spirit as the em-dash check in
 * src/lib/mcp/tool-catalog.test.ts: the two banned idioms are easy to reach for
 * and silently wrong, so fail the build rather than rely on review catching
 * them. src/lib/dates.ts itself is exempt because it documents them.
 */
describe('banned date idioms', () => {
  const ROOT = join(process.cwd(), 'src')
  const EXEMPT = new Set([join(ROOT, 'lib', 'dates.ts'), join(ROOT, 'lib', 'dates.test.ts')])

  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
    }
    return out
  }

  const files = walk(ROOT).filter((f) => !EXEMPT.has(f))

  it('no source file converts a Date to a calendar day through UTC', () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8')
      return /toISOString\(\)\s*\.\s*(slice\(0,\s*10\)|split\('T'\)\[0\])/.test(src)
    })
    expect(offenders, 'use toISODate / todayISO from @/lib/dates instead').toEqual([])
  })

  it('no source file parses a stored calendar date with new Date(...)', () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8')
      // new Date(<something>.issue_date / due_date / payment_date / expiry_date / paid_at / .date)
      return /new Date\([A-Za-z_$][\w$.]*\.(issue_date|due_date|expiry_date|payment_date|paid_at|date)\b/.test(
        src
      )
    })
    expect(offenders, 'use parseDay from @/lib/dates instead').toEqual([])
  })
})
