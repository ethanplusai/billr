'use client'

/**
 * Profit and loss for the selected range.
 *
 * This one is deliberately NOT a chart. A P&L is a statement: a reader wants
 * the exact figures, line by line, and a chart of "revenue, expenses, profit"
 * is three bars restating three numbers. The chart of the same data over time
 * already exists above, in Revenue over time.
 *
 * The basis switch is the honest part. Accrual counts revenue when it is
 * invoiced, cash when the money lands; freelancers usually file cash-basis and
 * plan accrual-basis, so the page offers both rather than quietly picking one.
 */

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ReportCard } from '@/components/reports/report-card'
import { csvFilename, toCsv, withReportContext } from '@/lib/reports/csv'
import { formatMoney, formatPercent } from '@/lib/reports/money'
import type { Delta } from '@/lib/reports/money'
import { buildPnl, type PnlBasis } from '@/lib/reports/metrics'
import type { ReportData } from '@/lib/reports/types'

export function PnlReport({
  data,
  basis,
  onBasisChange,
  compare,
}: {
  data: ReportData
  basis: PnlBasis
  onBasisChange: (basis: PnlBasis) => void
  compare: boolean
}) {
  const pnl = buildPnl(data, basis)
  const currency = data.currency

  const csv = {
    filename: csvFilename(`profit-and-loss-${basis}`, data.range),
    build: () => {
      const rows: { line: string; amount: number; previous: number | null }[] = [
        { line: basis === 'cash' ? 'Revenue (collected)' : 'Revenue (invoiced)', amount: pnl.revenue, previous: pnl.previousRevenue },
        ...pnl.lines.map((line) => ({ line: `Expense: ${line.label}`, amount: -line.amount, previous: null })),
        { line: 'Total expenses', amount: -pnl.expenses, previous: -pnl.previousExpenses },
        { line: 'Net profit', amount: pnl.profit, previous: pnl.previousProfit },
      ]
      return withReportContext(
        toCsv(rows, [
          { header: 'Line', value: (row) => row.line },
          { header: `Amount (${currency})`, value: (row) => row.amount },
          ...(compare
            ? [{ header: `Previous period (${currency})`, value: (row: (typeof rows)[number]) => row.previous ?? '' }]
            : []),
        ]),
        {
          title: `Profit and loss (${basis} basis)`,
          range: data.range,
          currency,
        }
      )
    },
  }

  return (
    <ReportCard
      title="Profit and loss"
      description={
        basis === 'cash'
          ? 'Money collected minus money spent in this period'
          : 'Revenue invoiced minus money spent in this period'
      }
      csv={csv}
      headerExtra={
        <div role="group" aria-label="Accounting basis" className="flex items-center rounded-md border border-border p-0.5">
          <BasisButton active={basis === 'accrual'} onClick={() => onBasisChange('accrual')}>
            Accrual
          </BasisButton>
          <BasisButton active={basis === 'cash'} onClick={() => onBasisChange('cash')}>
            Cash
          </BasisButton>
        </div>
      }
      footer={
        <span>
          {basis === 'cash'
            ? 'Cash basis: revenue counted on the payment date.'
            : 'Accrual basis: revenue counted on the invoice issue date.'}{' '}
          Expenses are counted on their expense date in both.
        </span>
      }
    >
      <dl className="divide-y divide-border">
        <StatementRow
          label={basis === 'cash' ? 'Revenue collected' : 'Revenue invoiced'}
          amount={pnl.revenue}
          currency={currency}
          delta={compare ? pnl.revenueDelta : null}
          emphasis
        />

        {pnl.lines.length > 0 ? (
          <div className="py-3">
            <p className="text-sm font-medium text-foreground">Expenses</p>
            <ul className="mt-2 space-y-1.5">
              {pnl.lines.map((line) => (
                <li key={line.category} className="flex items-baseline gap-3 text-sm">
                  <span className="text-muted-foreground">{line.label}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formatPercent(line.share)}
                  </span>
                  <span className="ml-auto tabular-nums text-foreground">
                    {formatMoney(line.amount, currency)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <StatementRow
          label="Total expenses"
          amount={pnl.expenses}
          currency={currency}
          delta={compare ? pnl.expensesDelta : null}
          deltaUpIsGood={false}
        />

        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-4">
          <dt className="text-base font-semibold text-foreground">Net profit</dt>
          {pnl.margin !== null ? (
            <dd className="text-xs text-muted-foreground tabular-nums">
              {formatPercent(pnl.margin, 1)} margin
            </dd>
          ) : null}
          <dd
            className={cn(
              'ml-auto text-2xl font-semibold tracking-tight',
              pnl.profit < 0 ? 'text-destructive' : 'text-foreground'
            )}
          >
            {formatMoney(pnl.profit, currency)}
          </dd>
          {compare ? (
            <dd className="w-full text-right text-xs text-muted-foreground tabular-nums">
              Previous period {formatMoney(pnl.previousProfit, currency)}
            </dd>
          ) : null}
        </div>
      </dl>
    </ReportCard>
  )
}

function StatementRow({
  label,
  amount,
  currency,
  delta,
  emphasis,
  deltaUpIsGood = true,
}: {
  label: string
  amount: number
  currency: string
  delta: Delta | null
  emphasis?: boolean
  deltaUpIsGood?: boolean
}) {
  const good = delta === null || delta.direction === 'flat' ? null : (delta.direction === 'up') === deltaUpIsGood
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 py-3">
      <dt className={cn('text-sm', emphasis ? 'font-medium text-foreground' : 'text-foreground')}>{label}</dt>
      {delta ? (
        <dd
          className={cn(
            'text-xs tabular-nums',
            good === null ? 'text-muted-foreground' : good ? 'text-[color:var(--success)]' : 'text-destructive'
          )}
        >
          {delta.percent === null
            ? `${delta.absolute >= 0 ? '+' : ''}${formatMoney(delta.absolute, currency)}`
            : `${delta.percent >= 0 ? '+' : ''}${delta.percent.toFixed(1)}%`}{' '}
          vs previous
        </dd>
      ) : null}
      <dd className="ml-auto text-sm font-medium tabular-nums text-foreground">
        {formatMoney(amount, currency)}
      </dd>
    </div>
  )
}

function BasisButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      aria-pressed={active}
      className={cn('h-7 px-2 text-xs', active ? 'bg-secondary text-foreground' : 'text-muted-foreground')}
    >
      {children}
    </Button>
  )
}
