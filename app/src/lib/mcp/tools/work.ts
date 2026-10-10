import { secondsFromHours, timeAmount, entrySeconds } from '@/lib/work/time'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { McpCtx } from '@/lib/mcp/context'
import { ScopeError } from '@/lib/mcp/scoped-db'
import { resolveClient } from './invoices-write'
import type { Database } from '@/types/database'
import { appUrl, errorResult, jsonResult, formatCurrency, truncationNote } from '@/lib/mcp/shared'
import { todayISO } from '@/lib/dates'

const UNBILLED_LIMIT = 500

type ClientRow = Database['public']['Tables']['clients']['Row']

function today(): string {
  return todayISO()
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

const EXPENSE_CATEGORIES = [
  'office',
  'travel',
  'meals',
  'supplies',
  'utilities',
  'software',
  'marketing',
  'professional',
  'insurance',
  'mileage',
  'other',
] as const

/**
 * Resolves an optional client for log_expense: unlike resolveClient (used by
 * create_invoice / log_time, where a client is mandatory), an expense may
 * legitimately have no client. Returns null when neither client_id nor
 * client_name is provided, otherwise delegates to resolveClient.
 */
async function resolveOptionalClient(
  ctx: McpCtx,
  resolvedBusinessId: string,
  client_id: string | undefined,
  client_name: string | undefined
): Promise<ClientRow | null> {
  if (!client_id && !client_name) {
    return null
  }
  return resolveClient(ctx, resolvedBusinessId, client_id, client_name)
}

/**
 * Registers the work-logging tools (log_time, log_expense, list_unbilled) on
 * the given MCP server, scoped to the businesses in ctx.db.scope.
 *
 * Schema mapping (see supabase/migrations/00001_baseline.sql and the
 * app's own insert paths in src/app/(app)/time/new/page.tsx and
 * src/app/(app)/expenses/new/page.tsx, which these tools mirror):
 *   time_entries: hours -> duration_minutes (hours * 60, rounded); rate ->
 *     hourly_rate (nullable: left null, not 0, when the caller omits it, so
 *     list_unbilled can distinguish "no rate" from "explicit $0 rate");
 *     amount = hours * rate when a rate is given, else null; billable ->
 *     is_billable (default true); "unbilled" = invoice_id IS NULL.
 *   expenses: amount is a flat DECIMAL (no unit conversion); billable ->
 *     is_billable (defaults true only when a client is attached, since an
 *     expense with no client can't be put on a client invoice); currency
 *     comes from the business's default_currency, matching the app's own
 *     expense form; "unbilled" = invoice_id IS NULL.
 */
export function registerWorkTools(server: McpServer, ctx: McpCtx) {
  server.registerTool(
    'log_time',
    {
      title: 'Log Time',
      description:
        'Log a time entry for a client, identified by client_id or client_name (exact match, case-insensitive). Billable by default.',
      inputSchema: z.object({
        request_id: z.uuid().describe('Stable work-entry ID. Reuse identical input on retries.'),
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Id of the business to log time under. Optional when the API key is scoped to exactly one business; required if scoped to multiple.'
          ),
        client_id: z.string().uuid().optional().describe('Id of the client. Provide this or client_name.'),
        client_name: z
          .string()
          .max(200)
          .optional()
          .describe('Exact (case-insensitive) client name. Provide this or client_id.'),
        description: z.string().min(1).max(500).describe('What the time was spent on.'),
        hours: z.number().gt(0).lte(24).describe('Hours worked, > 0 and <= 24.'),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
          .optional()
          .describe('Date of the work, YYYY-MM-DD. Defaults to today.'),
        rate: z
          .number()
          .min(0)
          .optional()
          .describe(
            'Hourly rate for this entry. If omitted, the entry is logged without a rate and flagged by list_unbilled so it can be confirmed before invoicing.'
          ),
        billable: z.boolean().optional().describe('Whether this time is billable. Defaults to true.'),
      }),
    },
    async ({ request_id, business_id, client_id, client_name, description, hours, date, rate, billable }) => {
      let resolvedBusinessId: string
      try {
        resolvedBusinessId = ctx.db.resolveBusinessId(business_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve business.')
      }

      let client: ClientRow
      try {
        client = await resolveClient(ctx, resolvedBusinessId, client_id, client_name)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve client.')
      }

      const resolvedDate = date || today()
      const isBillable = billable ?? true
      const durationSeconds = secondsFromHours(hours)
      const hourlyRate = rate ?? null
      const amount = timeAmount(durationSeconds, hourlyRate)

      const {data:created,error}=await ctx.db.svc.rpc('create_work_entry_once',{p_business_id:resolvedBusinessId,p_kind:'time',p_request_id:request_id,p_key_id:ctx.keyId,p_record:{
          business_id: resolvedBusinessId,
          client_id: client.id,
          description,
          date: resolvedDate,
          currency: client.currency,
          duration_seconds: durationSeconds,
          hourly_rate: hourlyRate,
          amount,
          is_billable: isBillable,
          is_billed: false,
          created_via: 'agent',
          created_by_key_id: ctx.keyId,
        }})
      const entry=created as Database['public']['Tables']['time_entries']['Row'] | null

      if (error || !entry) {
        console.error('log_time (insert):', error)
        return errorResult('Could not log time entry.')
      }

      const noRateNote = rate === undefined ? ' (no rate set; confirm before invoicing)' : ''
      const result = {
        summary: `Logged ${hours}h for ${client.name}${noRateNote}`,
        time_entry: {
          id: entry.id,
          business_id: entry.business_id,
          client_id: entry.client_id,
          description: entry.description,
          date: entry.date,
          hours,
          rate: entry.hourly_rate,
          amount: entry.amount,
          is_billable: entry.is_billable,
        },
        app_url: `${appUrl()}/time`,
      }

      return jsonResult(result)
    }
  )

  server.registerTool(
    'log_expense',
    {
      title: 'Log Expense',
      description:
        "Log a business expense. A client is optional; identify one by client_id or client_name (exact match, case-insensitive) to attach the expense for later billing.",
      inputSchema: z.object({
        request_id: z.uuid().describe('Stable work-entry ID. Reuse identical input on retries.'),
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Id of the business to log the expense under. Optional when the API key is scoped to exactly one business; required if scoped to multiple.'
          ),
        client_id: z.string().uuid().optional().describe('Id of the client this expense is for, if any.'),
        client_name: z
          .string()
          .max(200)
          .optional()
          .describe('Exact (case-insensitive) client name this expense is for, if any.'),
        description: z.string().min(1).max(500).describe('What the expense was for.'),
        amount: z.number().gt(0).describe('Expense amount, must be > 0.'),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
          .optional()
          .describe('Date of the expense, YYYY-MM-DD. Defaults to today.'),
        category: z
          .enum(EXPENSE_CATEGORIES)
          .optional()
          .describe('Expense category. Defaults to "other".'),
        billable: z
          .boolean()
          .optional()
          .describe(
            'Whether this expense is billable to the client. Defaults to true when a client is attached, false otherwise.'
          ),
      }),
    },
    async ({ request_id, business_id, client_id, client_name, description, amount, date, category, billable }) => {
      let resolvedBusinessId: string
      try {
        resolvedBusinessId = ctx.db.resolveBusinessId(business_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve business.')
      }

      let client: ClientRow | null
      try {
        client = await resolveOptionalClient(ctx, resolvedBusinessId, client_id, client_name)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve client.')
      }

      const { data: business, error: businessError } = await ctx.db.svc
        .from('businesses')
        .select('default_currency')
        .eq('id', resolvedBusinessId)
        .maybeSingle()

      if (businessError || !business) {
        console.error('log_expense (business):', businessError)
        return errorResult('Could not load business.')
      }

      const resolvedDate = date || today()
      const isBillable = billable ?? !!client

      const {data:created,error}=await ctx.db.svc.rpc('create_work_entry_once',{p_business_id:resolvedBusinessId,p_kind:'expense',p_request_id:request_id,p_key_id:ctx.keyId,p_record:{
          business_id: resolvedBusinessId,
          client_id: client?.id ?? null,
          category: category ?? 'other',
          description,
          amount,
          currency: client?.currency || business.default_currency,
          date: resolvedDate,
          is_billable: isBillable,
          is_billed: false,
          created_via: 'agent',
          created_by_key_id: ctx.keyId,
        }})
      const expense=created as Database['public']['Tables']['expenses']['Row'] | null

      if (error || !expense) {
        console.error('log_expense (insert):', error)
        return errorResult('Could not log expense.')
      }

      const forClient = client ? ` for ${client.name}` : ''
      const result = {
        summary: `Logged ${formatCurrency(amount, expense.currency)} expense${forClient}`,
        expense: {
          id: expense.id,
          business_id: expense.business_id,
          client_id: expense.client_id,
          description: expense.description,
          amount: expense.amount,
          currency: expense.currency,
          date: expense.date,
          category: expense.category,
          is_billable: expense.is_billable,
        },
        app_url: `${appUrl()}/expenses`,
      }

      return jsonResult(result)
    }
  )

  server.registerTool(
    'list_unbilled',
    {
      title: 'List Unbilled Work',
      description:
        'List billable time entries and expenses not yet attached to an invoice, grouped by client with totals. Use this to draft an invoice from a client\'s unbilled work; entries missing an hourly rate are flagged. Billable entries with no client can\'t be grouped into a client invoice, so they\'re excluded from `clients` but still surfaced via the summary and the `unassigned` field.',
      inputSchema: z.object({
        offset: z.number().int().min(0).max(1000000).optional().describe('Page offset for time and expenses. Totals apply to this page only; follow next_offset for more work.'),
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Id of the business to list unbilled work for. Optional when the API key is scoped to exactly one business; required if scoped to multiple.'
          ),
        client_id: z.string().uuid().optional().describe('Restrict to a single client.'),
      }),
    },
    async ({ offset, business_id, client_id }) => {
      let resolvedBusinessId: string
      try {
        resolvedBusinessId = ctx.db.resolveBusinessId(business_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve business.')
      }

      if (client_id) {
        try {
          const client = await ctx.db.assertClientAccess(client_id)
          if (client.business_id !== resolvedBusinessId) {
            return errorResult(`Client ${client_id} does not belong to business ${resolvedBusinessId}.`)
          }
        } catch (err) {
          return errorResult(err instanceof ScopeError ? err.message : 'Could not access client.')
        }
      }

      const { data: business, error: businessError } = await ctx.db.svc
        .from('businesses')
        .select('default_currency')
        .eq('id', resolvedBusinessId)
        .maybeSingle()

      if (businessError || !business) {
        console.error('list_unbilled (business):', businessError)
        return errorResult('Could not load business.')
      }

      let timeQuery = ctx.db.svc
        .from('time_entries')
        .select('id, client_id, currency, description, date, duration_seconds, duration_minutes, hourly_rate, amount, clients(name)')
        .eq('business_id', resolvedBusinessId)
        .eq('is_billable', true)
        .is('invoice_id', null)
        .order('date', { ascending: true })
        .order('id',{ascending:true}).range(offset ?? 0, (offset ?? 0)+UNBILLED_LIMIT-1)

      let expenseQuery = ctx.db.svc
        .from('expenses')
        .select('id, client_id, currency, description, date, amount, category, clients(name)')
        .eq('business_id', resolvedBusinessId)
        .eq('is_billable', true)
        .is('invoice_id', null)
        .order('date', { ascending: true })
        .order('id',{ascending:true}).range(offset ?? 0, (offset ?? 0)+UNBILLED_LIMIT-1)

      if (client_id) {
        timeQuery = timeQuery.eq('client_id', client_id)
        expenseQuery = expenseQuery.eq('client_id', client_id)
      }

      const [{ data: timeRows, error: timeError }, { data: expenseRows, error: expenseError }] =
        await Promise.all([timeQuery, expenseQuery])

      if (timeError) {
        console.error('list_unbilled (time_entries):', timeError)
        return errorResult('Could not load unbilled time entries.')
      }

      if (expenseError) {
        console.error('list_unbilled (expenses):', expenseError)
        return errorResult('Could not load unbilled expenses.')
      }

      interface ClientBucket {
        client_id: string
        client_name: string
        currency: string
        time: {
          id: string
          date: string
          description: string | null
          hours: number
          rate: number | null
          amount: number
          missing_rate: boolean
        }[]
        expenses: {
          id: string
          date: string
          description: string | null
          category: string | null
          amount: number
        }[]
        total_unbilled: number
      }

      const buckets = new Map<string, ClientBucket>()
      let missingRateCount = 0
      let unassignedTimeCount = 0
      let unassignedExpenseCount = 0
      let unassignedTotal = 0
      const unassignedByCurrency: Record<string,number> = {}

      function bucketFor(clientId: string, clientName: string | null, currency: string): ClientBucket {
        const key = `${clientId}:${currency}`
        let bucket = buckets.get(key)
        if (!bucket) {
          bucket = {
            client_id: clientId,
            client_name: clientName ?? 'Unknown client',
            currency,
            time: [],
            expenses: [],
            total_unbilled: 0,
          }
          buckets.set(key, bucket)
        }
        return bucket
      }

      for (const row of timeRows ?? []) {
        const hours = entrySeconds(row) / 3600
        const missingRate = row.hourly_rate === null
        const amount = round2(hours * (row.hourly_rate ?? 0))

        if (!row.client_id) {
          // Billable and unbilled, but not attached to any client, so it can't be
          // grouped into a per-client invoice. Counted separately (via
          // `unassigned` below) rather than dropped, so it stays visible.
          unassignedTimeCount += 1
          unassignedTotal = round2(unassignedTotal + amount)
          unassignedByCurrency[row.currency]=round2((unassignedByCurrency[row.currency]||0)+amount)
          continue
        }

        if (missingRate) missingRateCount += 1
        const clientName = (row.clients as { name: string } | null)?.name ?? null
        const bucket = bucketFor(row.client_id, clientName, row.currency)
        bucket.time.push({
          id: row.id,
          date: row.date,
          description: row.description,
          hours,
          rate: row.hourly_rate,
          amount,
          missing_rate: missingRate,
        })
        bucket.total_unbilled = round2(bucket.total_unbilled + amount)
      }

      for (const row of expenseRows ?? []) {
        if (!row.client_id) {
          unassignedExpenseCount += 1
          unassignedTotal = round2(unassignedTotal + row.amount)
          unassignedByCurrency[row.currency]=round2((unassignedByCurrency[row.currency]||0)+row.amount)
          continue
        }
        const clientName = (row.clients as { name: string } | null)?.name ?? null
        const bucket = bucketFor(row.client_id, clientName, row.currency)
        bucket.expenses.push({
          id: row.id,
          date: row.date,
          description: row.description,
          category: row.category,
          amount: row.amount,
        })
        bucket.total_unbilled = round2(bucket.total_unbilled + row.amount)
      }

      const clients = Array.from(buckets.values()).sort((a, b) => a.client_name.localeCompare(b.client_name))
      const totalsByCurrency: Record<string, number> = {}
      for(const c of clients) totalsByCurrency[c.currency]=round2((totalsByCurrency[c.currency]||0)+c.total_unbilled)
      const totalsLabel=Object.entries(totalsByCurrency).map(([currency,amount])=>formatCurrency(amount,currency)).join(', ')

      const countLabel = `${clients.length} billing group${clients.length === 1 ? '' : 's'}`
      const haveLabel = clients.length === 1 ? 'has' : 'have'
      const rateNote = missingRateCount > 0
        ? ` (${missingRateCount} time entr${missingRateCount === 1 ? 'y' : 'ies'} missing a rate; confirm before invoicing)`
        : ''

      const unassignedCount = unassignedTimeCount + unassignedExpenseCount
      const unassignedHaveLabel = unassignedCount === 1 ? 'has' : 'have'
      const unassignedWasLabel = unassignedCount === 1 ? 'was' : 'were'
      const unassignedNote =
        unassignedCount > 0
          ? ` (${unassignedTimeCount > 0 ? `${unassignedTimeCount} time entr${unassignedTimeCount === 1 ? 'y' : 'ies'}` : ''}${unassignedTimeCount > 0 && unassignedExpenseCount > 0 ? ' and ' : ''}${unassignedExpenseCount > 0 ? `${unassignedExpenseCount} expense${unassignedExpenseCount === 1 ? '' : 's'}` : ''} ${unassignedHaveLabel} no client and ${unassignedWasLabel} excluded; assign a client to include them)`
          : ''

      const summary =
        clients.length === 0 && unassignedCount === 0
          ? 'No unbilled work found.'
          : clients.length === 0
            ? `No client-assigned unbilled work found${unassignedNote}.`
            : `${countLabel} ${haveLabel} ${totalsLabel} unbilled${rateNote}${unassignedNote}`

      // Either side hitting its own cap means the grouped totals below are a
      // partial picture, so say so rather than letting the caller invoice off
      // an incomplete set.
      const truncated =
        (timeRows ?? []).length === UNBILLED_LIMIT || (expenseRows ?? []).length === UNBILLED_LIMIT

      const result: {
        offset: number
        next_offset: number | null
        page_totals: true
        summary: string
        clients: ClientBucket[]
        truncated?: true
        unassigned?: { time_count: number; expense_count: number; totals_by_currency: Record<string,number> }
      } = {
        offset: offset ?? 0,
        next_offset: truncated ? (offset ?? 0)+UNBILLED_LIMIT : null,
        page_totals: true,
        summary: `${summary}${truncated ? truncationNote(UNBILLED_LIMIT) : ''}`,
        clients,
      }

      if (truncated) {
        result.truncated = true
      }

      if (unassignedCount > 0) {
        result.unassigned = {
          time_count: unassignedTimeCount,
          expense_count: unassignedExpenseCount,
          totals_by_currency: unassignedByCurrency,
        }
      }

      return jsonResult(result)
    }
  )
}
