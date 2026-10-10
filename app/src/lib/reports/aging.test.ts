import { describe, it, expect } from 'vitest'
import {
  agingBucketFor,
  agingByClient,
  buildAgingReport,
  daysPastDue,
} from '@/lib/reports/aging'
import type { OpenInvoice } from '@/lib/reports/types'

const AS_OF = '2026-08-27'

function invoice(overrides: Partial<OpenInvoice> & { dueDate: string }): OpenInvoice {
  return {
    id: overrides.id ?? `inv-${overrides.dueDate}-${overrides.balanceDue ?? 0}`,
    publicId: 'pub',
    invoiceNumber: 'INV-001',
    status: 'sent',
    issueDate: '2026-01-01',
    total: 100,
    balanceDue: 100,
    currency: 'USD',
    clientId: 'client-1',
    clientName: 'Acme',
    clientEmail: null,
    ...overrides,
  }
}

describe('daysPastDue', () => {
  it('is zero on the due date and negative before it', () => {
    expect(daysPastDue('2026-08-27', AS_OF)).toBe(0)
    expect(daysPastDue('2026-08-28', AS_OF)).toBe(-1)
  })
  it('counts calendar days, not 24-hour spans', () => {
    expect(daysPastDue('2026-08-20', AS_OF)).toBe(7)
    expect(daysPastDue('2026-07-28', AS_OF)).toBe(30)
  })
})

describe('agingBucketFor boundaries', () => {
  it('treats not-yet-due and due-today as current', () => {
    expect(agingBucketFor(-5)).toBe('current')
    expect(agingBucketFor(0)).toBe('current')
  })
  it('puts exactly 30 days past due in 1-30 and exactly 31 in 31-60', () => {
    expect(agingBucketFor(1)).toBe('d1_30')
    expect(agingBucketFor(30)).toBe('d1_30')
    expect(agingBucketFor(31)).toBe('d31_60')
  })
  it('puts exactly 60 in 31-60 and exactly 61 in 61-90', () => {
    expect(agingBucketFor(60)).toBe('d31_60')
    expect(agingBucketFor(61)).toBe('d61_90')
  })
  it('puts exactly 90 in 61-90 and 91 in 90+', () => {
    expect(agingBucketFor(90)).toBe('d61_90')
    expect(agingBucketFor(91)).toBe('d90_plus')
    expect(agingBucketFor(400)).toBe('d90_plus')
  })
  it('assigns every bucket exactly once across the boundary range', () => {
    const seen = new Set<string>()
    for (let d = -1; d <= 120; d += 1) seen.add(agingBucketFor(d))
    expect([...seen].sort()).toEqual(['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'])
  })
})

describe('buildAgingReport', () => {
  it('lands boundary invoices in the right bucket end to end', () => {
    // 2026-08-27 minus 30 days = 2026-07-28; minus 31 = 2026-07-27.
    const report = buildAgingReport(
      [
        invoice({ id: 'a', dueDate: '2026-07-28', balanceDue: 100 }),
        invoice({ id: 'b', dueDate: '2026-07-27', balanceDue: 200 }),
      ],
      AS_OF,
      'USD'
    )
    const byId = Object.fromEntries(report.buckets.map((b) => [b.id, b]))
    expect(byId.d1_30.amount).toBe(100)
    expect(byId.d1_30.invoices.map((i) => i.id)).toEqual(['a'])
    expect(byId.d31_60.amount).toBe(200)
    expect(byId.d31_60.invoices.map((i) => i.id)).toEqual(['b'])
  })

  it('separates outstanding, overdue and not-yet-due totals', () => {
    const report = buildAgingReport(
      [
        invoice({ id: 'future', dueDate: '2026-09-10', balanceDue: 500 }),
        invoice({ id: 'today', dueDate: AS_OF, balanceDue: 250 }),
        invoice({ id: 'late', dueDate: '2026-05-01', balanceDue: 1000 }),
      ],
      AS_OF,
      'USD'
    )
    expect(report.totalOutstanding).toBe(1750)
    expect(report.totalCurrent).toBe(750)
    expect(report.totalOverdue).toBe(1000)
    expect(report.oldest?.id).toBe('late')
  })

  it('sums cents without per-row rounding drift', () => {
    // Three rows that each round up individually but must not inflate the total.
    const rows = Array.from({ length: 3 }, (_, i) =>
      invoice({ id: `x${i}`, dueDate: '2026-08-01', balanceDue: 0.005 })
    )
    const report = buildAgingReport(rows, AS_OF, 'USD')
    expect(report.totalOutstanding).toBe(0.02)
  })

  it('coerces database strings to numbers', () => {
    const raw = invoice({ dueDate: '2026-08-01' })
    const withStrings = { ...raw, balanceDue: '125.50' as unknown as number, total: '200.00' as unknown as number }
    const report = buildAgingReport([withStrings], AS_OF, 'USD')
    expect(report.totalOutstanding).toBe(125.5)
    expect(report.buckets.find((b) => b.id === 'd1_30')?.amount).toBe(125.5)
  })

  it('reports zeroed buckets and a zero average for an empty ledger', () => {
    const report = buildAgingReport([], AS_OF, 'USD')
    expect(report.buckets).toHaveLength(5)
    expect(report.buckets.every((b) => b.amount === 0 && b.count === 0 && b.share === 0)).toBe(true)
    expect(report.totalOutstanding).toBe(0)
    expect(report.averageDaysOverdue).toBe(0)
    expect(report.oldest).toBeNull()
  })

  it('weights the average days overdue by balance, ignoring not-yet-due invoices', () => {
    const report = buildAgingReport(
      [
        invoice({ id: 'big', dueDate: '2026-07-28', balanceDue: 900 }), // 30 days
        invoice({ id: 'small', dueDate: '2026-08-17', balanceDue: 100 }), // 10 days
        invoice({ id: 'future', dueDate: '2026-09-30', balanceDue: 5000 }),
      ],
      AS_OF,
      'USD'
    )
    // (900*30 + 100*10) / 1000 = 28
    expect(report.averageDaysOverdue).toBe(28)
  })

  it('shares add to 100 across buckets when anything is outstanding', () => {
    const report = buildAgingReport(
      [
        invoice({ id: 'a', dueDate: '2026-08-01', balanceDue: 300 }),
        invoice({ id: 'b', dueDate: '2026-01-01', balanceDue: 700 }),
      ],
      AS_OF,
      'USD'
    )
    const total = report.buckets.reduce((sum, b) => sum + b.share, 0)
    expect(Math.round(total)).toBe(100)
  })

  it('flags truncation when the row set was capped', () => {
    expect(buildAgingReport([], AS_OF, 'USD', { truncated: true }).truncated).toBe(true)
  })
})

describe('agingByClient', () => {
  it('ranks by overdue balance and keeps the worst bucket per client', () => {
    const report = buildAgingReport(
      [
        invoice({ id: '1', clientId: 'c1', clientName: 'Acme', dueDate: '2026-08-20', balanceDue: 100 }),
        invoice({ id: '2', clientId: 'c1', clientName: 'Acme', dueDate: '2026-01-01', balanceDue: 400 }),
        invoice({ id: '3', clientId: 'c2', clientName: 'Globex', dueDate: '2026-08-26', balanceDue: 50 }),
        invoice({ id: '4', clientId: 'c3', clientName: 'Initech', dueDate: '2026-12-01', balanceDue: 9000 }),
      ],
      AS_OF,
      'USD'
    )
    const rows = agingByClient(report)
    expect(rows[0].clientName).toBe('Acme')
    expect(rows[0].overdue).toBe(500)
    expect(rows[0].worstBucket).toBe('d90_plus')
    expect(rows[0].invoiceCount).toBe(2)
    // Initech owes the most but nothing is late yet, so it ranks last.
    expect(rows[rows.length - 1].clientName).toBe('Initech')
    expect(rows[rows.length - 1].overdue).toBe(0)
    expect(rows[rows.length - 1].outstanding).toBe(9000)
  })
})
