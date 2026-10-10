/**
 * Single source of truth for the MCP tool surface as advertised to humans.
 *
 * Any page or document that quotes the tool list or count reads from here
 * rather than keeping its own hand-maintained list, because such lists went
 * stale and once advertised a tool that did not exist.
 *
 * Keep this in lockstep with the actual `registerTool` calls in
 * src/lib/mcp/tools/*. tool-catalog.test.ts asserts the two agree.
 */

export interface ToolGroup {
  name: string
  /** One line explaining what an agent reaches into this group for. */
  blurb: string
  tools: string[]
}

export const TOOL_GROUPS: ToolGroup[] = [
  { name: 'Task billing', blurb: 'Track active work and reported usage under human-approved pricing.', tools: ['list_billing_policies','create_task','start_task','heartbeat_task','pause_task','complete_task','record_task_usage','get_task_billing_preview'] },
  {
    name: 'Clients',
    blurb: 'Look up and maintain the client list.',
    tools: ['list_clients', 'get_client', 'create_client', 'update_client'],
  },
  {
    name: 'Invoices',
    blurb: 'Draft, edit, send, and settle invoices.',
    tools: [
      'list_invoices',
      'get_invoice',
      'create_invoice',
      'update_draft_invoice',
      'send_invoice',
      'record_payment',
    ],
  },
  {
    name: 'Estimates',
    blurb: 'Quote work up front, then turn an accepted quote into an invoice.',
    tools: [
      'list_estimates',
      'get_estimate',
      'create_estimate',
      'update_draft_estimate',
      'send_estimate',
      'convert_estimate_to_invoice',
    ],
  },
  {
    name: 'Engagements',
    blurb: 'Agreed totals billed off a schedule, with nothing sent automatically.',
    tools: [
      'list_engagements',
      'get_engagement',
      'list_ready_to_bill',
      'create_engagement',
      'update_engagement',
      'mark_milestone_complete',
      'complete_engagement',
      'waive_engagement_entry',
      'convert_estimate_to_engagement',
    ],
  },
  {
    name: 'Saved items',
    blurb: 'The rate catalog invoices and estimates can bill from by name.',
    tools: ['list_items', 'create_item', 'update_item'],
  },
  {
    name: 'Time',
    blurb: 'Log and correct tracked time before it gets billed.',
    tools: ['log_time', 'list_time_entries', 'update_time_entry', 'delete_time_entry'],
  },
  {
    name: 'Expenses',
    blurb: 'Log and correct expenses, billable or not.',
    tools: ['log_expense', 'list_expenses', 'update_expense', 'delete_expense'],
  },
  {
    name: 'Payments',
    blurb: 'Check what has been paid, what is still due, and correct or void a payment that was recorded wrong.',
    tools: ['get_payment_status', 'update_payment', 'void_payment'],
  },
  {
    name: 'Business and links',
    blurb: 'Business settings, revenue rollups, and shareable links.',
    tools: [
      'get_profile',
      'get_business',
      'list_businesses',
      'revenue_summary',
      'get_invoice_link',
      'list_unbilled',
    ],
  },
]

export const TOOL_NAMES: string[] = TOOL_GROUPS.flatMap((group) => group.tools)

export const TOOL_COUNT = TOOL_NAMES.length
