import { describe, it, expect } from 'vitest'
import { periodRange, sumBy, topClients, summarizeByCurrency, type SummaryRow } from './info'

// Fixed reference point so period boundaries are deterministic:
// 2026-03-15 is mid-month, mid-year, and its previous month (February 2026)
// is a non-leap 28-day month.
const NOW = new Date(2026, 2, 15, 12, 0, 0)

function row(overrides: Partial<SummaryRow> = {}): SummaryRow {
  return {
    status: 'sent',
    total: 0,
    amount_paid: 0,
    balance_due: 0,
    currency: 'USD',
    due_date: '2099-01-01',
    client_id: null,
    ...overrides,
  }
}

describe('periodRange', () => {
  it('this_month spans the first to the last day of the current month', () => {
    expect(periodRange('this_month', NOW)).toEqual({ start: '2026-03-01', end: '2026-03-31' })
  })

  it('last_month spans the previous month, respecting its real length', () => {
    expect(periodRange('last_month', NOW)).toEqual({ start: '2026-02-01', end: '2026-02-28' })
  })

  it('this_year spans Jan 1 to Dec 31', () => {
    expect(periodRange('this_year', NOW)).toEqual({ start: '2026-01-01', end: '2026-12-31' })
  })

  it('all applies no date filter', () => {
    expect(periodRange('all', NOW)).toBeNull()
  })

  it('handles the first day of a month without slipping into the prior one', () => {
    const firstOfMarch = new Date(2026, 2, 1, 0, 0, 0)
    expect(periodRange('this_month', firstOfMarch)).toEqual({ start: '2026-03-01', end: '2026-03-31' })
    expect(periodRange('last_month', firstOfMarch)).toEqual({ start: '2026-02-01', end: '2026-02-28' })
  })

  it('handles the last day of a year without slipping into the next one', () => {
    const newYearsEve = new Date(2026, 11, 31, 23, 0, 0)
    expect(periodRange('this_month', newYearsEve)).toEqual({ start: '2026-12-01', end: '2026-12-31' })
    expect(periodRange('last_month', newYearsEve)).toEqual({ start: '2026-11-01', end: '2026-11-30' })
    expect(periodRange('this_year', newYearsEve)).toEqual({ start: '2026-01-01', end: '2026-12-31' })
  })

  it('rolls last_month back across a year boundary from January', () => {
    const january = new Date(2026, 0, 10, 12, 0, 0)
    expect(periodRange('last_month', january)).toEqual({ start: '2025-12-01', end: '2025-12-31' })
  })

  it('reports February 29 in a leap year', () => {
    const leapMarch = new Date(2028, 2, 10, 12, 0, 0)
    expect(periodRange('last_month', leapMarch)).toEqual({ start: '2028-02-01', end: '2028-02-29' })
  })
})

describe('sumBy', () => {
  it('sums the requested money field', () => {
    const rows = [row({ total: 10.5 }), row({ total: 4.25 })]
    expect(sumBy(rows, 'total')).toBe(14.75)
  })

  it('treats nulls as zero rather than producing NaN', () => {
    expect(sumBy([row({ total: null }), row({ total: 5 })], 'total')).toBe(5)
  })

  it('rounds float drift back to cents', () => {
    const rows = [row({ balance_due: 0.1 }), row({ balance_due: 0.2 })]
    expect(sumBy(rows, 'balance_due')).toBe(0.3)
  })

  it('returns 0 for an empty set', () => {
    expect(sumBy([], 'amount_paid')).toBe(0)
  })
})

describe('topClients', () => {
  it('sums per client and sorts by invoiced amount descending', () => {
    const rows = [
      row({ client_id: 'a', total: 100, clients: { name: 'Acme' } }),
      row({ client_id: 'b', total: 300, clients: { name: 'Beta' } }),
      row({ client_id: 'a', total: 50, clients: { name: 'Acme' } }),
    ]
    expect(topClients(rows)).toEqual([
      { name: 'Beta', invoiced: 300 },
      { name: 'Acme', invoiced: 150 },
    ])
  })

  it('caps the result at 5 clients', () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      row({ client_id: `c${i}`, total: i + 1, clients: { name: `Client ${i}` } })
    )
    const result = topClients(rows)
    expect(result).toHaveLength(5)
    expect(result.map((c) => c.name)).toEqual([
      'Client 7',
      'Client 6',
      'Client 5',
      'Client 4',
      'Client 3',
    ])
  })

  it('breaks ties by first appearance (sort is stable)', () => {
    const rows = [
      row({ client_id: 'a', total: 100, clients: { name: 'Acme' } }),
      row({ client_id: 'b', total: 100, clients: { name: 'Beta' } }),
      row({ client_id: 'c', total: 100, clients: { name: 'Gamma' } }),
    ]
    expect(topClients(rows).map((c) => c.name)).toEqual(['Acme', 'Beta', 'Gamma'])
  })

  it('skips rows with no client_id', () => {
    const rows = [row({ client_id: null, total: 999 }), row({ client_id: 'a', total: 1, clients: { name: 'Acme' } })]
    expect(topClients(rows)).toEqual([{ name: 'Acme', invoiced: 1 }])
  })

  it('labels a client whose name could not be joined', () => {
    expect(topClients([row({ client_id: 'a', total: 5, clients: null })])).toEqual([
      { name: 'Unknown client', invoiced: 5 },
    ])
  })

  it('returns an empty list for no rows', () => {
    expect(topClients([])).toEqual([])
  })
})

describe('summarizeByCurrency', () => {
  it('never sums across currencies', () => {
    const rows = [
      row({ currency: 'USD', total: 100, amount_paid: 40, balance_due: 60 }),
      row({ currency: 'EUR', total: 200, amount_paid: 0, balance_due: 200 }),
      row({ currency: 'USD', total: 10, amount_paid: 10, balance_due: 0 }),
    ]
    const result = summarizeByCurrency(rows)
    expect(result.map((c) => c.currency)).toEqual(['USD', 'EUR'])
    expect(result[0]).toMatchObject({
      currency: 'USD',
      invoiced_total: 110,
      paid_total: 50,
      outstanding_total: 60,
    })
    expect(result[1]).toMatchObject({ currency: 'EUR', invoiced_total: 200, outstanding_total: 200 })
  })

  it('counts only past-due sent/viewed/partial rows toward overdue_total', () => {
    const rows = [
      row({ status: 'sent', due_date: '2000-01-01', balance_due: 30 }),
      row({ status: 'draft', due_date: '2000-01-01', balance_due: 70 }),
      row({ status: 'sent', due_date: '2099-01-01', balance_due: 500 }),
    ]
    // draft is filtered out upstream by EXCLUDED_FROM_TOTALS, but isOverdue
    // also refuses to count it here; the future-dated row isn't overdue.
    expect(summarizeByCurrency(rows)[0].overdue_total).toBe(30)
  })

  it('returns an empty list for no rows', () => {
    expect(summarizeByCurrency([])).toEqual([])
  })
})
