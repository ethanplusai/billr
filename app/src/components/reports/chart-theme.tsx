'use client'

/**
 * The shared chart chrome. Every chart on the reports page draws its colours,
 * grid, axes, tooltip and legend from here so the page reads as one system
 * rather than a pile of separately-styled charts.
 *
 * Colours arrive as CSS custom properties (see lib/reports/palette.ts for how
 * the values were chosen and validated). Recharts happily takes
 * `fill="var(--viz-series-1)"`, so light and dark swap in one place and no
 * component ever has to ask which theme is active.
 */

import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TooltipContentProps } from 'recharts'
import { cn } from '@/lib/utils'
import { paletteToCss, VIZ_DARK, VIZ_LIGHT } from '@/lib/reports/palette'

const VIZ_CSS = `
.billr-viz { ${paletteToCss(VIZ_LIGHT)} }
.dark .billr-viz { ${paletteToCss(VIZ_DARK)} }
.billr-viz .recharts-surface { overflow: visible; }
.billr-viz .recharts-cartesian-axis-line { stroke: var(--viz-grid); }
.billr-viz .recharts-cartesian-axis-tick-line { stroke: transparent; }
`

/**
 * Defines the chart custom properties for everything inside it. Mounted once,
 * near the top of the reports page.
 */
export function VizScope({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('billr-viz', className)}>
      <style dangerouslySetInnerHTML={{ __html: VIZ_CSS }} />
      {children}
    </div>
  )
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function subscribeToMotionPreference(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/**
 * Honours the OS reduced-motion setting; charts render instantly when it is
 * on. Read through useSyncExternalStore so the first client render already has
 * the right answer instead of animating once and then correcting itself.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToMotionPreference,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false
  )
}

const AXIS_TICK = { fontSize: 12, fill: 'var(--viz-axis)' } as const

/** Hairline, solid, one step off the surface. Never dashed. */
export function VizGrid({ horizontal = true, vertical = false }: { horizontal?: boolean; vertical?: boolean }) {
  return (
    <CartesianGrid
      stroke="var(--viz-grid)"
      strokeWidth={1}
      horizontal={horizontal}
      vertical={vertical}
    />
  )
}

export function VizXAxis(props: { dataKey: string; interval?: number | 'preserveStartEnd'; angled?: boolean }) {
  return (
    <XAxis
      dataKey={props.dataKey}
      tick={AXIS_TICK}
      tickLine={false}
      axisLine={{ stroke: 'var(--viz-grid)' }}
      interval={props.interval ?? 'preserveStartEnd'}
      minTickGap={12}
      height={props.angled ? 48 : 28}
      angle={props.angled ? -35 : 0}
      textAnchor={props.angled ? 'end' : 'middle'}
    />
  )
}

export function VizYAxis({
  tickFormatter,
  width = 68,
  hide = false,
}: {
  tickFormatter?: (value: number) => string
  width?: number
  hide?: boolean
}) {
  return (
    <YAxis
      tick={AXIS_TICK}
      tickLine={false}
      axisLine={false}
      width={width}
      hide={hide}
      tickFormatter={tickFormatter ? (value: number) => tickFormatter(value) : undefined}
    />
  )
}

export interface VizTooltipRow {
  key: string
  name: string
  value: string
  color: string
  /** Lines key with a stroke, bars and areas with a small rounded rect. */
  mark?: 'line' | 'rect'
}

/**
 * One tooltip for the whole page. The value leads, the series name follows,
 * and the reader never has to land on a specific mark to see every series at
 * that position.
 */
export function VizTooltipCard({ title, rows, note }: { title: string; rows: VizTooltipRow[]; note?: string }) {
  return (
    <div className="pointer-events-none min-w-40 rounded-lg border border-border bg-popover px-3 py-2 shadow-lg">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="mt-1.5 space-y-1">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2">
            <span
              aria-hidden
              className={row.mark === 'line' ? 'h-0.5 w-3 rounded-full' : 'h-2.5 w-2.5 rounded-[3px]'}
              style={{ backgroundColor: row.color }}
            />
            <span className="text-sm font-semibold tabular-nums text-foreground">{row.value}</span>
            <span className="ml-auto text-xs text-muted-foreground">{row.name}</span>
          </li>
        ))}
      </ul>
      {note ? <p className="mt-1.5 text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  )
}

type TooltipRenderer = (props: TooltipContentProps) => ReactNode

/** Wires a custom card into recharts with the shared cursor treatment. */
export function VizTooltip({ render, cursor = 'bar' }: { render: TooltipRenderer; cursor?: 'bar' | 'line' | 'none' }) {
  return (
    <Tooltip
      content={render}
      cursor={
        cursor === 'none'
          ? false
          : cursor === 'bar'
            ? { fill: 'var(--viz-axis)', fillOpacity: 0.08 }
            : { stroke: 'var(--viz-axis)', strokeWidth: 1 }
      }
      wrapperStyle={{ outline: 'none' }}
    />
  )
}

export interface VizLegendItem {
  key: string
  label: string
  color: string
  mark?: 'line' | 'rect'
}

/**
 * Legends live outside the plot so they never fight the marks for space, and
 * they are always present for two or more series: identity is never carried by
 * colour alone.
 */
export function VizLegend({ items, className }: { items: VizLegendItem[]; className?: string }) {
  if (items.length < 2) return null
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5', className)}>
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className={item.mark === 'line' ? 'h-0.5 w-3.5 rounded-full' : 'h-2.5 w-2.5 rounded-[3px]'}
            style={{ backgroundColor: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  )
}

/**
 * Sizes the plot to include its axis band, so a card never grows an inner
 * scrollbar to reach the x labels.
 */
export function VizFrame({
  height = 260,
  label,
  children,
  className,
}: {
  height?: number
  /** Screen-reader description of what the chart shows. */
  label: string
  children: React.ReactElement
  className?: string
}) {
  return (
    <div className={cn('w-full', className)} style={{ height }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  )
}

/** Bar radius: rounded data-end, square at the baseline. */
export const BAR_RADIUS: [number, number, number, number] = [4, 4, 0, 0]
export const MAX_BAR_SIZE = 24

/**
 * LabelList's formatter is typed for any renderable value; report labels are
 * always numeric money, so this narrows it in one place instead of at every
 * call site.
 */
export function moneyLabelFormatter(format: (value: number) => string) {
  return (value: unknown) => (typeof value === 'number' && value !== 0 ? format(value) : '')
}
