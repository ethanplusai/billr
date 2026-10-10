/**
 * Shapes the reports layer works with, plus the coercion boundary between the
 * database and the calculations.
 *
 * Everything the RPC returns arrives as JSON, and DECIMAL columns arrive as
 * strings once they leave PostgREST's numeric handling, so nothing below is
 * trusted to already be a number: parseReportPayload is the single place where
 * raw values become numbers, and every field goes through toNumber().
 */

import { toNumber } from '@/lib/reports/money'
import type { BucketUnit, ReportRange } from '@/lib/reports/date-ranges'

interface PeriodTotals {
  invoiced: number
  invoicedPaid: number
  collected: number
  expenses: number
  invoiceCount: number
  paymentCount: number
  expenseCount: number
}

interface SeriesPoint {
  bucketStart: string
  invoiced: number
  collected: number
  expenses: number
}

export interface CategoryTotal {
  category: string
  amount: number
  count: number
}

interface StatusTotal {
  status: string
  amount: number
  balanceDue: number
  count: number
}

export interface ClientTotal {
  clientId: string
  clientName: string
  invoiced: number
  paid: number
  outstanding: number
  invoiceCount: number
}

interface TimeTotals {
  totalMinutes: number
  billableMinutes: number
  nonBillableMinutes: number
  unbilledMinutes: number
  unbilledValue: number
  billableValue: number
  entryCount: number
}

export interface OpenInvoice {
  id: string
  publicId: string | null
  invoiceNumber: string
  status: string
  issueDate: string
  dueDate: string
  total: number
  balanceDue: number
  currency: string
  clientId: string | null
  clientName: string
  clientEmail: string | null
}

export interface CurrencyCount {
  code: string
  count: number
}

export interface ReportData {
  currency: string
  bucket: BucketUnit
  range: ReportRange
  previousRange: ReportRange | null
  current: PeriodTotals
  previous: PeriodTotals
  series: SeriesPoint[]
  previousSeries: { bucketStart: string; invoiced: number; collected: number }[]
  expensesByCategory: CategoryTotal[]
  invoicesByStatus: StatusTotal[]
  topClients: ClientTotal[]
  time: TimeTotals
  openInvoices: OpenInvoice[]
  /** Total open invoices in the database, which may exceed openInvoices.length. */
  openInvoiceCount: number
  /** Cap the RPC applied to openInvoices. */
  openInvoiceLimit: number
  currencies: CurrencyCount[]
}

const EMPTY_TOTALS: PeriodTotals = {
  invoiced: 0,
  invoicedPaid: 0,
  collected: 0,
  expenses: 0,
  invoiceCount: 0,
  paymentCount: 0,
  expenseCount: 0,
}

type Raw = Record<string, unknown>

function asRecord(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {}
}

function asArray(value: unknown): Raw[] {
  return Array.isArray(value) ? value.map(asRecord) : []
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function totalsFrom(value: unknown): PeriodTotals {
  const raw = asRecord(value)
  if (Object.keys(raw).length === 0) return { ...EMPTY_TOTALS }
  return {
    invoiced: toNumber(raw.invoiced),
    invoicedPaid: toNumber(raw.invoiced_paid),
    collected: toNumber(raw.collected),
    expenses: toNumber(raw.expenses),
    invoiceCount: toNumber(raw.invoice_count),
    paymentCount: toNumber(raw.payment_count),
    expenseCount: toNumber(raw.expense_count),
  }
}

function rangeFrom(value: unknown): ReportRange | null {
  const raw = asRecord(value)
  const start = asString(raw.start)
  const end = asString(raw.end)
  return start && end ? { start, end } : null
}

/**
 * Turns the get_report_summary JSON document into typed, numeric report data.
 * Tolerates missing sections so a partial or older payload renders as zeros
 * rather than throwing on a dashboard.
 */
export function parseReportPayload(payload: unknown, fallbackRange: ReportRange): ReportData {
  const raw = asRecord(payload)
  const totals = asRecord(raw.totals)

  return {
    currency: asString(raw.currency, 'USD'),
    bucket: (asString(raw.bucket, 'month') as BucketUnit) || 'month',
    range: rangeFrom(raw.range) ?? fallbackRange,
    previousRange: rangeFrom(raw.previous_range),
    current: totalsFrom(totals.current),
    previous: totalsFrom(totals.previous),
    series: asArray(raw.series).map((row) => ({
      bucketStart: asString(row.bucket_start),
      invoiced: toNumber(row.invoiced),
      collected: toNumber(row.collected),
      expenses: toNumber(row.expenses),
    })),
    previousSeries: asArray(raw.previous_series).map((row) => ({
      bucketStart: asString(row.bucket_start),
      invoiced: toNumber(row.invoiced),
      collected: toNumber(row.collected),
    })),
    expensesByCategory: asArray(raw.expenses_by_category).map((row) => ({
      category: asString(row.category, 'other'),
      amount: toNumber(row.amount),
      count: toNumber(row.count),
    })),
    invoicesByStatus: asArray(raw.invoices_by_status).map((row) => ({
      status: asString(row.status),
      amount: toNumber(row.amount),
      balanceDue: toNumber(row.balance_due),
      count: toNumber(row.count),
    })),
    topClients: asArray(raw.top_clients).map((row) => ({
      clientId: asString(row.client_id),
      clientName: asString(row.client_name, 'Unnamed client'),
      invoiced: toNumber(row.invoiced),
      paid: toNumber(row.paid),
      outstanding: toNumber(row.outstanding),
      invoiceCount: toNumber(row.invoice_count),
    })),
    time: {
      totalMinutes: toNumber(asRecord(raw.time).total_minutes),
      billableMinutes: toNumber(asRecord(raw.time).billable_minutes),
      nonBillableMinutes: toNumber(asRecord(raw.time).non_billable_minutes),
      unbilledMinutes: toNumber(asRecord(raw.time).unbilled_minutes),
      unbilledValue: toNumber(asRecord(raw.time).unbilled_value),
      billableValue: toNumber(asRecord(raw.time).billable_value),
      entryCount: toNumber(asRecord(raw.time).entry_count),
    },
    openInvoices: asArray(raw.open_invoices).map((row) => ({
      id: asString(row.id),
      publicId: typeof row.public_id === 'string' ? row.public_id : null,
      invoiceNumber: asString(row.invoice_number, '-'),
      status: asString(row.status, 'sent'),
      issueDate: asString(row.issue_date),
      dueDate: asString(row.due_date),
      total: toNumber(row.total),
      balanceDue: toNumber(row.balance_due),
      currency: asString(row.currency, asString(raw.currency, 'USD')),
      clientId: typeof row.client_id === 'string' ? row.client_id : null,
      clientName: asString(row.client_name, 'Unknown client'),
      clientEmail: typeof row.client_email === 'string' ? row.client_email : null,
    })),
    openInvoiceCount: toNumber(raw.open_invoice_count),
    openInvoiceLimit: toNumber(raw.open_invoice_limit) || 500,
    currencies: asArray(raw.currencies).map((row) => ({
      code: asString(row.code, 'USD'),
      count: toNumber(row.count),
    })),
  }
}

/** True when the business has no reportable activity at all in this payload. */
export function isReportEmpty(data: ReportData): boolean {
  return (
    data.current.invoiceCount === 0 &&
    data.current.paymentCount === 0 &&
    data.current.expenseCount === 0 &&
    data.time.entryCount === 0 &&
    data.openInvoices.length === 0
  )
}
