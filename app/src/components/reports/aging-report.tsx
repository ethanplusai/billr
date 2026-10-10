'use client'

/**
 * Accounts-receivable aging - the report someone actually acts on.
 *
 * It answers three questions in order: how much is late, how late, and who do
 * I call. So the card leads with the overdue figure, charts the buckets as a
 * horizontal bar (five ordered bands with long names read better lying down),
 * and every bucket drills into the invoices behind it.
 *
 * Colour: the bands are an ORDINAL ramp, one hue deepening with age, because
 * age has a natural order. "Not yet due" sits outside the ramp in the
 * de-emphasis grey - it is context, not a stage of lateness. Every bar is also
 * directly labelled with its amount, so nothing here is encoded by colour
 * alone.
 */

import { useState } from 'react'
import Link from 'next/link'
import { Bar, BarChart, Cell, LabelList, XAxis, YAxis } from 'recharts'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/empty-state'
import { cn } from '@/lib/utils'
import {
  MAX_BAR_SIZE,
  moneyLabelFormatter,
  useReducedMotion,
  VizFrame,
  VizGrid,
  VizTooltip,
  VizTooltipCard,
} from '@/components/reports/chart-theme'
import { ReportCard, ReportTable } from '@/components/reports/report-card'
import { csvFilename, toCsv, withReportContext } from '@/lib/reports/csv'
import { formatMoney, formatMoneyCompact, formatPercent } from '@/lib/reports/money'
import { AGING_COLORS } from '@/lib/reports/palette'
import {
  agingByClient,
  type AgedInvoice,
  type AgingBucketId,
  type AgingReport as AgingReportData,
} from '@/lib/reports/aging'
import { formatBucketLabel } from '@/lib/reports/date-ranges'
import type { ReportData } from '@/lib/reports/types'

const HORIZONTAL_RADIUS: [number, number, number, number] = [0, 4, 4, 0]

export function AgingReport({
  data,
  report,
  asOf,
}: {
  data: ReportData
  /** Built once by the page so the KPI row and this card cannot disagree. */
  report: AgingReportData
  asOf: string
}) {
  const reduced = useReducedMotion()
  const [selected, setSelected] = useState<AgingBucketId | 'all'>('all')

  const currency = data.currency

  const chartRows = report.buckets.map((bucket) => ({
    id: bucket.id,
    label: bucket.short,
    full: bucket.label,
    description: bucket.description,
    amount: bucket.amount,
    count: bucket.count,
    share: bucket.share,
  }))

  const visible =
    selected === 'all' ? report.invoices : report.buckets.find((b) => b.id === selected)?.invoices ?? []

  const clients = agingByClient(report)

  const csv = {
    filename: csvFilename('ar-aging', data.range),
    build: () =>
      withReportContext(
        toCsv(report.invoices, [
          { header: 'Invoice', value: (row: AgedInvoice) => row.invoiceNumber },
          { header: 'Client', value: (row: AgedInvoice) => row.clientName },
          { header: 'Client email', value: (row: AgedInvoice) => row.clientEmail ?? '' },
          { header: 'Status', value: (row: AgedInvoice) => row.status },
          { header: 'Issued', value: (row: AgedInvoice) => row.issueDate },
          { header: 'Due', value: (row: AgedInvoice) => row.dueDate },
          { header: 'Days past due', value: (row: AgedInvoice) => row.daysPastDue },
          {
            header: 'Bucket',
            value: (row: AgedInvoice) => report.buckets.find((b) => b.id === row.bucket)?.label ?? '',
          },
          { header: `Invoice total (${currency})`, value: (row: AgedInvoice) => row.total },
          { header: `Balance due (${currency})`, value: (row: AgedInvoice) => row.balanceDue },
        ]),
        {
          title: 'Accounts receivable aging',
          range: data.range,
          currency,
          note: `As of ${asOf}${report.truncated ? `; capped at ${data.openInvoices.length} of ${data.openInvoiceCount} open invoices` : ''}`,
        }
      ),
  }

  const table = (
    <ReportTable
      caption="Receivable balance by aging bucket"
      columns={[
        { key: 'bucket', label: 'Bucket' },
        { key: 'invoices', label: 'Invoices', align: 'right' },
        { key: 'amount', label: 'Balance', align: 'right' },
        { key: 'share', label: 'Share', align: 'right' },
      ]}
    >
      {report.buckets.map((bucket) => (
        <tr key={bucket.id} className="border-b border-border/60 last:border-0">
          <th scope="row" className="px-2 py-1.5 text-left font-normal text-foreground">
            {bucket.label}
          </th>
          <td className="px-2 py-1.5 text-right tabular-nums">{bucket.count}</td>
          <td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(bucket.amount, currency)}</td>
          <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
            {formatPercent(bucket.share)}
          </td>
        </tr>
      ))}
      <tr className="border-t border-border font-medium">
        <th scope="row" className="px-2 py-1.5 text-left">
          Total outstanding
        </th>
        <td className="px-2 py-1.5 text-right tabular-nums">{report.invoiceCount}</td>
        <td className="px-2 py-1.5 text-right tabular-nums">
          {formatMoney(report.totalOutstanding, currency)}
        </td>
        <td className="px-2 py-1.5 text-right" />
      </tr>
    </ReportTable>
  )

  if (report.invoiceCount === 0) {
    return (
      <ReportCard
        title="Accounts receivable aging"
        description="Every open invoice, sorted by how late it is"
      >
        <EmptyState
          icon={CheckCircle2}
          title="Nothing outstanding"
          description="No open invoices right now. When one is waiting on payment, it appears here with its age."
          className="py-10"
        />
      </ReportCard>
    )
  }

  return (
    <ReportCard
      title="Accounts receivable aging"
      description="Every open invoice, sorted by how late it is"
      csv={csv}
      table={table}
      footer={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>As of {formatBucketLabel(asOf, 'day')}. Aging ignores the date range above.</span>
          {report.truncated ? (
            <span className="text-warning">
              Showing the {data.openInvoices.length} oldest of {data.openInvoiceCount} open invoices, so
              these totals are a floor.
            </span>
          ) : null}
        </div>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
        <div className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground">Overdue</p>
            <p className="mt-0.5 text-3xl font-semibold tracking-tight text-foreground">
              {formatMoney(report.totalOverdue, currency)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              of {formatMoney(report.totalOutstanding, currency)} outstanding across {report.invoiceCount}{' '}
              {report.invoiceCount === 1 ? 'invoice' : 'invoices'}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Average days late</dt>
              <dd className="mt-0.5 font-medium tabular-nums text-foreground">
                {report.averageDaysOverdue}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Oldest</dt>
              <dd className="mt-0.5 font-medium tabular-nums text-foreground">
                {report.oldest ? `${report.oldest.daysPastDue}d` : 'None late'}
              </dd>
            </div>
          </dl>
          {report.oldest ? (
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-hidden />
                Chase first
              </p>
              <Link
                href={`/invoices/${report.oldest.id}`}
                className="mt-1 block text-sm font-medium text-primary hover:underline"
              >
                {report.oldest.invoiceNumber}
              </Link>
              <p className="text-xs text-muted-foreground">
                {report.oldest.clientName} owes {formatMoney(report.oldest.balanceDue, currency)},{' '}
                {report.oldest.daysPastDue} days past due
              </p>
            </div>
          ) : null}
        </div>

        <div className="min-w-0">
          <VizFrame
            height={220}
            label={`Horizontal bar chart of open receivable balance by aging bucket in ${currency}`}
          >
            <BarChart
              data={chartRows}
              layout="vertical"
              margin={{ top: 4, right: 72, bottom: 4, left: 8 }}
              onClick={(state) => {
                const index = typeof state?.activeIndex === 'number' ? state.activeIndex : Number(state?.activeIndex)
                const row = Number.isInteger(index) ? chartRows[index] : undefined
                if (row) setSelected((current) => (current === row.id ? 'all' : row.id))
              }}
            >
              <VizGrid horizontal={false} vertical />
              <XAxis
                type="number"
                tick={{ fontSize: 12, fill: 'var(--viz-axis)' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value: number) => formatMoneyCompact(value, currency)}
              />
              <YAxis
                type="category"
                dataKey="label"
                tick={{ fontSize: 12, fill: 'var(--viz-axis)' }}
                tickLine={false}
                axisLine={false}
                width={56}
              />
              <VizTooltip
                render={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const row = payload[0]?.payload as (typeof chartRows)[number] | undefined
                  if (!row) return null
                  return (
                    <VizTooltipCard
                      title={row.full}
                      rows={[
                        {
                          key: 'amount',
                          name: `${row.count} ${row.count === 1 ? 'invoice' : 'invoices'}`,
                          value: formatMoney(row.amount, currency),
                          color: AGING_COLORS[row.id],
                        },
                      ]}
                      note={`${formatPercent(row.share)} of everything outstanding`}
                    />
                  )
                }}
              />
              <Bar
                dataKey="amount"
                radius={HORIZONTAL_RADIUS}
                maxBarSize={MAX_BAR_SIZE}
                isAnimationActive={!reduced}
              >
                {chartRows.map((row) => (
                  <Cell
                    key={row.id}
                    fill={AGING_COLORS[row.id]}
                    fillOpacity={selected === 'all' || selected === row.id ? 1 : 0.35}
                  />
                ))}
                <LabelList
                  dataKey="amount"
                  position="right"
                  offset={8}
                  className="fill-foreground"
                  fontSize={12}
                  formatter={moneyLabelFormatter((value) => formatMoneyCompact(value, currency))}
                />
              </Bar>
            </BarChart>
          </VizFrame>

          <div className="mt-2 flex flex-wrap gap-1.5">
            <BucketChip active={selected === 'all'} onClick={() => setSelected('all')}>
              All open ({report.invoiceCount})
            </BucketChip>
            {report.buckets
              .filter((bucket) => bucket.count > 0)
              .map((bucket) => (
                <BucketChip
                  key={bucket.id}
                  active={selected === bucket.id}
                  color={AGING_COLORS[bucket.id]}
                  onClick={() => setSelected(bucket.id)}
                >
                  {bucket.label} ({bucket.count})
                </BucketChip>
              ))}
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">
            {selected === 'all'
              ? 'Open invoices'
              : report.buckets.find((b) => b.id === selected)?.label}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {visible.length} {visible.length === 1 ? 'invoice' : 'invoices'}, oldest first
          </p>
          <div className="mt-3 max-h-80 overflow-y-auto overflow-x-hidden px-2">
            <ReportTable
              caption="Open invoices in the selected aging bucket"
              columns={[
                { key: 'invoice', label: 'Invoice' },
                { key: 'due', label: 'Days late', align: 'right' },
                { key: 'balance', label: 'Balance', align: 'right' },
              ]}
            >
              {visible.map((invoice) => (
                <tr key={invoice.id} className="border-b border-border/60 last:border-0">
                  <th scope="row" className="px-2 py-2 text-left font-normal">
                    <Link
                      href={`/invoices/${invoice.id}`}
                      className="font-medium text-foreground hover:text-primary hover:underline"
                    >
                      {invoice.invoiceNumber}
                    </Link>
                    <span className="block text-xs text-muted-foreground">{invoice.clientName}</span>
                  </th>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {invoice.daysPastDue > 0 ? (
                      <span className="font-medium text-foreground">{invoice.daysPastDue}</span>
                    ) : (
                      <Badge variant="secondary">Not due</Badge>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right font-medium tabular-nums">
                    {formatMoney(invoice.balanceDue, currency)}
                  </td>
                </tr>
              ))}
            </ReportTable>
          </div>
        </div>

        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">Who to chase</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Clients ranked by overdue balance, then by how long it has been late
          </p>
          <ul className="mt-3 space-y-2.5">
            {clients.map((client) => (
              <li key={client.clientId ?? client.clientName} className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                  style={{ backgroundColor: AGING_COLORS[client.worstBucket] }}
                />
                <div className="min-w-0 flex-1">
                  {client.clientId ? (
                    <Link
                      href={`/clients/${client.clientId}`}
                      className="block truncate text-sm font-medium text-foreground hover:text-primary hover:underline"
                    >
                      {client.clientName}
                    </Link>
                  ) : (
                    <span className="block truncate text-sm font-medium text-foreground">
                      {client.clientName}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {client.invoiceCount} open,{' '}
                    {client.worstDays > 0 ? `up to ${client.worstDays} days late` : 'none late yet'}
                  </span>
                </div>
                <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">
                  {formatMoney(client.outstanding, currency)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </ReportCard>
  )
}

function BucketChip({
  active,
  color,
  onClick,
  children,
}: {
  active: boolean
  color?: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        active
          ? 'border-primary/40 bg-primary/10 text-foreground'
          : 'border-border text-muted-foreground hover:text-foreground'
      )}
    >
      {color ? (
        <span aria-hidden className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: color }} />
      ) : null}
      {children}
    </button>
  )
}
