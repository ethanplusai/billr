import { describe, it, expect } from 'vitest'
import { csvFilename, escapeCsvValue, toCsv, withReportContext } from '@/lib/reports/csv'

describe('escapeCsvValue', () => {
  it('quotes values containing commas, quotes or newlines', () => {
    expect(escapeCsvValue('Acme, Inc')).toBe('"Acme, Inc"')
    expect(escapeCsvValue('He said "hi"')).toBe('"He said ""hi"""')
    expect(escapeCsvValue('line1\nline2')).toBe('"line1\nline2"')
  })
  it('neutralises spreadsheet formula injection', () => {
    expect(escapeCsvValue('=1+1')).toBe("'=1+1")
    expect(escapeCsvValue('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(escapeCsvValue('-5 Ltd')).toBe("'-5 Ltd")
  })
  it('renders empty for null and undefined, and leaves numbers alone', () => {
    expect(escapeCsvValue(null)).toBe('')
    expect(escapeCsvValue(undefined)).toBe('')
    expect(escapeCsvValue(1234.5)).toBe('1234.5')
  })
})

describe('toCsv', () => {
  it('writes a header row plus one row per record', () => {
    const csv = toCsv(
      [
        { name: 'Acme', amount: 100 },
        { name: 'Globex, Ltd', amount: 250.5 },
      ],
      [
        { header: 'Client', value: (r) => r.name },
        { header: 'Amount', value: (r) => r.amount },
      ]
    )
    expect(csv.split('\n')).toEqual(['Client,Amount', 'Acme,100', '"Globex, Ltd",250.5'])
  })
  it('emits just the header for an empty report', () => {
    expect(toCsv([], [{ header: 'Client', value: () => '' }])).toBe('Client')
  })
})

describe('withReportContext', () => {
  it('prefixes what the export covers', () => {
    const out = withReportContext('A,B\n1,2', {
      title: 'AR aging',
      range: { start: '2026-01-01', end: '2026-03-31' },
      currency: 'USD',
    })
    expect(out.split('\n')[0]).toBe('AR aging,"Jan 1 to Mar 31, 2026",Amounts in USD')
    expect(out).toContain('A,B\n1,2')
  })
})

describe('csvFilename', () => {
  it('builds a filesystem-safe name carrying the range', () => {
    expect(csvFilename('AR Aging', { start: '2026-01-01', end: '2026-03-31' })).toBe(
      'billr-ar-aging-2026-01-01-to-2026-03-31.csv'
    )
  })
})
