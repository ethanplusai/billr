/**
 * The reports colour system. Data only - no React - so it can be imported by
 * charts, legends, table views and tests alike, and so every surface that
 * paints a series reads the same hex from one place.
 *
 * How these values were chosen (not by eye):
 *
 * - Slot 1 is Billr's brand blue (#2563eb light / #3b82f6 dark, the app's own
 *   --primary in each theme). The remaining slots are the validated
 *   categorical order from the dataviz palette, stepped for each surface.
 * - The set was run through the palette validator against the real chart
 *   surface in each mode (card white #ffffff light, card slate #1e293b dark):
 *     light: lightness band PASS, chroma floor PASS, CVD separation PASS
 *            (worst adjacent dE 9.1), normal-vision floor PASS (worst 19.6),
 *            contrast WARN on aqua/yellow/magenta -> those slots always ship
 *            with visible labels and a table view (the relief rule).
 *     dark:  all six checks PASS (worst adjacent CVD dE 8.4, contrast >= 3:1).
 * - The aging ramp is ORDINAL (age has a natural order), so it is one hue,
 *   light to dark, validated with the ordinal rules: light-mode steps run
 *   #86b6ef -> #184f95 (light-end contrast 2.11:1), dark-mode steps run
 *   #256abf -> #b7d3f6 (light-end contrast 2.71:1) because on a dark surface
 *   the LIGHTER step is the salient one. Both directions were validated so the
 *   oldest bucket is the most prominent mark in either theme.
 * - "Not yet due" is deliberately outside the ramp, in the de-emphasis grey:
 *   it is context, not a stage of overdue-ness, and greying it puts the
 *   reader's eye on the money that is actually late.
 *
 * Charts consume these through CSS custom properties (see
 * components/reports/chart-theme.tsx) so light and dark swap in one place and
 * recharts never has to be told which theme is active.
 */

type VizRole =
  | 'series-1'
  | 'series-2'
  | 'series-3'
  | 'series-4'
  | 'series-5'
  | 'series-6'
  | 'compare'
  | 'grid'
  | 'axis'
  | 'surface'
  | 'age-0'
  | 'age-1'
  | 'age-2'
  | 'age-3'
  | 'age-4'

export type VizPalette = Record<VizRole, string>

export const VIZ_LIGHT: VizPalette = {
  'series-1': '#2563eb', // blue - Billr primary
  'series-2': '#eb6834', // orange
  'series-3': '#1baf7a', // aqua
  'series-4': '#eda100', // yellow
  'series-5': '#e87ba4', // magenta
  'series-6': '#4a3aa7', // violet
  compare: '#9ca3af', // de-emphasis grey for the comparison period
  grid: '#e5e7eb',
  axis: '#6b7280',
  surface: '#ffffff',
  'age-0': '#9ca3af', // not yet due - outside the ramp on purpose
  'age-1': '#86b6ef',
  'age-2': '#5598e7',
  'age-3': '#2563eb',
  'age-4': '#184f95',
}

export const VIZ_DARK: VizPalette = {
  'series-1': '#3b82f6',
  'series-2': '#d95926',
  'series-3': '#199e70',
  'series-4': '#c98500',
  'series-5': '#d55181',
  'series-6': '#9085e9',
  compare: '#64748b',
  grid: '#334155',
  axis: '#94a3b8',
  surface: '#1e293b',
  'age-0': '#64748b',
  'age-1': '#256abf',
  'age-2': '#3987e5',
  'age-3': '#6da7ec',
  'age-4': '#b7d3f6',
}

/** CSS custom property name for a role. */
function vizVar(role: VizRole): string {
  return `var(--viz-${role})`
}

/** Fixed series assignments. Colour follows the entity, never its rank. */
export const SERIES_COLORS = {
  invoiced: vizVar('series-1'),
  collected: vizVar('series-2'),
  expenses: vizVar('series-3'),
  profit: vizVar('series-4'),
  unbilled: vizVar('series-2'),
  billable: vizVar('series-1'),
  nonBillable: vizVar('compare'),
  previous: vizVar('compare'),
} as const

export const AGING_COLORS: Record<string, string> = {
  current: vizVar('age-0'),
  d1_30: vizVar('age-1'),
  d31_60: vizVar('age-2'),
  d61_90: vizVar('age-3'),
  d90_plus: vizVar('age-4'),
}

/** Serialises a palette to the CSS custom-property block a theme scope needs. */
export function paletteToCss(palette: VizPalette): string {
  return Object.entries(palette)
    .map(([role, hex]) => `--viz-${role}: ${hex};`)
    .join(' ')
}
