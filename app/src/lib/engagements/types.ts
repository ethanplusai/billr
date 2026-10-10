import type { Database } from '@/types/database'
import type { BillingMode, DueRule, EngagementStatus, EntryStatus } from './schedule'

/**
 * Row shapes the engagement pages read, narrowed from the generated database
 * types so the string columns carry their real unions (a status is one of five
 * things, not any string) without a second hand-written copy of the schema.
 */
export type EngagementRow = Omit<
  Database['public']['Tables']['engagements']['Row'],
  'status' | 'billing_mode'
> & {
  status: EngagementStatus
  billing_mode: BillingMode
}

export type EngagementEntryRow = Omit<
  Database['public']['Tables']['engagement_entries']['Row'],
  'status' | 'due_rule'
> & {
  status: EntryStatus
  due_rule: DueRule
}

export type EngagementSummaryRow = Omit<
  Database['public']['Views']['engagement_summary']['Row'],
  'status' | 'billing_mode'
> & {
  status: EngagementStatus | null
  billing_mode: BillingMode | null
}

/** A summary row with the client name already resolved, for the list page. */
export interface EngagementListRow extends EngagementSummaryRow {
  client_name: string | null
}

export const ENGAGEMENT_STATUS_COLORS: Record<EngagementStatus, string> = {
  draft: 'bg-gray-100 text-gray-700',
  active: 'bg-green-100 text-green-700',
  paused: 'bg-amber-100 text-amber-700',
  completed: 'bg-blue-100 text-blue-700',
  cancelled: 'bg-red-100 text-red-700',
}

export const ENTRY_STATUS_COLORS: Record<EntryStatus, string> = {
  pending: 'bg-gray-100 text-gray-700',
  ready_to_bill: 'bg-emerald-100 text-emerald-700',
  invoiced: 'bg-indigo-100 text-indigo-700',
  waived: 'bg-gray-100 text-gray-500',
}

export const ENTRY_STATUS_LABELS: Record<EntryStatus, string> = {
  pending: 'Pending',
  ready_to_bill: 'Ready to bill',
  invoiced: 'Invoiced',
  waived: 'Waived',
}

/** How each due rule reads to a person looking at the schedule. */
export const DUE_RULE_LABELS: Record<DueRule, string> = {
  on_start: 'When work starts',
  on_complete: 'On completion',
  on_milestone: 'When marked complete',
  on_date: 'On a date',
  manual: 'When you decide',
}

export const BILLING_MODE_LABELS: Record<BillingMode, string> = {
  percent_split: 'Percentage split',
  equal_installments: 'Equal installments',
  milestones: 'Milestones',
  manual: 'Manual',
}
