'use client'

/**
 * Time summary for the range: hours logged, how much of it is billable, and
 * what is still sitting unbilled.
 *
 * Four numbers and one ratio, so this is a figure block with a meter rather
 * than a chart - a two-slice pie or a two-bar chart would just restate the
 * numbers beside it. The meter's track is a lighter step of the same blue, so
 * the ratio reads across the whole bar.
 *
 * Time entries carry no currency column of their own, so their value is stated
 * in the business's default currency and labelled as such.
 */

import Link from 'next/link'
import { Timer } from 'lucide-react'
import { EmptyState } from '@/components/shared/empty-state'
import { ReportCard } from '@/components/reports/report-card'
import { csvFilename, toCsv, withReportContext } from '@/lib/reports/csv'
import { formatHours, formatMoney, formatPercent } from '@/lib/reports/money'
import { buildTimeReport } from '@/lib/reports/metrics'
import type { ReportData } from '@/lib/reports/types'

export function TimeReport({ data }: { data: ReportData }) {
  const time = buildTimeReport(data)
  const currency = data.currency

  const csv = {
    filename: csvFilename('time-summary', data.range),
    build: () => {
      const rows = [
        { metric: 'Hours logged', value: time.totalHours },
        { metric: 'Billable hours', value: time.billableHours },
        { metric: 'Non-billable hours', value: time.nonBillableHours },
        { metric: 'Unbilled hours', value: time.unbilledHours },
        { metric: `Unbilled value (${currency})`, value: time.unbilledValue },
        { metric: `Billable value (${currency})`, value: time.billableValue },
        { metric: 'Billable rate (%)', value: Number(time.billableRate.toFixed(1)) },
        {
          metric: `Effective hourly rate (${currency})`,
          value: time.effectiveHourlyRate ?? '',
        },
      ]
      return withReportContext(
        toCsv(rows, [
          { header: 'Metric', value: (row) => row.metric },
          { header: 'Value', value: (row) => row.value },
        ]),
        { title: 'Time summary', range: data.range, currency }
      )
    },
  }

  if (time.entryCount === 0) {
    return (
      <ReportCard title="Time summary" description="Hours logged in this period, billable and not">
        <EmptyState
          icon={Timer}
          title="No time logged"
          description="Log hours against a client and this shows what is billable and what is still waiting to be invoiced."
          action={{ label: 'Track time', href: '/time' }}
          className="py-10"
        />
      </ReportCard>
    )
  }

  return (
    <ReportCard
      title="Time summary"
      description="Hours logged in this period, billable and not"
      csv={csv}
      footer={<span>Time values are shown in {currency}, the currency on the time entries&apos; rates.</span>}
    >
      <div className="space-y-5">
        <div>
          <div className="flex items-baseline justify-between">
            <p className="text-sm text-muted-foreground">Hours logged</p>
            <p className="text-sm tabular-nums text-muted-foreground">
              {formatPercent(time.billableRate)} billable
            </p>
          </div>
          <p className="mt-0.5 text-2xl font-semibold tracking-tight text-foreground">
            {formatHours(time.totalHours)}
          </p>
          <div
            className="mt-3 h-2.5 w-full overflow-hidden rounded-full"
            style={{ backgroundColor: 'var(--viz-age-1)' }}
            role="img"
            aria-label={`${formatHours(time.billableHours)} billable of ${formatHours(time.totalHours)} logged`}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(time.billableRate, 100)}%`,
                backgroundColor: 'var(--viz-series-1)',
              }}
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-2 w-2 rounded-[2px]"
                style={{ backgroundColor: 'var(--viz-series-1)' }}
              />
              Billable {formatHours(time.billableHours)}
            </span>
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-2 w-2 rounded-[2px]"
                style={{ backgroundColor: 'var(--viz-age-1)' }}
              />
              Non-billable {formatHours(time.nonBillableHours)}
            </span>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-4 border-t border-border pt-4">
          <div>
            <dt className="text-xs text-muted-foreground">Unbilled hours</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
              {formatHours(time.unbilledHours)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Unbilled value</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
              {formatMoney(time.unbilledValue, currency)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Billable value</dt>
            <dd className="mt-0.5 text-sm tabular-nums text-foreground">
              {formatMoney(time.billableValue, currency)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Effective rate</dt>
            <dd className="mt-0.5 text-sm tabular-nums text-foreground">
              {time.effectiveHourlyRate === null
                ? 'No billable hours'
                : `${formatMoney(time.effectiveHourlyRate, currency)}/h`}
            </dd>
          </div>
        </dl>

        {time.unbilledHours > 0 ? (
          <p className="text-sm text-muted-foreground">
            {formatHours(time.unbilledHours)} of billable time has not been invoiced yet.{' '}
            <Link href="/time" className="font-medium text-primary hover:underline">
              Review unbilled time
            </Link>
          </p>
        ) : null}
      </div>
    </ReportCard>
  )
}
