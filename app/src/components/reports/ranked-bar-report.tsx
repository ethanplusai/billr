'use client'

/**
 * A ranked horizontal bar report, shared by "Top clients" and "Expenses by
 * category" so the two read as the same object with different data.
 *
 * Colour: ONE series, so one hue for every bar. Shading each bar darker as it
 * gets bigger would double-encode the bar length and burn the only free
 * channel on information the bar already shows. Categories here have no
 * natural order, so there is nothing for an ordinal ramp to say (unlike the
 * aging report, where age genuinely is ordered).
 *
 * Horizontal, because these categories have long names and there are usually
 * fewer than ten of them.
 */

import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { Bar, BarChart, LabelList, XAxis, YAxis } from 'recharts'
import { EmptyState } from '@/components/shared/empty-state'
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
import type { ReportRange } from '@/lib/reports/date-ranges'
import type { ReactNode } from 'react'

export interface RankedRow {
  key: string
  label: string
  amount: number
  /** Share of the section total, 0-100. */
  share: number
  /** Small line under the label in the table view, e.g. "3 invoices". */
  secondary?: string
  href?: string
}

export function RankedBarReport({
  title,
  description,
  slug,
  rows,
  currency,
  range,
  color,
  shareLabel,
  amountLabel,
  categoryLabel,
  emptyIcon,
  emptyTitle,
  emptyDescription,
  footer,
  height = 240,
}: {
  title: string
  description: string
  slug: string
  rows: RankedRow[]
  currency: string
  range: ReportRange
  color: string
  shareLabel: string
  amountLabel: string
  categoryLabel: string
  emptyIcon: LucideIcon
  emptyTitle: string
  emptyDescription: string
  footer?: ReactNode
  height?: number
}) {
  const reduced = useReducedMotion()

  const csv = {
    filename: csvFilename(slug, range),
    build: () =>
      withReportContext(
        toCsv(rows, [
          { header: categoryLabel, value: (row: RankedRow) => row.label },
          { header: `${amountLabel} (${currency})`, value: (row: RankedRow) => row.amount },
          { header: shareLabel, value: (row: RankedRow) => row.share.toFixed(1) },
          ...(rows.some((row) => row.secondary)
            ? [{ header: 'Detail', value: (row: RankedRow) => row.secondary ?? '' }]
            : []),
        ]),
        { title, range, currency }
      ),
  }

  const table = (
    <ReportTable
      caption={`${title}, ${amountLabel.toLowerCase()} and ${shareLabel.toLowerCase()}`}
      columns={[
        { key: 'label', label: categoryLabel },
        { key: 'amount', label: amountLabel, align: 'right' },
        { key: 'share', label: shareLabel, align: 'right' },
      ]}
    >
      {rows.map((row) => (
        <tr key={row.key} className="border-b border-border/60 last:border-0">
          <th scope="row" className="px-2 py-2 text-left font-normal">
            {row.href ? (
              <Link href={row.href} className="font-medium text-foreground hover:text-primary hover:underline">
                {row.label}
              </Link>
            ) : (
              <span className="font-medium text-foreground">{row.label}</span>
            )}
            {row.secondary ? (
              <span className="block text-xs text-muted-foreground">{row.secondary}</span>
            ) : null}
          </th>
          <td className="px-2 py-2 text-right tabular-nums">{formatMoney(row.amount, currency)}</td>
          <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
            {formatPercent(row.share, 1)}
          </td>
        </tr>
      ))}
    </ReportTable>
  )

  if (rows.length === 0) {
    return (
      <ReportCard title={title} description={description}>
        <EmptyState
          icon={emptyIcon}
          title={emptyTitle}
          description={emptyDescription}
          className="py-10"
        />
      </ReportCard>
    )
  }

  return (
    <ReportCard title={title} description={description} csv={csv} table={table} footer={footer}>
      <VizFrame height={height} label={`Horizontal bar chart of ${title.toLowerCase()} in ${currency}`}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 72, bottom: 4, left: 8 }}>
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
            width={120}
          />
          <VizTooltip
            render={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const row = payload[0]?.payload as RankedRow | undefined
              if (!row) return null
              return (
                <VizTooltipCard
                  title={row.label}
                  rows={[
                    {
                      key: row.key,
                      name: row.secondary ?? amountLabel,
                      value: formatMoney(row.amount, currency),
                      color,
                    },
                  ]}
                  note={`${formatPercent(row.share, 1)} ${shareLabel.toLowerCase()}`}
                />
              )
            }}
          />
          <Bar
            dataKey="amount"
            fill={color}
            radius={[0, 4, 4, 0]}
            maxBarSize={MAX_BAR_SIZE}
            isAnimationActive={!reduced}
          >
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
    </ReportCard>
  )
}
