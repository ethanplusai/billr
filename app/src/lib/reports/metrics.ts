/**
 * Derived report figures: profit and loss, the revenue series, client
 * concentration, expense mix and the time summary. Pure - no React, no I/O.
 *
 * Every function here takes already-parsed ReportData (numbers, not database
 * strings) and returns display-ready numbers. Money is accumulated at full
 * precision and rounded once at the end of each total.
 */

import {
  computeDelta,
  minutesToHours,
  percentOf,
  roundMoney,
  type Delta,
} from '@/lib/reports/money'
import { formatBucketLabel, type BucketUnit } from '@/lib/reports/date-ranges'
import type { CategoryTotal, ClientTotal, ReportData } from '@/lib/reports/types'

/**
 * Accrual counts revenue when it is invoiced; cash counts it when the money
 * lands. Freelancers usually file cash-basis and plan accrual-basis, so the
 * page offers both rather than picking one and being wrong for half the users.
 */
export type PnlBasis = 'accrual' | 'cash'

const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  office: 'Office',
  travel: 'Travel',
  meals: 'Meals',
  supplies: 'Supplies',
  utilities: 'Utilities',
  software: 'Software',
  marketing: 'Marketing',
  professional: 'Professional services',
  insurance: 'Insurance',
  mileage: 'Mileage',
  other: 'Other',
}

export function expenseCategoryLabel(category: string): string {
  return EXPENSE_CATEGORY_LABELS[category] ?? category
}

interface PnlLine {
  category: string
  label: string
  amount: number
  /** Share of total expenses, 0-100. */
  share: number
  count: number
}

export interface PnlReport {
  basis: PnlBasis
  revenue: number
  expenses: number
  profit: number
  /** Profit as a share of revenue, 0-100. Null when there was no revenue. */
  margin: number | null
  previousRevenue: number
  previousExpenses: number
  previousProfit: number
  revenueDelta: Delta
  expensesDelta: Delta
  profitDelta: Delta
  lines: PnlLine[]
}

export function buildPnl(data: ReportData, basis: PnlBasis): PnlReport {
  const revenue = basis === 'cash' ? data.current.collected : data.current.invoiced
  const expenses = data.current.expenses
  const previousRevenue = basis === 'cash' ? data.previous.collected : data.previous.invoiced
  const previousExpenses = data.previous.expenses

  // Round the inputs (already period totals from Postgres) once, then take the
  // single subtraction. No intermediate rounding between the two.
  const profit = roundMoney(revenue - expenses)
  const previousProfit = roundMoney(previousRevenue - previousExpenses)

  const totalExpenses = expenses
  const lines: PnlLine[] = data.expensesByCategory
    .map((row: CategoryTotal) => ({
      category: row.category,
      label: expenseCategoryLabel(row.category),
      amount: roundMoney(row.amount),
      share: percentOf(row.amount, totalExpenses),
      count: row.count,
    }))
    .sort((a, b) => b.amount - a.amount)

  return {
    basis,
    revenue: roundMoney(revenue),
    expenses: roundMoney(expenses),
    profit,
    margin: revenue === 0 ? null : percentOf(profit, revenue),
    previousRevenue: roundMoney(previousRevenue),
    previousExpenses: roundMoney(previousExpenses),
    previousProfit,
    revenueDelta: computeDelta(revenue, previousRevenue),
    expensesDelta: computeDelta(expenses, previousExpenses),
    profitDelta: computeDelta(profit, previousProfit),
    lines,
  }
}

export interface RevenuePoint {
  key: string
  label: string
  invoiced: number
  collected: number
  expenses: number
  /** Same-index point from the comparison period, present only when comparing. */
  previousInvoiced?: number
  previousCollected?: number
  previousLabel?: string
}

/**
 * The revenue-over-time series. When comparison is on, the previous period's
 * buckets are aligned BY POSITION (first bucket to first bucket), not by date,
 * so a 30-day window compares day 1 to day 1 even when the months differ in
 * length. The previous bucket's own label rides along so the tooltip can name
 * the date it is actually showing rather than implying the dates match.
 */
export function buildRevenueSeries(data: ReportData, compare: boolean): RevenuePoint[] {
  const bucket: BucketUnit = data.bucket
  return data.series.map((point, index) => {
    const prev = compare ? data.previousSeries[index] : undefined
    return {
      key: point.bucketStart,
      label: formatBucketLabel(point.bucketStart, bucket),
      invoiced: roundMoney(point.invoiced),
      collected: roundMoney(point.collected),
      expenses: roundMoney(point.expenses),
      ...(prev
        ? {
            previousInvoiced: roundMoney(prev.invoiced),
            previousCollected: roundMoney(prev.collected),
            previousLabel: formatBucketLabel(prev.bucketStart, bucket),
          }
        : {}),
    }
  })
}

interface TopClientRow extends ClientTotal {
  /** Share of the period's total invoiced revenue, 0-100. */
  share: number
}

export interface TopClientsReport {
  rows: TopClientRow[]
  /** Total invoiced across ALL clients in the period, not just the listed ones. */
  totalInvoiced: number
  /** Share held by the single largest client, 0-100. The concentration risk figure. */
  topShare: number
  /** Share held by the top three, 0-100. */
  topThreeShare: number
}

export function buildTopClients(data: ReportData, limit = 8): TopClientsReport {
  const totalInvoiced = data.current.invoiced
  const rows = data.topClients
    .slice()
    .sort((a, b) => b.invoiced - a.invoiced)
    .slice(0, limit)
    .map((row) => ({
      ...row,
      invoiced: roundMoney(row.invoiced),
      paid: roundMoney(row.paid),
      outstanding: roundMoney(row.outstanding),
      share: percentOf(row.invoiced, totalInvoiced),
    }))

  let rawTopThree = 0
  for (const row of rows.slice(0, 3)) rawTopThree += row.invoiced

  return {
    rows,
    totalInvoiced: roundMoney(totalInvoiced),
    topShare: rows.length > 0 ? percentOf(rows[0].invoiced, totalInvoiced) : 0,
    topThreeShare: percentOf(roundMoney(rawTopThree), totalInvoiced),
  }
}

export interface TimeReport {
  totalHours: number
  billableHours: number
  nonBillableHours: number
  unbilledHours: number
  unbilledValue: number
  billableValue: number
  /** Billable share of logged hours, 0-100. */
  billableRate: number
  entryCount: number
  /** Effective rate on billable time, or null when no billable hours were logged. */
  effectiveHourlyRate: number | null
}

export function buildTimeReport(data: ReportData): TimeReport {
  const t = data.time
  const billableHours = minutesToHours(t.billableMinutes)
  return {
    totalHours: minutesToHours(t.totalMinutes),
    billableHours,
    nonBillableHours: minutesToHours(t.nonBillableMinutes),
    unbilledHours: minutesToHours(t.unbilledMinutes),
    unbilledValue: roundMoney(t.unbilledValue),
    billableValue: roundMoney(t.billableValue),
    billableRate: percentOf(t.billableMinutes, t.totalMinutes),
    entryCount: t.entryCount,
    effectiveHourlyRate: billableHours === 0 ? null : roundMoney(t.billableValue / billableHours),
  }
}

export interface ExpenseSlice {
  category: string
  label: string
  amount: number
  share: number
  count: number
}

/**
 * Expense mix, capped at `limit` slices with the tail folded into "Other".
 * The cap is a color rule as much as a layout one: past the palette's slots a
 * chart starts inventing hues that are indistinguishable under colour-vision
 * deficiency, so the tail folds instead.
 */
export function buildExpenseBreakdown(data: ReportData, limit = 6): ExpenseSlice[] {
  const total = data.current.expenses
  const sorted = data.expensesByCategory.slice().sort((a, b) => b.amount - a.amount)
  if (sorted.length <= limit) {
    return sorted.map((row) => ({
      category: row.category,
      label: expenseCategoryLabel(row.category),
      amount: roundMoney(row.amount),
      share: percentOf(row.amount, total),
      count: row.count,
    }))
  }

  const head = sorted.slice(0, limit - 1)
  const tail = sorted.slice(limit - 1)
  let rawTail = 0
  let tailCount = 0
  for (const row of tail) {
    rawTail += row.amount
    tailCount += row.count
  }
  const tailAmount = roundMoney(rawTail)

  return [
    ...head.map((row) => ({
      category: row.category,
      label: expenseCategoryLabel(row.category),
      amount: roundMoney(row.amount),
      share: percentOf(row.amount, total),
      count: row.count,
    })),
    {
      category: '__other__',
      label: `Other (${tail.length} categories)`,
      amount: tailAmount,
      share: percentOf(tailAmount, total),
      count: tailCount,
    },
  ]
}

export interface HeadlineStat {
  id: 'collected' | 'invoiced' | 'outstanding' | 'profit'
  label: string
  value: number
  delta: Delta | null
  /** Whether an increase is a good thing, so the delta can be coloured honestly. */
  upIsGood: boolean
}

export function buildHeadlineStats(
  data: ReportData,
  outstanding: number,
  basis: PnlBasis,
  compare: boolean
): HeadlineStat[] {
  const pnl = buildPnl(data, basis)
  return [
    {
      id: 'collected',
      label: 'Collected',
      value: roundMoney(data.current.collected),
      delta: compare ? computeDelta(data.current.collected, data.previous.collected) : null,
      upIsGood: true,
    },
    {
      id: 'invoiced',
      label: 'Invoiced',
      value: roundMoney(data.current.invoiced),
      delta: compare ? computeDelta(data.current.invoiced, data.previous.invoiced) : null,
      upIsGood: true,
    },
    {
      id: 'outstanding',
      label: 'Outstanding',
      value: roundMoney(outstanding),
      delta: null,
      upIsGood: false,
    },
    {
      id: 'profit',
      label: basis === 'cash' ? 'Profit (cash)' : 'Profit (accrual)',
      value: pnl.profit,
      delta: compare ? pnl.profitDelta : null,
      upIsGood: true,
    },
  ]
}
