'use client'

/**
 * Revenue over time: what was invoiced against what was actually collected.
 *
 * Two bars per bucket, one axis. Invoiced and collected are the same unit
 * (money in the selected currency), so they share a scale and can be compared
 * honestly; nothing here ever gets a second y-axis.
 *
 * The comparison period rides along as a single de-emphasis line rather than
 * two more bars: four bars per bucket is noise, and the per-series deltas
 * already live in the KPI row above.
 */

import { Bar, ComposedChart, Line } from 'recharts'
import { EmptyState } from '@/components/shared/empty-state'
import { LineChart as LineChartIcon } from 'lucide-react'
import {
  BAR_RADIUS,
  MAX_BAR_SIZE,
  useReducedMotion,
  VizFrame,
  VizGrid,
  VizLegend,
  VizTooltip,
  VizTooltipCard,
  VizXAxis,
  VizYAxis,
} from '@/components/reports/chart-theme'
import { ReportCard, ReportTable } from '@/components/reports/report-card'
import { csvFilename, toCsv, withReportContext } from '@/lib/reports/csv'
import { formatMoney, formatMoneyCompact } from '@/lib/reports/money'
import { SERIES_COLORS } from '@/lib/reports/palette'
import { buildRevenueSeries, type RevenuePoint } from '@/lib/reports/metrics'
import type { ReportData } from '@/lib/reports/types'

export function RevenueChart({
  data,
  compare,
  bucketNoun,
}: {
  data: ReportData
  compare: boolean
  bucketNoun: string
}) {
  const reduced = useReducedMotion()
  const points = buildRevenueSeries(data, compare)
  const currency = data.currency
  const hasActivity = points.some((p) => p.invoiced !== 0 || p.collected !== 0)

  const legend = [
    { key: 'invoiced', label: 'Invoiced', color: SERIES_COLORS.invoiced, mark: 'rect' as const },
    { key: 'collected', label: 'Collected', color: SERIES_COLORS.collected, mark: 'rect' as const },
    ...(compare
      ? [
          {
            key: 'previous',
            label: 'Invoiced, previous period',
            color: SERIES_COLORS.previous,
            mark: 'line' as const,
          },
        ]
      : []),
  ]

  const csv = {
    filename: csvFilename('revenue-over-time', data.range),
    build: () =>
      withReportContext(
        toCsv(points, [
          { header: bucketNoun, value: (row: RevenuePoint) => row.label },
          { header: 'Bucket start', value: (row: RevenuePoint) => row.key },
          { header: `Invoiced (${currency})`, value: (row: RevenuePoint) => row.invoiced },
          { header: `Collected (${currency})`, value: (row: RevenuePoint) => row.collected },
          ...(compare
            ? [
                { header: 'Previous bucket', value: (row: RevenuePoint) => row.previousLabel ?? '' },
                {
                  header: `Previous invoiced (${currency})`,
                  value: (row: RevenuePoint) => row.previousInvoiced ?? '',
                },
                {
                  header: `Previous collected (${currency})`,
                  value: (row: RevenuePoint) => row.previousCollected ?? '',
                },
              ]
            : []),
        ]),
        { title: 'Revenue over time', range: data.range, currency }
      ),
  }

  const table = (
    <ReportTable
      caption="Invoiced and collected revenue per period"
      columns={[
        { key: 'period', label: bucketNoun },
        { key: 'invoiced', label: 'Invoiced', align: 'right' },
        { key: 'collected', label: 'Collected', align: 'right' },
        ...(compare ? [{ key: 'previous', label: 'Previous invoiced', align: 'right' as const }] : []),
      ]}
    >
      {points.map((point) => (
        <tr key={point.key} className="border-b border-border/60 last:border-0">
          <th scope="row" className="px-2 py-1.5 text-left font-normal text-foreground">
            {point.label}
          </th>
          <td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(point.invoiced, currency)}</td>
          <td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(point.collected, currency)}</td>
          {compare ? (
            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
              {point.previousInvoiced === undefined ? '-' : formatMoney(point.previousInvoiced, currency)}
            </td>
          ) : null}
        </tr>
      ))}
    </ReportTable>
  )

  return (
    <ReportCard
      title="Revenue over time"
      description={`Invoiced against collected, by ${bucketNoun.toLowerCase()}`}
      csv={csv}
      table={hasActivity ? table : undefined}
    >
      {!hasActivity ? (
        <EmptyState
          icon={LineChartIcon}
          title="No revenue in this range"
          description="Once you send an invoice or record a payment in this period, the trend shows up here."
          className="py-10"
        />
      ) : (
        <>
          <VizLegend items={legend} className="mb-3" />
          <VizFrame
            height={280}
            label={`Bar chart of invoiced and collected revenue by ${bucketNoun.toLowerCase()} in ${currency}`}
          >
            <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
              <VizGrid />
              <VizXAxis dataKey="label" />
              <VizYAxis tickFormatter={(value) => formatMoneyCompact(value, currency)} />
              <VizTooltip
                render={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const point = payload[0]?.payload as RevenuePoint | undefined
                  if (!point) return null
                  return (
                    <VizTooltipCard
                      title={point.label}
                      rows={[
                        {
                          key: 'invoiced',
                          name: 'Invoiced',
                          value: formatMoney(point.invoiced, currency),
                          color: SERIES_COLORS.invoiced,
                        },
                        {
                          key: 'collected',
                          name: 'Collected',
                          value: formatMoney(point.collected, currency),
                          color: SERIES_COLORS.collected,
                        },
                        ...(compare && point.previousInvoiced !== undefined
                          ? [
                              {
                                key: 'previous',
                                name: `Invoiced, ${point.previousLabel}`,
                                value: formatMoney(point.previousInvoiced, currency),
                                color: SERIES_COLORS.previous,
                                mark: 'line' as const,
                              },
                            ]
                          : []),
                      ]}
                    />
                  )
                }}
              />
              <Bar
                dataKey="invoiced"
                name="Invoiced"
                fill={SERIES_COLORS.invoiced}
                radius={BAR_RADIUS}
                maxBarSize={MAX_BAR_SIZE}
                isAnimationActive={!reduced}
              />
              <Bar
                dataKey="collected"
                name="Collected"
                fill={SERIES_COLORS.collected}
                radius={BAR_RADIUS}
                maxBarSize={MAX_BAR_SIZE}
                isAnimationActive={!reduced}
              />
              {compare ? (
                <Line
                  type="monotone"
                  dataKey="previousInvoiced"
                  name="Invoiced, previous period"
                  stroke={SERIES_COLORS.previous}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--viz-surface)' }}
                  isAnimationActive={!reduced}
                />
              ) : null}
            </ComposedChart>
          </VizFrame>
        </>
      )}
    </ReportCard>
  )
}
