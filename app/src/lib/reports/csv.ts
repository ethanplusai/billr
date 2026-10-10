/**
 * CSV serialisation for report exports. Pure - builds strings only; the
 * browser download itself lives in the component layer.
 *
 * Escaping matters here beyond tidiness: a client name beginning with =, +, -
 * or @ is executed as a formula by Excel and Google Sheets when the file is
 * opened. Those values are prefixed so an exported report cannot run anything.
 */

import { formatRangeLabel, type ReportRange } from '@/lib/reports/date-ranges'

export interface CsvColumn<T> {
  header: string
  value: (row: T) => string | number | null | undefined
}

const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r']

export function escapeCsvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  let text = String(value)
  if (FORMULA_PREFIXES.some((p) => text.startsWith(p))) text = `'${text}`
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const head = columns.map((c) => escapeCsvValue(c.header)).join(',')
  const body = rows.map((row) => columns.map((c) => escapeCsvValue(c.value(row))).join(','))
  return [head, ...body].join('\n')
}

/**
 * Prepends a comment-free context line so an exported file still says what it
 * covers once it is detached from the app. Kept as plain first-row cells
 * rather than a `#` comment, which spreadsheets do not understand.
 */
export function withReportContext(
  csv: string,
  meta: { title: string; range: ReportRange; currency: string; note?: string }
): string {
  const header = [
    escapeCsvValue(meta.title),
    escapeCsvValue(formatRangeLabel(meta.range)),
    escapeCsvValue(`Amounts in ${meta.currency}`),
    ...(meta.note ? [escapeCsvValue(meta.note)] : []),
  ].join(',')
  return `${header}\n\n${csv}\n`
}

/** Filesystem-safe export name, e.g. billr-ar-aging-2026-01-01-to-2026-03-31.csv */
export function csvFilename(slug: string, range: ReportRange): string {
  const clean = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `billr-${clean}-${range.start}-to-${range.end}.csv`
}
