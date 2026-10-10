'use client'

/**
 * Reports.
 *
 * Composition only: the filter row, the KPI band, and each report section.
 * Every figure on this page comes from one RPC call scoped to the active
 * business (see components/reports/use-report-data.ts), and every calculation
 * lives in lib/reports as a pure, tested function.
 *
 * Reading order is deliberate. The KPI band answers "how am I doing", then AR
 * aging comes FIRST among the sections because chasing payment is the thing a
 * freelancer opens this page to do; the trend, the P&L, the client mix, the
 * expense mix and the time summary follow.
 */

import { useMemo, useState } from 'react'
import { BarChart3, Receipt, Users } from 'lucide-react'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { useBusiness } from '@/lib/hooks/use-business'
import { cn } from '@/lib/utils'
import {
  chooseBucket,
  formatRangeLabel,
  isValidRange,
  previousRange as previousRangeFor,
  resolveRange,
  todayISO,
  type RangePresetId,
  type ReportRange,
} from '@/lib/reports/date-ranges'
import { buildAgingReport } from '@/lib/reports/aging'
import { buildExpenseBreakdown, buildHeadlineStats, buildTopClients, type PnlBasis } from '@/lib/reports/metrics'
import { SERIES_COLORS } from '@/lib/reports/palette'
import { isReportEmpty } from '@/lib/reports/types'
import { VizScope } from '@/components/reports/chart-theme'
import { ReportFilters } from '@/components/reports/report-filters'
import { ReportStats } from '@/components/reports/report-stats'
import { RevenueChart } from '@/components/reports/revenue-chart'
import { AgingReport } from '@/components/reports/aging-report'
import { PnlReport } from '@/components/reports/pnl-report'
import { RankedBarReport } from '@/components/reports/ranked-bar-report'
import { TimeReport } from '@/components/reports/time-report'
import { useReportData } from '@/components/reports/use-report-data'

const BUCKET_NOUNS: Record<string, string> = { day: 'Day', week: 'Week', month: 'Month' }

export default function ReportsPage() {
  const { currentBusiness, isLoading: businessLoading } = useBusiness()

  // Pinned at mount so "today" cannot drift mid-session and silently move a
  // range between renders.
  const [today] = useState(() => new Date())
  const [preset, setPreset] = useState<RangePresetId>('last_12_months')
  const [customRange, setCustomRange] = useState<ReportRange>(() => resolveRange('this_month', today))
  const [compare, setCompare] = useState(true)
  const [basis, setBasis] = useState<PnlBasis>('accrual')
  const [currency, setCurrency] = useState<string | null>(null)

  const range = useMemo(() => {
    const resolved = resolveRange(preset, today, customRange)
    return isValidRange(resolved) ? resolved : resolveRange('this_month', today)
  }, [preset, today, customRange])

  const comparisonRange = useMemo(
    () => (compare ? previousRangeFor(range, preset) : null),
    [compare, range, preset]
  )
  const bucket = useMemo(() => chooseBucket(range), [range])

  const { data, isLoading, isRefreshing, error, refresh } = useReportData({
    range,
    previousRange: comparisonRange,
    bucket,
    currency,
  })

  const asOf = todayISO(today)

  const aging = useMemo(
    () =>
      data
        ? buildAgingReport(data.openInvoices, asOf, data.currency, {
            truncated: data.openInvoiceCount > data.openInvoices.length,
          })
        : null,
    [data, asOf]
  )

  const stats = useMemo(
    () => (data && aging ? buildHeadlineStats(data, aging.totalOutstanding, basis, compare) : []),
    [data, aging, basis, compare]
  )

  const topClients = useMemo(() => (data ? buildTopClients(data) : null), [data])
  const expenseSlices = useMemo(() => (data ? buildExpenseBreakdown(data) : []), [data])

  if (businessLoading) {
    return <ReportsSkeleton />
  }

  if (!currentBusiness) {
    return (
      <div className="p-6 lg:p-8">
        <PageHeader title="Reports" description="Revenue, receivables, profit and time" />
        <Card className="mt-8">
          <EmptyState
            icon={BarChart3}
            title="No business yet"
            description="Create a business to start seeing revenue, receivables and profit reports."
            action={{ label: 'Go to settings', href: '/settings' }}
          />
        </Card>
      </div>
    )
  }

  return (
    <VizScope className="p-6 lg:p-8">
      <PageHeader
        title="Reports"
        description={`Revenue, receivables, profit and time for ${currentBusiness.name}`}
      />

      <div className="mt-6">
        <ReportFilters
          preset={preset}
          onPresetChange={setPreset}
          range={range}
          customRange={customRange}
          onCustomRangeChange={setCustomRange}
          previousRange={comparisonRange}
          compare={compare}
          onCompareChange={setCompare}
          currency={data?.currency ?? currentBusiness.default_currency ?? 'USD'}
          currencies={data?.currencies ?? []}
          onCurrencyChange={setCurrency}
          onRefresh={refresh}
          isRefreshing={isRefreshing}
        />
      </div>

      {error ? (
        <Card className="mt-6">
          <EmptyState
            icon={BarChart3}
            title="Reports did not load"
            description={error}
          />
          <div className="flex justify-center pb-6">
            <Button onClick={refresh}>Try again</Button>
          </div>
        </Card>
      ) : isLoading || !data || !aging || !topClients ? (
        <ReportsSkeleton withHeader={false} />
      ) : isReportEmpty(data) && aging.invoiceCount === 0 ? (
        <Card className="mt-6">
          <EmptyState
            icon={BarChart3}
            title="Nothing to report yet"
            description={`No invoices, payments, expenses or time in ${formatRangeLabel(range)}. Send your first invoice and the numbers land here.`}
            action={{ label: 'Create an invoice', href: '/invoices/new' }}
            className="py-16"
          />
        </Card>
      ) : (
        // Refetches hold the previous render at reduced opacity rather than
        // flashing a skeleton, so nothing jumps while the range changes.
        <div className={cn('mt-6 space-y-6 transition-opacity', isRefreshing && 'opacity-60')}>
          <ReportStats
            stats={stats}
            currency={data.currency}
            comparisonLabel={compare ? 'vs previous period' : null}
          />

          <AgingReport data={data} report={aging} asOf={asOf} />

          <RevenueChart data={data} compare={compare} bucketNoun={BUCKET_NOUNS[data.bucket] ?? 'Period'} />

          <div className="grid gap-6 lg:grid-cols-2">
            <PnlReport data={data} basis={basis} onBasisChange={setBasis} compare={compare} />
            <TimeReport data={data} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <RankedBarReport
              title="Top clients"
              description="Revenue invoiced in this period, and each client's share"
              slug="top-clients"
              rows={topClients.rows.map((row) => ({
                key: row.clientId || row.clientName,
                label: row.clientName,
                amount: row.invoiced,
                share: row.share,
                secondary: `${row.invoiceCount} ${row.invoiceCount === 1 ? 'invoice' : 'invoices'}`,
                href: row.clientId ? `/clients/${row.clientId}` : undefined,
              }))}
              currency={data.currency}
              range={data.range}
              color={SERIES_COLORS.invoiced}
              amountLabel="Invoiced"
              shareLabel="Share of revenue"
              categoryLabel="Client"
              emptyIcon={Users}
              emptyTitle="No client revenue yet"
              emptyDescription="Invoice a client in this period and they show up here, ranked by revenue."
              footer={
                topClients.rows.length > 0 ? (
                  <span>
                    {topClients.rows[0].clientName} accounts for {topClients.topShare.toFixed(0)}% of revenue
                    in this range; the top three account for {topClients.topThreeShare.toFixed(0)}%.
                  </span>
                ) : undefined
              }
            />

            <RankedBarReport
              title="Expenses by category"
              description="Where the money went in this period"
              slug="expenses-by-category"
              rows={expenseSlices.map((slice) => ({
                key: slice.category,
                label: slice.label,
                amount: slice.amount,
                share: slice.share,
                secondary: `${slice.count} ${slice.count === 1 ? 'expense' : 'expenses'}`,
              }))}
              currency={data.currency}
              range={data.range}
              color={SERIES_COLORS.expenses}
              amountLabel="Spent"
              shareLabel="Share of expenses"
              categoryLabel="Category"
              emptyIcon={Receipt}
              emptyTitle="No expenses recorded"
              emptyDescription="Log an expense and this breaks your spending down by category."
            />
          </div>
        </div>
      )}
    </VizScope>
  )
}

function ReportsSkeleton({ withHeader = true }: { withHeader?: boolean }) {
  return (
    <div className={withHeader ? 'p-6 lg:p-8' : 'mt-6'}>
      {withHeader ? (
        <>
          <Skeleton className="h-8 w-40" />
          <Skeleton className="mt-2 h-4 w-72" />
        </>
      ) : null}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="mt-6 h-80 w-full rounded-xl" />
      <Skeleton className="mt-6 h-72 w-full rounded-xl" />
    </div>
  )
}
