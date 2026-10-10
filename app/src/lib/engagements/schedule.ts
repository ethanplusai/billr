/**
 * Schedule expansion: the one definition of how an agreed total becomes a list
 * of concrete billing entries.
 *
 * This is deliberately a pure module with no database and no React in it,
 * because the same expansion exists twice and the two copies must agree to the
 * cent:
 *
 *   * here, so /engagements/new can preview the schedule before anything is
 *     written, and
 *   * in SQL, as expand_engagement_schedule(), which is what
 *     actually writes the rows, so a hand-written PostgREST call or an agent
 *     cannot smuggle in a schedule that does not add up.
 *
 * schedule.test.ts and supabase/tests/engagements.sql run the SAME cases
 * against the two implementations. Change the rules here and you must change
 * them there, or one of those two files fails.
 *
 * Rounding rule, everywhere: every entry but the last is rounded to the cent,
 * and the LAST entry absorbs whatever remainder is left, so the entries always
 * sum to exactly the total. Splitting 100 three ways gives 33.33, 33.33, 33.34
 * and never 99.99.
 */

export const BILLING_MODES = [
  'percent_split',
  'equal_installments',
  'milestones',
  'manual',
] as const
export type BillingMode = (typeof BILLING_MODES)[number]

export const DUE_RULES = ['on_start', 'on_complete', 'on_milestone', 'on_date', 'manual'] as const
export type DueRule = (typeof DUE_RULES)[number]

export type EntryStatus = 'pending' | 'ready_to_bill' | 'invoiced' | 'waived'

export const ENGAGEMENT_STATUSES = [
  'draft',
  'active',
  'paused',
  'completed',
  'cancelled',
] as const
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number]

/** Largest schedule anyone has a use for, and the cap SQL enforces too. */
export const MAX_ENTRIES = 100

interface ScheduleEntryInput {
  label?: string | null
  amount?: number | null
  percent?: number | null
  due_rule?: DueRule | null
  due_on?: string | null
}

export interface ScheduleEntry {
  position: number
  label: string
  amount: number
  percent: number | null
  due_rule: DueRule
  due_on: string | null
}

export interface ExpandInput {
  billing_mode: BillingMode
  total: number
  entries?: ScheduleEntryInput[] | null
  /** Only for equal_installments, and only when entries are not spelled out. */
  installments?: number | null
}

/**
 * Every refusal carries a stable code, spelled identically in SQL, so the tool
 * layer and the UI can map one vocabulary onto sentences rather than parsing
 * two different error texts.
 */
export type ScheduleErrorCode =
  | 'invalid_billing_mode'
  | 'invalid_total'
  | 'entries_required'
  | 'too_many_entries'
  | 'invalid_percent'
  | 'percent_must_total_100'
  | 'entry_amount_required'
  | 'invalid_entry_amount'
  | 'entries_must_total_engagement'
  | 'invalid_installments'
  | 'invalid_due_rule'
  | 'due_on_required'

export class ScheduleError extends Error {
  code: ScheduleErrorCode
  constructor(code: ScheduleErrorCode, message: string) {
    super(message)
    this.name = 'ScheduleError'
    this.code = code
  }
}

/** One sentence per refusal, shared by the UI preview and the tool layer. */
const SCHEDULE_ERROR_MESSAGES: Record<ScheduleErrorCode, string> = {
  invalid_billing_mode: 'Pick a billing mode: percent_split, equal_installments, milestones, or manual.',
  invalid_total: 'The engagement total must be greater than zero.',
  entries_required: 'This billing mode needs at least one schedule entry.',
  too_many_entries: `A schedule can hold at most ${MAX_ENTRIES} entries.`,
  invalid_percent: 'Every entry in a percent split needs a percent above 0 and at most 100.',
  percent_must_total_100: 'The percentages in a percent split must add up to exactly 100.',
  entry_amount_required: 'Every entry needs an amount in this billing mode.',
  invalid_entry_amount: 'Every entry amount must be greater than zero.',
  entries_must_total_engagement: 'The entry amounts must add up to exactly the engagement total.',
  invalid_installments: `Choose between 1 and ${MAX_ENTRIES} installments.`,
  invalid_due_rule: 'Pick a due rule: on_start, on_complete, on_milestone, on_date, or manual.',
  due_on_required: 'An entry due on a date needs that date.',
}

export function scheduleErrorMessage(code: string): string | null {
  return (SCHEDULE_ERROR_MESSAGES as Record<string, string | undefined>)[code] ?? null
}

function fail(code: ScheduleErrorCode): never {
  throw new ScheduleError(code, SCHEDULE_ERROR_MESSAGES[code])
}

/** Cents, with float drift pulled back before the rounding decision. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Default due rule when the caller does not name one. The shape of a payment
 * plan is nearly always "something at the start, something at the end, and
 * milestones in between", so that is what an unannotated schedule becomes.
 * A manual engagement stays manual: every entry waits for a person.
 */
function defaultDueRule(mode: BillingMode, index: number, count: number): DueRule {
  if (mode === 'manual') return 'manual'
  if (count === 1) return 'on_complete'
  if (index === 0) return 'on_start'
  if (index === count - 1) return 'on_complete'
  return 'on_milestone'
}

function defaultLabel(mode: BillingMode, index: number, count: number): string {
  return mode === 'equal_installments'
    ? `Installment ${index + 1} of ${count}`
    : `Payment ${index + 1} of ${count}`
}

function normalizeEntry(
  mode: BillingMode,
  input: ScheduleEntryInput,
  index: number,
  count: number,
  amount: number,
  percent: number | null
): ScheduleEntry {
  const rule = (input.due_rule ?? defaultDueRule(mode, index, count)) as DueRule
  if (!DUE_RULES.includes(rule)) fail('invalid_due_rule')

  const dueOn = input.due_on ?? null
  if (rule === 'on_date' && (!dueOn || !ISO_DATE.test(dueOn))) fail('due_on_required')

  const label = (input.label ?? '').trim() || defaultLabel(mode, index, count)

  return {
    position: index,
    label: label.slice(0, 200),
    amount,
    percent,
    due_rule: rule,
    // A date only means something for an on_date entry. Anything else keeps
    // null, so a stale date cannot make the sweep fire an entry early.
    due_on: rule === 'on_date' ? dueOn : null,
  }
}

/**
 * Splits `total` across `count` entries, each rounded to the cent, with the
 * last entry absorbing the remainder so the parts sum to exactly the total.
 * `weights` are percentages when supplied, equal shares when not.
 */
function splitTotal(total: number, count: number, weights: number[] | null): number[] {
  const amounts: number[] = []
  let allocated = 0
  for (let index = 0; index < count - 1; index += 1) {
    const share = weights ? round2((total * weights[index]) / 100) : round2(total / count)
    amounts.push(share)
    allocated = round2(allocated + share)
  }
  amounts.push(round2(total - allocated))
  return amounts
}

/**
 * Turns a billing mode plus the caller's rough intent into the concrete rows
 * an engagement is billed from. Throws ScheduleError; never returns a schedule
 * that does not add up to the total.
 */
export function expandSchedule(input: ExpandInput): ScheduleEntry[] {
  const mode = input.billing_mode
  if (!BILLING_MODES.includes(mode)) fail('invalid_billing_mode')

  const total = round2(input.total)
  if (!Number.isFinite(total) || total <= 0 || total >= 100000000) fail('invalid_total')

  const given = input.entries ?? []

  if (mode === 'equal_installments') {
    const count = given.length > 0 ? given.length : (input.installments ?? 0)
    if (!Number.isInteger(count) || count < 1 || count > MAX_ENTRIES) fail('invalid_installments')

    const amounts = splitTotal(total, count, null)
    return amounts.map((amount, index) => {
      if (amount <= 0) fail('invalid_entry_amount')
      return normalizeEntry(mode, given[index] ?? {}, index, count, amount, null)
    })
  }

  if (given.length === 0) fail('entries_required')
  if (given.length > MAX_ENTRIES) fail('too_many_entries')
  const count = given.length

  if (mode === 'percent_split') {
    const percents = given.map((entry) => {
      const percent = round2(entry.percent ?? 0)
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) fail('invalid_percent')
      return percent
    })
    if (round2(percents.reduce((sum, percent) => round2(sum + percent), 0)) !== 100) {
      fail('percent_must_total_100')
    }

    const amounts = splitTotal(total, count, percents)
    return amounts.map((amount, index) => {
      if (amount <= 0) fail('invalid_entry_amount')
      return normalizeEntry(mode, given[index], index, count, amount, percents[index])
    })
  }

  // milestones and manual: the caller states every amount, and the amounts
  // must already add up. Nothing is redistributed behind their back.
  const amounts = given.map((entry) => {
    if (entry.amount === null || entry.amount === undefined) fail('entry_amount_required')
    const amount = round2(entry.amount)
    if (!Number.isFinite(amount) || amount <= 0 || amount >= 100000000) fail('invalid_entry_amount')
    return amount
  })
  if (round2(amounts.reduce((sum, amount) => round2(sum + amount), 0)) !== total) {
    fail('entries_must_total_engagement')
  }

  return amounts.map((amount, index) =>
    normalizeEntry(mode, given[index], index, count, amount, null)
  )
}

/**
 * Business-level schedule templates, seeded onto businesses.schedule_templates
 * by the database. Kept here as well so a business row that predates the
 * column still has something to pick from, and so the
 * SQL test can assert the seed matches what the app believes it seeded.
 */
export interface ScheduleTemplate {
  key: string
  name: string
  billing_mode: BillingMode
  installments?: number
  entries?: ScheduleEntryInput[]
}

export const DEFAULT_SCHEDULE_TEMPLATES: ScheduleTemplate[] = [
  {
    key: '50_50',
    name: '50/50',
    billing_mode: 'percent_split',
    entries: [
      { label: 'Deposit', percent: 50, due_rule: 'on_start' },
      { label: 'On completion', percent: 50, due_rule: 'on_complete' },
    ],
  },
  {
    key: '30_70',
    name: '30/70',
    billing_mode: 'percent_split',
    entries: [
      { label: 'Deposit', percent: 30, due_rule: 'on_start' },
      { label: 'On completion', percent: 70, due_rule: 'on_complete' },
    ],
  },
  {
    key: 'design_build_launch',
    name: 'Design / Build / Launch',
    billing_mode: 'equal_installments',
    installments: 3,
    entries: [
      { label: 'Design', due_rule: 'on_start' },
      { label: 'Build', due_rule: 'on_milestone' },
      { label: 'Launch', due_rule: 'on_complete' },
    ],
  },
  {
    key: '10_equal',
    name: '10 equal installments',
    billing_mode: 'equal_installments',
    installments: 10,
  },
]

/** Preview for the UI: the schedule a template would produce for a total. */
export function expandTemplate(template: ScheduleTemplate, total: number): ScheduleEntry[] {
  return expandSchedule({
    billing_mode: template.billing_mode,
    total,
    entries: template.entries ?? null,
    installments: template.installments ?? null,
  })
}
