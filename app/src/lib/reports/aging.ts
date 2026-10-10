/**
 * Accounts-receivable aging. Pure - no React, no I/O.
 *
 * Aging is a SNAPSHOT as of a given day, not a windowed report: money owed
 * from eighteen months ago is still owed today, so the selected date range
 * never filters these invoices.
 *
 * Bucket boundaries are the part that has to be exactly right, because they
 * decide which invoice a person chases first. The convention here (and the one
 * the tests pin):
 *
 *   daysPastDue <= 0   -> "Not yet due"   (due today counts as not yet due)
 *   1  .. 30           -> "1 to 30 days"
 *   31 .. 60           -> "31 to 60 days"
 *   61 .. 90           -> "61 to 90 days"
 *   91+                -> "90+ days"
 *
 * So an invoice due exactly 30 days ago is in 1-30, and one due exactly 31
 * days ago is in 31-60. Boundaries are closed on both ends and never overlap.
 */

import { differenceInCalendarDays } from 'date-fns'
import { parseDay } from '@/lib/reports/date-ranges'
import { percentOf, roundMoney, toNumber } from '@/lib/reports/money'
import type { OpenInvoice } from '@/lib/reports/types'

export type AgingBucketId = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus'

interface AgingBucketMeta {
  id: AgingBucketId
  label: string
  /** Short form for chart axes and legends. */
  short: string
  /** Plain-language explanation used in tooltips and the table view. */
  description: string
  overdue: boolean
}

const AGING_BUCKETS: AgingBucketMeta[] = [
  {
    id: 'current',
    label: 'Not yet due',
    short: 'Not due',
    description: 'Open invoices whose due date has not passed',
    overdue: false,
  },
  {
    id: 'd1_30',
    label: '1 to 30 days',
    short: '1-30',
    description: 'Overdue by 1 to 30 days',
    overdue: true,
  },
  {
    id: 'd31_60',
    label: '31 to 60 days',
    short: '31-60',
    description: 'Overdue by 31 to 60 days',
    overdue: true,
  },
  {
    id: 'd61_90',
    label: '61 to 90 days',
    short: '61-90',
    description: 'Overdue by 61 to 90 days',
    overdue: true,
  },
  {
    id: 'd90_plus',
    label: 'More than 90 days',
    short: '90+',
    description: 'Overdue by more than 90 days',
    overdue: true,
  },
]

/** Calendar days between a due date and the reference day. Negative when not yet due. */
export function daysPastDue(dueDate: string, asOf: string): number {
  if (!dueDate) return 0
  return differenceInCalendarDays(parseDay(asOf), parseDay(dueDate))
}

/** Maps a days-past-due count to its bucket. Closed intervals, no overlap. */
export function agingBucketFor(days: number): AgingBucketId {
  if (days <= 0) return 'current'
  if (days <= 30) return 'd1_30'
  if (days <= 60) return 'd31_60'
  if (days <= 90) return 'd61_90'
  return 'd90_plus'
}

export interface AgedInvoice extends OpenInvoice {
  daysPastDue: number
  bucket: AgingBucketId
}

interface AgingBucketResult extends AgingBucketMeta {
  amount: number
  count: number
  /** Share of total receivable, 0-100. */
  share: number
  invoices: AgedInvoice[]
}

export interface AgingReport {
  asOf: string
  currency: string
  buckets: AgingBucketResult[]
  /** Every open invoice, aged, newest due date first. */
  invoices: AgedInvoice[]
  /** Everything open, due or not. */
  totalOutstanding: number
  /** Open and past its due date. */
  totalOverdue: number
  /** Open but not yet due. */
  totalCurrent: number
  /** Balance-weighted average days past due across overdue invoices, 0 when none. */
  averageDaysOverdue: number
  /** The single most overdue invoice, or null. */
  oldest: AgedInvoice | null
  /** True when the RPC capped the row set, so these figures are a floor. */
  truncated: boolean
  invoiceCount: number
}

export function buildAgingReport(
  invoices: readonly OpenInvoice[],
  asOf: string,
  currency: string,
  options: { truncated?: boolean } = {}
): AgingReport {
  const aged: AgedInvoice[] = invoices.map((invoice) => {
    const days = daysPastDue(invoice.dueDate, asOf)
    return {
      ...invoice,
      balanceDue: toNumber(invoice.balanceDue),
      total: toNumber(invoice.total),
      daysPastDue: days,
      bucket: agingBucketFor(days),
    }
  })

  // Accumulate at full precision, round once per bucket. Rounding each
  // invoice first and then adding drifts the bucket totals off the ledger.
  const rawByBucket = new Map<AgingBucketId, number>()
  const rowsByBucket = new Map<AgingBucketId, AgedInvoice[]>()
  let rawTotal = 0
  let rawOverdue = 0
  let weighted = 0

  for (const invoice of aged) {
    rawByBucket.set(invoice.bucket, (rawByBucket.get(invoice.bucket) ?? 0) + invoice.balanceDue)
    const list = rowsByBucket.get(invoice.bucket)
    if (list) list.push(invoice)
    else rowsByBucket.set(invoice.bucket, [invoice])
    rawTotal += invoice.balanceDue
    if (invoice.daysPastDue > 0) {
      rawOverdue += invoice.balanceDue
      weighted += invoice.balanceDue * invoice.daysPastDue
    }
  }

  const totalOutstanding = roundMoney(rawTotal)
  const totalOverdue = roundMoney(rawOverdue)

  const buckets = AGING_BUCKETS.map((meta) => {
    const amount = roundMoney(rawByBucket.get(meta.id) ?? 0)
    const rows = (rowsByBucket.get(meta.id) ?? []).slice().sort((a, b) => b.balanceDue - a.balanceDue)
    return {
      ...meta,
      amount,
      count: rows.length,
      share: percentOf(amount, totalOutstanding),
      invoices: rows,
    }
  })

  const overdueRows = aged.filter((i) => i.daysPastDue > 0)
  const oldest = overdueRows.reduce<AgedInvoice | null>(
    (worst, row) => (worst === null || row.daysPastDue > worst.daysPastDue ? row : worst),
    null
  )

  return {
    asOf,
    currency,
    buckets,
    invoices: aged.slice().sort((a, b) => b.daysPastDue - a.daysPastDue),
    totalOutstanding,
    totalOverdue,
    totalCurrent: roundMoney(rawTotal - rawOverdue),
    averageDaysOverdue: rawOverdue === 0 ? 0 : Math.round(weighted / rawOverdue),
    oldest,
    truncated: options.truncated === true,
    invoiceCount: aged.length,
  }
}

/**
 * Clients ranked by what they owe, with their worst bucket. This is the
 * "who do I call first" list, so it sorts by overdue balance, then by how
 * long that balance has been outstanding.
 */
export interface AgingClientRow {
  clientId: string | null
  clientName: string
  outstanding: number
  overdue: number
  worstDays: number
  worstBucket: AgingBucketId
  invoiceCount: number
}

export function agingByClient(report: AgingReport, limit = 8): AgingClientRow[] {
  const raw = new Map<string, { row: AgingClientRow; rawOutstanding: number; rawOverdue: number }>()

  for (const invoice of report.invoices) {
    const key = invoice.clientId ?? `name:${invoice.clientName}`
    const entry = raw.get(key)
    if (!entry) {
      raw.set(key, {
        row: {
          clientId: invoice.clientId,
          clientName: invoice.clientName,
          outstanding: 0,
          overdue: 0,
          worstDays: invoice.daysPastDue,
          worstBucket: invoice.bucket,
          invoiceCount: 1,
        },
        rawOutstanding: invoice.balanceDue,
        rawOverdue: invoice.daysPastDue > 0 ? invoice.balanceDue : 0,
      })
      continue
    }
    entry.rawOutstanding += invoice.balanceDue
    if (invoice.daysPastDue > 0) entry.rawOverdue += invoice.balanceDue
    entry.row.invoiceCount += 1
    if (invoice.daysPastDue > entry.row.worstDays) {
      entry.row.worstDays = invoice.daysPastDue
      entry.row.worstBucket = invoice.bucket
    }
  }

  return [...raw.values()]
    .map(({ row, rawOutstanding, rawOverdue }) => ({
      ...row,
      outstanding: roundMoney(rawOutstanding),
      overdue: roundMoney(rawOverdue),
    }))
    .sort((a, b) => b.overdue - a.overdue || b.worstDays - a.worstDays || b.outstanding - a.outstanding)
    .slice(0, limit)
}
