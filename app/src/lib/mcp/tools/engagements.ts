import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { McpCtx } from '@/lib/mcp/context'
import { ScopeError } from '@/lib/mcp/scoped-db'
import { resolveClient } from './invoices-write'
import { appUrl, errorResult, jsonResult, formatCurrency, truncationNote } from '@/lib/mcp/shared'
import { BILLING_MODES, DUE_RULES, ENGAGEMENT_STATUSES, MAX_ENTRIES } from '@/lib/engagements/schedule'
import { engagementErrorMessage } from '@/lib/engagements/errors'
import { todayISO } from '@/lib/dates'

/**
 * Engagement tools: the agreed total and the schedule it is billed off.
 *
 * Every write goes through a SECURITY DEFINER RPC, which
 * owns the rules the tool layer must not be trusted with: it re-checks the
 * key's permission in SQL, expands the schedule server side so the entries sum
 * to exactly the total, is idempotent on request_id, and refuses to touch
 * money that has already been invoiced.
 *
 * NOTHING HERE SENDS ANYTHING. An engagement is a plan, not a message: no
 * email leaves Billr because of any tool in this file, and the schedule
 * becoming billable is an entry changing status, not a client being contacted.
 */

const LIST_LIMIT_DEFAULT = 20
const READY_LIMIT_DEFAULT = 50

const DATE_FIELD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

interface SummaryRow {
  engagement_id: string
  business_id: string
  client_id: string
  name: string
  status: string
  billing_mode: string
  currency: string
  total: number
  starts_on: string | null
  target_end: string | null
  entry_count: number
  amount_billed: number
  amount_waived: number
  amount_remaining: number
  ready_count: number
  ready_amount: number
  next_ready_entries: unknown
}

interface EntryRow {
  id: string
  engagement_id: string
  position: number
  label: string
  amount: number
  percent: number | null
  due_rule: string
  due_on: string | null
  status: string
  invoice_id: string | null
  completed_at: string | null
  waived_reason: string | null
}

interface EngagementPayload {
  engagement: {
    id: string
    business_id: string
    client_id: string
    name: string
    total: number
    currency: string
    status: string
    billing_mode: string
    starts_on: string | null
    target_end: string | null
    notes: string | null
  }
  summary: Partial<SummaryRow>
  entries: EntryRow[]
  replayed?: boolean
  warning?: string | null
  amount_remaining?: number
  became_ready_to_bill?: boolean
  entry?: EntryRow
}

/**
 * Turns the RPC's error codes into sentences a calling agent
 * can act on. The vocabulary is shared with the app's server actions through
 * src/lib/engagements/errors.ts, so a person and an agent are told the same
 * thing about the same rule. Anything unrecognised falls back to the caller's
 * generic message rather than relaying a Postgres error.
 */
function engagementError(error: { message?: string } | null, fallback: string): string {
  const message = engagementErrorMessage(error?.message)
  if (message) return message
  console.error('engagements (rpc):', error)
  return fallback
}

function entryView(entry: EntryRow, currency: string) {
  return {
    entry_id: entry.id,
    position: entry.position,
    label: entry.label,
    amount: entry.amount,
    amount_label: formatCurrency(entry.amount, currency),
    percent: entry.percent,
    due_rule: entry.due_rule,
    due_on: entry.due_on,
    status: entry.status,
    invoice_id: entry.invoice_id,
    invoice_url: entry.invoice_id ? `${appUrl()}/invoices/${entry.invoice_id}` : null,
    completed_at: entry.completed_at,
    waived_reason: entry.waived_reason,
  }
}

/** One answer shape for every write, so an agent reads one format. */
function payloadResult(data: unknown, summary: string) {
  const payload = data as unknown as EngagementPayload
  const currency = payload.engagement.currency
  return {
    summary,
    engagement: {
      id: payload.engagement.id,
      business_id: payload.engagement.business_id,
      client_id: payload.engagement.client_id,
      name: payload.engagement.name,
      status: payload.engagement.status,
      billing_mode: payload.engagement.billing_mode,
      currency,
      total: payload.engagement.total,
      starts_on: payload.engagement.starts_on,
      target_end: payload.engagement.target_end,
      notes: payload.engagement.notes,
      amount_billed: payload.summary.amount_billed ?? 0,
      amount_remaining: payload.summary.amount_remaining ?? payload.engagement.total,
      ready_count: payload.summary.ready_count ?? 0,
      app_url: `${appUrl()}/engagements/${payload.engagement.id}`,
    },
    schedule: (payload.entries ?? []).map((entry) => entryView(entry, currency)),
    replayed: payload.replayed === true,
  }
}

/**
 * The scheduled-date sweep, run before a read answers. There is no cron: an
 * entry due on a date becomes billable the first time anybody looks. Failures
 * are logged and swallowed, because a sweep that cannot run is not a reason to
 * refuse to show somebody their engagements.
 */
async function sweep(ctx: McpCtx, businessIds: string[]): Promise<void> {
  await Promise.all(
    businessIds.map(async (businessId) => {
      const { error } = await ctx.db.svc.rpc('promote_due_entries', {
        p_business_id: businessId,
        p_actor_key_id: ctx.keyId,
      })
      if (error) console.error('promote_due_entries:', error)
    })
  )
}

/** Client names for a set of ids, scoped to the businesses already resolved. */
async function clientNames(ctx: McpCtx, businessIds: string[], clientIds: string[]) {
  const names = new Map<string, string>()
  if (clientIds.length === 0) return names
  const { data } = await ctx.db.svc
    .from('clients')
    .select('id, name')
    .in('business_id', businessIds)
    .in('id', [...new Set(clientIds)])
  for (const row of (data ?? []) as { id: string; name: string }[]) names.set(row.id, row.name)
  return names
}

const scheduleEntryInput = z.object({
  label: z.string().max(200).optional().describe('What this payment is for, for example "Deposit" or "On delivery".'),
  amount: z
    .number()
    .positive()
    .optional()
    .describe('Amount for this entry. Required for billing_mode "milestones" and "manual"; the entry amounts must add up to exactly the engagement total.'),
  percent: z
    .number()
    .positive()
    .max(100)
    .optional()
    .describe('Share of the total for this entry, 0 to 100. Required for billing_mode "percent_split"; the percentages must add up to exactly 100.'),
  due_rule: z
    .enum(DUE_RULES)
    .optional()
    .describe(
      'When this entry becomes billable: "on_start" when the engagement is started, "on_complete" when it is completed, "on_milestone" when you call mark_milestone_complete, "on_date" when its date passes, or "manual" for one a person decides about. Defaults to on_start for the first entry, on_complete for the last, and on_milestone in between.'
    ),
  due_on: DATE_FIELD.optional().describe('The date an "on_date" entry becomes billable, YYYY-MM-DD.'),
})

export function registerEngagementTools(server: McpServer, ctx: McpCtx) {
  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------
  server.registerTool(
    'list_engagements',
    {
      title: 'List Engagements',
      description:
        'List engagements: agreed pieces of work with a total and a payment schedule, for example "12,000 for the website rebuild, 50% up front and 50% on delivery". Use this to answer "what have we agreed with this client" or "what is still unbilled on this project". Each one reports how much has been billed, how much is left, and how many schedule entries are ready to bill now. Read-only, and nothing in the engagement tools ever sends anything to a client.',
      inputSchema: z.object({
        offset: z
          .number()
          .int()
          .min(0)
          .max(1000000)
          .optional()
          .describe('Page offset. Start at 0, then use next_offset until it is null. Keep other filters unchanged.'),
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe('Id of the business whose engagements to list. Omit to list across every business in scope.'),
        client_id: z.string().uuid().optional().describe('Filter to engagements for this client only.'),
        status: z
          .enum(ENGAGEMENT_STATUSES)
          .optional()
          .describe('Filter by status: draft, active, paused, completed, or cancelled.'),
        has_ready_to_bill: z
          .boolean()
          .optional()
          .describe('True to list only engagements with at least one schedule entry ready to bill right now.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max engagements to return (default 20, max 100).'),
      }),
    },
    async ({ offset, business_id, client_id, status, has_ready_to_bill, limit }) => {
      let businessIds = ctx.db.scope.businessIds
      if (business_id !== undefined) {
        try {
          businessIds = [ctx.db.resolveBusinessId(business_id)]
        } catch (err) {
          return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve business.')
        }
      }

      await sweep(ctx, businessIds)

      const resolvedLimit = limit ?? LIST_LIMIT_DEFAULT
      const resolvedOffset = offset ?? 0

      let query = ctx.db.svc
        .from('engagement_summary')
        .select('*')
        .in('business_id', ctx.db.scope.businessIds)
        .in('business_id', businessIds)
        .order('status', { ascending: true })
        .order('engagement_id', { ascending: true })
        .range(resolvedOffset, resolvedOffset + resolvedLimit - 1)

      if (client_id) query = query.eq('client_id', client_id)
      if (status) query = query.eq('status', status)
      if (has_ready_to_bill) query = query.gt('ready_count', 0)

      const { data, error } = await query
      if (error) {
        console.error('list_engagements:', error)
        return errorResult('Could not list engagements.')
      }

      const rows = (data ?? []) as SummaryRow[]
      const names = await clientNames(ctx, businessIds, rows.map((row) => row.client_id))

      const engagements = rows.map((row) => ({
        id: row.engagement_id,
        business_id: row.business_id,
        client_id: row.client_id,
        client_name: names.get(row.client_id) ?? null,
        name: row.name,
        status: row.status,
        billing_mode: row.billing_mode,
        currency: row.currency,
        total: row.total,
        amount_billed: row.amount_billed,
        amount_remaining: row.amount_remaining,
        amount_waived: row.amount_waived,
        ready_count: row.ready_count,
        ready_amount: row.ready_amount,
        starts_on: row.starts_on,
        target_end: row.target_end,
        app_url: `${appUrl()}/engagements/${row.engagement_id}`,
      }))

      const truncated = engagements.length === resolvedLimit
      const readyTotal = engagements.reduce((sum, row) => sum + row.ready_count, 0)

      return jsonResult({
        offset: resolvedOffset,
        next_offset: truncated ? resolvedOffset + resolvedLimit : null,
        summary: `${engagements.length} engagement${engagements.length === 1 ? '' : 's'}${status ? ` with status "${status}"` : ''}, ${readyTotal} schedule ${readyTotal === 1 ? 'entry' : 'entries'} ready to bill${truncated ? truncationNote(resolvedLimit) : ''}`,
        engagements,
      })
    }
  )

  server.registerTool(
    'get_engagement',
    {
      title: 'Get Engagement',
      description:
        'Read one engagement in full: the agreed total, what has been billed, what is left, and every schedule entry with its status, its due rule and the invoice it became. Use this before billing anything, so you bill the entries that are ready and not the ones that are already invoiced. Read-only, and nothing is sent to anyone.',
      inputSchema: z.object({
        engagement_id: z
          .string()
          .uuid()
          .describe('Id of the engagement, from list_engagements or create_engagement.'),
      }),
    },
    async ({ engagement_id }) => {
      const businessIds = ctx.db.scope.businessIds
      await sweep(ctx, businessIds)

      const { data, error } = await ctx.db.svc
        .from('engagement_summary')
        .select('*')
        .eq('engagement_id', engagement_id)
        .in('business_id', businessIds)
        .maybeSingle()

      if (error) console.error('get_engagement (summary):', error)
      // Missing and out of scope answer identically: no existence oracle.
      if (error || !data) return errorResult('Engagement not found')

      const summary = data as SummaryRow

      const [{ data: entries, error: entriesError }, names] = await Promise.all([
        ctx.db.svc
          .from('engagement_entries')
          .select(
            'id, engagement_id, position, label, amount, percent, due_rule, due_on, status, invoice_id, completed_at, waived_reason'
          )
          .eq('engagement_id', engagement_id)
          .eq('business_id', summary.business_id)
          .order('position', { ascending: true })
          .limit(MAX_ENTRIES),
        clientNames(ctx, businessIds, [summary.client_id]),
      ])

      if (entriesError) {
        console.error('get_engagement (entries):', entriesError)
        return errorResult('Could not load the schedule for this engagement.')
      }

      const rows = (entries ?? []) as EntryRow[]
      const billed = formatCurrency(summary.amount_billed, summary.currency)
      const remaining = formatCurrency(summary.amount_remaining, summary.currency)

      return jsonResult({
        summary: `${summary.name} for ${names.get(summary.client_id) ?? 'unknown client'}: ${formatCurrency(summary.total, summary.currency)} agreed, ${billed} billed, ${remaining} remaining (${summary.status}). ${summary.ready_count} schedule ${summary.ready_count === 1 ? 'entry is' : 'entries are'} ready to bill.`,
        engagement: {
          id: summary.engagement_id,
          business_id: summary.business_id,
          client_id: summary.client_id,
          client_name: names.get(summary.client_id) ?? null,
          name: summary.name,
          status: summary.status,
          billing_mode: summary.billing_mode,
          currency: summary.currency,
          total: summary.total,
          amount_billed: summary.amount_billed,
          amount_waived: summary.amount_waived,
          amount_remaining: summary.amount_remaining,
          ready_count: summary.ready_count,
          ready_amount: summary.ready_amount,
          starts_on: summary.starts_on,
          target_end: summary.target_end,
          app_url: `${appUrl()}/engagements/${summary.engagement_id}`,
        },
        schedule: rows.map((entry) => entryView(entry, summary.currency)),
      })
    }
  )

  server.registerTool(
    'list_ready_to_bill',
    {
      title: 'List Ready to Bill',
      description:
        'List every engagement schedule entry that is ready to bill right now, across all clients. This is the "what should I invoice today" list: deposits on engagements that have started, milestones marked complete, dated payments whose date has passed, and final payments on completed engagements. Each entry reports its due_on date and an overdue_on_date flag when that date has already gone by. Nothing here has been invoiced yet, and nothing is sent to anyone by looking. Pass the entry_ids you want to bill to create_invoice as engagement_entry_ids. Read-only.',
      inputSchema: z.object({
        offset: z
          .number()
          .int()
          .min(0)
          .max(1000000)
          .optional()
          .describe('Page offset. Start at 0, then use next_offset until it is null. Keep other filters unchanged.'),
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe('Id of the business to look at. Omit to look across every business in scope.'),
        client_id: z.string().uuid().optional().describe('Filter to one client only.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max entries to return (default 50, max 200).'),
      }),
    },
    async ({ offset, business_id, client_id, limit }) => {
      let businessIds = ctx.db.scope.businessIds
      if (business_id !== undefined) {
        try {
          businessIds = [ctx.db.resolveBusinessId(business_id)]
        } catch (err) {
          return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve business.')
        }
      }

      await sweep(ctx, businessIds)

      const resolvedLimit = limit ?? READY_LIMIT_DEFAULT
      const resolvedOffset = offset ?? 0

      const query = ctx.db.svc
        .from('engagement_entries')
        .select(
          'id, engagement_id, business_id, position, label, amount, due_rule, due_on, status, engagement:engagements(name, currency, client_id, status)'
        )
        .in('business_id', ctx.db.scope.businessIds)
        .in('business_id', businessIds)
        .eq('status', 'ready_to_bill')
        .order('due_on', { ascending: true })
        .order('id', { ascending: true })
        .range(resolvedOffset, resolvedOffset + resolvedLimit - 1)

      const { data, error } = await query
      if (error) {
        console.error('list_ready_to_bill:', error)
        return errorResult('Could not list the work that is ready to bill.')
      }

      type Joined = EntryRow & {
        business_id: string
        engagement: { name: string; currency: string; client_id: string; status: string } | null
      }
      let rows = (data ?? []) as Joined[]
      if (client_id) rows = rows.filter((row) => row.engagement?.client_id === client_id)

      const names = await clientNames(
        ctx,
        businessIds,
        rows.map((row) => row.engagement?.client_id).filter((id): id is string => !!id)
      )

      // An entry whose date has passed is already ready to bill by the time it
      // is read (the sweep above is what promoted it), so "overdue" here means
      // the money has been billable since that date and still is not on an
      // invoice. It is a flag rather than a separate list, so an agent sorting
      // by urgency does not have to work the dates out itself.
      const today = todayISO()
      const entries = rows.map((row) => ({
        entry_id: row.id,
        engagement_id: row.engagement_id,
        engagement_name: row.engagement?.name ?? null,
        engagement_status: row.engagement?.status ?? null,
        business_id: row.business_id,
        client_id: row.engagement?.client_id ?? null,
        client_name: row.engagement?.client_id ? (names.get(row.engagement.client_id) ?? null) : null,
        label: row.label,
        amount: row.amount,
        currency: row.engagement?.currency ?? null,
        due_rule: row.due_rule,
        due_on: row.due_on,
        overdue_on_date: row.due_rule === 'on_date' && !!row.due_on && row.due_on <= today,
        new_invoice_url: `${appUrl()}/invoices/new?engagement_entries=${row.id}`,
        app_url: `${appUrl()}/engagements/${row.engagement_id}`,
      }))

      const truncated = (data ?? []).length === resolvedLimit
      const byCurrency = new Map<string, number>()
      for (const entry of entries) {
        const currency = entry.currency ?? 'USD'
        byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + entry.amount)
      }
      const totals = [...byCurrency.entries()].map(([currency, amount]) => formatCurrency(amount, currency))
      const overdue = entries.filter((entry) => entry.overdue_on_date).length

      return jsonResult({
        offset: resolvedOffset,
        next_offset: truncated ? resolvedOffset + resolvedLimit : null,
        summary: `${entries.length} schedule ${entries.length === 1 ? 'entry is' : 'entries are'} ready to bill${totals.length ? `, worth ${totals.join(' plus ')}` : ''}${overdue > 0 ? `, ${overdue} of them past a date that has already passed` : ''}${truncated ? truncationNote(resolvedLimit) : ''}. Pass their entry_ids to create_invoice as engagement_entry_ids to bill them.`,
        overdue_count: overdue,
        entries,
      })
    }
  )

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------
  server.registerTool(
    'create_engagement',
    {
      title: 'Create Engagement',
      description:
        'Record an agreed piece of work with a total and a payment schedule, for example "12,000 for the rebuild, 50% deposit and 50% on delivery" or "9,000 in 3 equal installments". The schedule is worked out on the server so the entries always add up to exactly the total; the last entry absorbs any rounding. Nothing is billed and nothing is sent by creating one: entries become ready to bill as their due rules fire, and you then raise an invoice for them. Use create_estimate instead when the price has not been agreed yet, and create_invoice when work is already delivered and should be billed now.',
      inputSchema: z.object({
        request_id: z.uuid().describe('Stable request ID. Reuse with identical input on retries.'),
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe('Id of the business. Optional when the API key is scoped to exactly one business; required if scoped to multiple.'),
        client_id: z.string().uuid().optional().describe('Id of the client. Provide this or client_name.'),
        client_name: z
          .string()
          .max(200)
          .optional()
          .describe('Exact (case-insensitive) client name. Provide this or client_id.'),
        name: z.string().min(1).max(200).describe('What was agreed, for example "Website rebuild".'),
        total: z.number().positive().describe('The agreed total for the whole engagement, in the engagement currency.'),
        currency: z
          .string()
          .length(3)
          .optional()
          .describe('Three letter currency code. Defaults to the client currency, then the business default.'),
        billing_mode: z
          .enum(BILLING_MODES)
          .describe(
            'How the total is split: "percent_split" (each entry carries a percent), "equal_installments" (n equal parts, set installments), "milestones" (each entry carries its own amount), or "manual" (amounts you state, each waiting for a person).'
          ),
        entries: z
          .array(scheduleEntryInput)
          .max(MAX_ENTRIES)
          .optional()
          .describe('The schedule. Required for percent_split, milestones and manual. Optional for equal_installments, where it only names the parts.'),
        installments: z
          .number()
          .int()
          .min(1)
          .max(MAX_ENTRIES)
          .optional()
          .describe('How many equal parts to split the total into. Only for billing_mode "equal_installments".'),
        start_now: z
          .boolean()
          .optional()
          .describe('True to start the engagement immediately, which makes any "on_start" entry ready to bill. Defaults to false, which leaves it as a draft.'),
        starts_on: DATE_FIELD.optional().describe('Date the work starts, YYYY-MM-DD.'),
        target_end: DATE_FIELD.optional().describe('Date the work is meant to finish, YYYY-MM-DD.'),
        notes: z.string().max(2000).optional().describe('Internal notes about the agreement. Never shown to the client.'),
        source_estimate_id: z
          .string()
          .uuid()
          .optional()
          .describe('Id of the estimate this agreement came from, if it started as a quote.'),
      }),
    },
    async ({
      request_id,
      business_id,
      client_id,
      client_name,
      name,
      total,
      currency,
      billing_mode,
      entries,
      installments,
      start_now,
      starts_on,
      target_end,
      notes,
      source_estimate_id,
    }) => {
      let resolvedBusinessId: string
      try {
        resolvedBusinessId = ctx.db.resolveBusinessId(business_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve business.')
      }

      let client
      try {
        client = await resolveClient(ctx, resolvedBusinessId, client_id, client_name)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve client.')
      }

      const { data, error } = await ctx.db.svc.rpc('create_engagement_with_schedule', {
        p_request_id: request_id,
        p_business_id: resolvedBusinessId,
        p_client_id: client.id,
        p_name: name,
        p_total: total,
        p_currency: currency ?? '',
        p_billing_mode: billing_mode,
        p_entries: (entries ?? []) as never,
        p_installments: installments,
        p_status: start_now ? 'active' : 'draft',
        p_starts_on: starts_on,
        p_target_end: target_end,
        p_notes: notes,
        p_source_estimate_id: source_estimate_id,
        p_actor_key_id: ctx.keyId,
      })

      if (error || !data) return errorResult(engagementError(error, 'Could not create that engagement.'))

      const result = payloadResult(data, '')
      const ready = result.schedule.filter((entry) => entry.status === 'ready_to_bill').length
      result.summary = `Recorded ${result.engagement.name} for ${client.name}: ${formatCurrency(result.engagement.total, result.engagement.currency)} across ${result.schedule.length} schedule ${result.schedule.length === 1 ? 'entry' : 'entries'} (${result.engagement.status}). ${ready} ready to bill now. Nothing was sent to the client.`
      return jsonResult(result)
    }
  )

  server.registerTool(
    'update_engagement',
    {
      title: 'Update Engagement',
      description:
        'Correct the details around an engagement: its name, the dates it runs between, or its internal notes. Fields left out are kept as they are. The agreed total, the currency, the billing mode and the schedule are deliberately not editable here, because changing an agreed number after work has been billed against it is a renegotiation rather than an edit. Nothing is sent to anyone.',
      inputSchema: z.object({
        request_id: z.uuid().describe('Stable request ID. Reuse with identical input on retries.'),
        engagement_id: z.string().uuid().describe('Id of the engagement to update.'),
        name: z.string().min(1).max(200).optional().describe('Corrected name for the engagement.'),
        starts_on: DATE_FIELD.optional().describe('Corrected start date, YYYY-MM-DD.'),
        target_end: DATE_FIELD.optional().describe('Corrected target end date, YYYY-MM-DD.'),
        notes: z.string().max(2000).optional().describe('Corrected internal notes. Never shown to the client.'),
      }),
    },
    async ({ request_id, engagement_id, name, starts_on, target_end, notes }) => {
      if (
        name === undefined &&
        starts_on === undefined &&
        target_end === undefined &&
        notes === undefined
      ) {
        return errorResult('Pass at least one field to change.')
      }

      const { data, error } = await ctx.db.svc.rpc('update_engagement', {
        p_request_id: request_id,
        p_engagement_id: engagement_id,
        p_name: name,
        p_starts_on: starts_on,
        p_target_end: target_end,
        p_notes: notes,
        p_actor_key_id: ctx.keyId,
      })

      if (error || !data) return errorResult(engagementError(error, 'Could not update that engagement.'))

      const result = payloadResult(data, '')
      result.summary = `Updated ${result.engagement.name}. ${formatCurrency(result.engagement.amount_remaining, result.engagement.currency)} of ${formatCurrency(result.engagement.total, result.engagement.currency)} is still unbilled.`
      return jsonResult(result)
    }
  )

  server.registerTool(
    'mark_milestone_complete',
    {
      title: 'Mark Milestone Complete',
      description:
        'Record that a schedule entry has been delivered. An entry waiting on a milestone becomes ready to bill; an entry waiting on the start or the end of the engagement, or on a date, keeps its own rule and is simply stamped complete. Nothing is invoiced and nothing is sent: use list_ready_to_bill to see what this freed up, then raise an invoice for it.',
      inputSchema: z.object({
        request_id: z.uuid().describe('Stable request ID. Reuse with identical input on retries.'),
        entry_id: z
          .string()
          .uuid()
          .describe('Id of the schedule entry, from get_engagement or list_ready_to_bill.'),
      }),
    },
    async ({ request_id, entry_id }) => {
      const { data, error } = await ctx.db.svc.rpc('mark_entry_complete', {
        p_request_id: request_id,
        p_entry_id: entry_id,
        p_actor_key_id: ctx.keyId,
      })

      if (error || !data) return errorResult(engagementError(error, 'Could not mark that entry complete.'))

      const payload = data as unknown as EngagementPayload
      const result = payloadResult(data, '')
      const entry = payload.entry
      const readyNote = payload.became_ready_to_bill
        ? `${formatCurrency(entry?.amount ?? 0, result.engagement.currency)} is now ready to bill.`
        : 'It is still waiting on its own due rule before it can be billed.'
      result.summary = `Marked "${entry?.label ?? 'the entry'}" complete on ${result.engagement.name}. ${readyNote} Nothing was sent to the client.`
      return jsonResult(result)
    }
  )

  server.registerTool(
    'complete_engagement',
    {
      title: 'Complete Engagement',
      description:
        'Close out an engagement: the work is finished. Every schedule entry waiting on completion becomes ready to bill, and if any money is left unbilled the answer says how much, so nothing is quietly forgotten. Completing does not invoice anything and does not send anything. A completed engagement cannot be reopened, so do this when the work really is done.',
      inputSchema: z.object({
        request_id: z.uuid().describe('Stable request ID. Reuse with identical input on retries.'),
        engagement_id: z.string().uuid().describe('Id of the engagement to complete.'),
      }),
    },
    async ({ request_id, engagement_id }) => {
      const { data, error } = await ctx.db.svc.rpc('set_engagement_status', {
        p_request_id: request_id,
        p_engagement_id: engagement_id,
        p_status: 'completed',
        p_actor_key_id: ctx.keyId,
      })

      if (error || !data) return errorResult(engagementError(error, 'Could not complete that engagement.'))

      const payload = data as unknown as EngagementPayload
      const result = payloadResult(data, '')
      const ready = result.schedule.filter((entry) => entry.status === 'ready_to_bill').length
      const warning = payload.warning
        ? ` ${formatCurrency(result.engagement.amount_remaining, result.engagement.currency)} of the agreed ${formatCurrency(result.engagement.total, result.engagement.currency)} is still unbilled. Bill the remaining entries or waive them.`
        : ''
      result.summary = `Completed ${result.engagement.name}. ${ready} schedule ${ready === 1 ? 'entry is' : 'entries are'} ready to bill.${warning} Nothing was sent to the client.`
      return jsonResult({ ...result, warning: payload.warning ?? null })
    }
  )

  server.registerTool(
    'convert_estimate_to_engagement',
    {
      title: 'Convert Estimate to Engagement',
      description:
        'Turn an accepted estimate into an engagement: the same client, the same total and the same currency, now with a payment schedule instead of a single bill. Use this when the quote was agreed but the work will be billed in parts, and convert_estimate_to_invoice when the whole amount is due at once. An estimate can become one or the other, never both, so this refuses a quote that already became an invoice or an engagement. The engagement is created as a draft and nothing is billed or sent: start it when the work begins, which is what makes any deposit ready to bill.',
      inputSchema: z.object({
        request_id: z.uuid().describe('Stable request ID. Reuse with identical input on retries.'),
        estimate_id: z
          .string()
          .uuid()
          .describe('Id of the accepted estimate to convert, from list_estimates or get_estimate.'),
        billing_mode: z
          .enum(BILLING_MODES)
          .describe(
            'How the quoted total is split: "percent_split" (each entry carries a percent), "equal_installments" (n equal parts, set installments), "milestones" (each entry carries its own amount), or "manual" (amounts you state, each waiting for a person).'
          ),
        entries: z
          .array(scheduleEntryInput)
          .max(MAX_ENTRIES)
          .optional()
          .describe('The schedule. Required for percent_split, milestones and manual. Optional for equal_installments, where it only names the parts.'),
        installments: z
          .number()
          .int()
          .min(1)
          .max(MAX_ENTRIES)
          .optional()
          .describe('How many equal parts to split the quoted total into. Only for billing_mode "equal_installments".'),
      }),
    },
    async ({ request_id, estimate_id, billing_mode, entries, installments }) => {
      // The estimate is scoped inside the RPC, which resolves the actor
      // against the estimate's own business and refuses anything the key
      // cannot reach, so an out of scope id answers "not found" like a missing
      // one. The total and the currency are read there too, never sent here.
      const { data, error } = await ctx.db.svc.rpc('convert_estimate_to_engagement', {
        p_request_id: request_id,
        p_estimate_id: estimate_id,
        p_billing_mode: billing_mode,
        p_entries: (entries ?? []) as never,
        p_installments: installments,
        p_actor_key_id: ctx.keyId,
      })

      if (error || !data) {
        return errorResult(engagementError(error, 'Could not turn that estimate into an engagement.'))
      }

      const result = payloadResult(data, '')
      result.summary = `Turned the estimate into ${result.engagement.name}: ${formatCurrency(result.engagement.total, result.engagement.currency)} across ${result.schedule.length} schedule ${result.schedule.length === 1 ? 'entry' : 'entries'}. It is a draft, so nothing is billable yet. Start it with the app or by setting the engagement going when the work begins. Nothing was sent to the client.`
      return jsonResult(result)
    }
  )

  server.registerTool(
    'waive_engagement_entry',
    {
      title: 'Waive Engagement Entry',
      description:
        'Write off a schedule entry that will not be charged, with a reason. The entry stays in the schedule so the agreement still reads the way it was agreed, but it stops counting towards what is left to bill. Use this when part of the work was dropped or absorbed. An entry that has already been invoiced cannot be waived: that is a credit note, and it belongs on the invoice. Nothing is sent to anyone.',
      inputSchema: z.object({
        request_id: z.uuid().describe('Stable request ID. Reuse with identical input on retries.'),
        entry_id: z.string().uuid().describe('Id of the schedule entry to waive, from get_engagement.'),
        reason: z
          .string()
          .min(1)
          .max(2000)
          .describe('Why this money will not be charged. Kept on the entry and shown in the app.'),
      }),
    },
    async ({ request_id, entry_id, reason }) => {
      const { data, error } = await ctx.db.svc.rpc('waive_entry', {
        p_request_id: request_id,
        p_entry_id: entry_id,
        p_reason: reason,
        p_actor_key_id: ctx.keyId,
      })

      if (error || !data) return errorResult(engagementError(error, 'Could not waive that entry.'))

      const payload = data as unknown as EngagementPayload
      const result = payloadResult(data, '')
      result.summary = `Waived ${formatCurrency(payload.entry?.amount ?? 0, result.engagement.currency)} on ${result.engagement.name}. ${formatCurrency(result.engagement.amount_remaining, result.engagement.currency)} is still to be billed.`
      return jsonResult(result)
    }
  )
}
