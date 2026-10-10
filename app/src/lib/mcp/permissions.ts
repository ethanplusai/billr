export const KEY_PROFILES = {
  draft: ['read', 'write'],
  readonly: ['read'],
  billing: ['read', 'write', 'send', 'payments'],
  full: ['read', 'write', 'send', 'payments', 'delete'],
} as const
export type KeyProfile = keyof typeof KEY_PROFILES
// Unknown tools are denied until explicitly categorized.
const reads = new Set([
  'list_clients',
  'get_client',
  'list_invoices',
  'get_invoice',
  'list_estimates',
  'get_estimate',
  'list_items',
  'list_time_entries',
  'list_expenses',
  'get_payment_status',
  'get_business',
  'list_businesses',
  'revenue_summary',
  'get_invoice_link',
  'list_unbilled',
  'list_billing_policies',
  'get_task_billing_preview',
  'list_engagements',
  'get_engagement',
  'list_ready_to_bill',
  'get_profile',
])
const writes = new Set([
  'create_client',
  'update_client',
  'create_invoice',
  'update_draft_invoice',
  'create_estimate',
  'update_draft_estimate',
  'convert_estimate_to_invoice',
  'create_item',
  'update_item',
  'log_time',
  'update_time_entry',
  'log_expense',
  'update_expense',
  'create_task',
  'start_task',
  'heartbeat_task',
  'pause_task',
  'complete_task',
  'record_task_usage',
  'create_engagement',
  'update_engagement',
  'mark_milestone_complete',
  'complete_engagement',
  'waive_engagement_entry',
  'convert_estimate_to_engagement',
])
export function toolPermission(name: string): string | null {
  if (reads.has(name)) return 'read'
  if (writes.has(name)) return 'write'
  if (name === 'send_invoice' || name === 'send_estimate') return 'send'
  if (name === 'delete_time_entry' || name === 'delete_expense') return 'delete'
  if (name === 'record_payment' || name === 'update_payment' || name === 'void_payment') return 'payments'
  return null
}
export function canUseTool(
  name: string,
  permissions: readonly string[]
): boolean {
  const permission = toolPermission(name)
  return permission !== null && permissions.includes(permission)
}
