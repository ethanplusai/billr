'use client'

/**
 * The one filter row. It sits above every report and scopes all of them, so
 * the numbers on the page always describe the same slice. No chart carries its
 * own range control.
 */

import { CalendarRange, Check, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  formatRangeLabel,
  isValidRange,
  RANGE_PRESETS,
  type RangePresetId,
  type ReportRange,
} from '@/lib/reports/date-ranges'
import type { CurrencyCount } from '@/lib/reports/types'

export interface ReportFiltersProps {
  preset: RangePresetId
  onPresetChange: (preset: RangePresetId) => void
  range: ReportRange
  customRange: ReportRange
  onCustomRangeChange: (range: ReportRange) => void
  previousRange: ReportRange | null
  compare: boolean
  onCompareChange: (compare: boolean) => void
  currency: string
  currencies: CurrencyCount[]
  onCurrencyChange: (currency: string) => void
  onRefresh: () => void
  isRefreshing: boolean
}

export function ReportFilters(props: ReportFiltersProps) {
  const multiCurrency = props.currencies.length > 1

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={props.preset}
        onValueChange={(value) => props.onPresetChange(value as RangePresetId)}
      >
        <SelectTrigger className="w-[180px]" aria-label="Date range">
          <CalendarRange className="h-4 w-4 text-muted-foreground" aria-hidden />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RANGE_PRESETS.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {props.preset === 'custom' ? (
        <CustomRangePicker value={props.customRange} onChange={props.onCustomRangeChange} />
      ) : null}

      <button
        type="button"
        role="switch"
        aria-checked={props.compare}
        onClick={() => props.onCompareChange(!props.compare)}
        className={cn(
          'flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          props.compare
            ? 'border-primary/40 bg-primary/10 text-foreground'
            : 'border-border text-muted-foreground hover:text-foreground'
        )}
      >
        <span
          aria-hidden
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded-[4px] border',
            props.compare ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
          )}
        >
          {props.compare ? <Check className="h-3 w-3" /> : null}
        </span>
        Compare to previous
      </button>

      {multiCurrency ? (
        <Select value={props.currency} onValueChange={props.onCurrencyChange}>
          <SelectTrigger className="w-[110px]" aria-label="Currency">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {props.currencies.map((currency) => (
              <SelectItem key={currency.code} value={currency.code}>
                {currency.code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      <div className="ml-auto flex items-center gap-3">
        <p className="text-sm text-muted-foreground">
          {formatRangeLabel(props.range)}
          {props.compare && props.previousRange
            ? ` vs ${formatRangeLabel(props.previousRange)}`
            : ''}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={props.onRefresh}
          disabled={props.isRefreshing}
          aria-label="Refresh reports"
        >
          <RefreshCw className={cn('h-4 w-4', props.isRefreshing && 'animate-spin')} aria-hidden />
        </Button>
      </div>
    </div>
  )
}

function CustomRangePicker({
  value,
  onChange,
}: {
  value: ReportRange
  onChange: (range: ReportRange) => void
}) {
  const valid = isValidRange(value)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9">
          {valid ? formatRangeLabel(value) : 'Pick dates'}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="report-range-start">Start date</Label>
          <Input
            id="report-range-start"
            type="date"
            value={value.start}
            max={value.end}
            onChange={(event) => onChange({ ...value, start: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="report-range-end">End date</Label>
          <Input
            id="report-range-end"
            type="date"
            value={value.end}
            min={value.start}
            onChange={(event) => onChange({ ...value, end: event.target.value })}
          />
        </div>
        {!valid ? (
          <p className="text-xs text-destructive">
            Choose a start date on or before the end date.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
