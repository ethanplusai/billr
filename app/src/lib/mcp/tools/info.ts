import { createHash } from 'node:crypto'
import { z } from 'zod'
import { format, startOfMonth, endOfMonth, startOfYear, endOfYear, subMonths } from 'date-fns'
import type { McpServer } from '@modelcontextprotocol/server'
import type { McpCtx } from '@/lib/mcp/context'
import { ScopeError } from '@/lib/mcp/scoped-db'
import { appUrl, errorResult, jsonResult, formatCurrency, isOverdue, truncationNote } from '@/lib/mcp/shared'

const periodEnum = z.enum(['this_month', 'last_month', 'this_year', 'all'])

export type Period = z.infer<typeof periodEnum>

const EXCLUDED_FROM_TOTALS = new Set(['draft', 'cancelled'])

/** Row shape the pure summary helpers below operate on. */
export interface SummaryRow {
  status: string
  total: number | null
  amount_paid: number | null
  balance_due: number | null
  currency: string
  due_date: string
  client_id: string | null
  clients?: { name: string } | null
}

const REVENUE_LIMIT = 5000

/**
 * Inclusive [start, end] issue_date bounds for a reporting period, or null for
 * "all" (no date filter). `now` is injectable so the boundary behaviour is
 * testable without freezing the system clock.
 */
export function periodRange(period: Period, now: Date = new Date()): { start: string; end: string } | null {
  switch (period) {
    case 'this_month':
      return { start: format(startOfMonth(now), 'yyyy-MM-dd'), end: format(endOfMonth(now), 'yyyy-MM-dd') }
    case 'last_month': {
      const lastMonth = subMonths(now, 1)
      return { start: format(startOfMonth(lastMonth), 'yyyy-MM-dd'), end: format(endOfMonth(lastMonth), 'yyyy-MM-dd') }
    }
    case 'this_year':
      return { start: format(startOfYear(now), 'yyyy-MM-dd'), end: format(endOfYear(now), 'yyyy-MM-dd') }
    case 'all':
      return null
  }
}

/** Sums one money field across rows, rounded to cents. */
export function sumBy(rows: SummaryRow[], field: 'total' | 'amount_paid' | 'balance_due'): number {
  return Math.round(rows.reduce((sum, inv) => sum + (inv[field] ?? 0), 0) * 100) / 100
}

/**
 * Top 5 clients by invoiced amount, highest first. Rows with no client_id are
 * skipped (they can't be attributed). Ties keep the order the clients were
 * first seen in `rows`, since Array.prototype.sort is stable, i.e. for equal
 * invoiced amounts the client whose first invoice appears earliest wins.
 */
export function topClients(rows: SummaryRow[]): { name: string; invoiced: number }[] {
  const byClient = new Map<string, { name: string; invoiced: number }>()
  for (const inv of rows) {
    if (!inv.client_id) continue
    const name = inv.clients?.name ?? 'Unknown client'
    const entry = byClient.get(inv.client_id) ?? { name, invoiced: 0 }
    entry.invoiced = Math.round((entry.invoiced + (inv.total ?? 0)) * 100) / 100
    byClient.set(inv.client_id, entry)
  }
  return Array.from(byClient.values())
    .sort((a, b) => b.invoiced - a.invoiced)
    .slice(0, 5)
}

export interface CurrencyTotals {
  currency: string
  invoiced_total: number
  paid_total: number
  outstanding_total: number
  overdue_total: number
  top_clients: { name: string; invoiced: number }[]
}

/**
 * Per-currency totals for the given rows, in first-seen currency order.
 * Totals are never summed across currencies; a combined number would be
 * meaningless.
 */
export function summarizeByCurrency(rows: SummaryRow[]): CurrencyTotals[] {
  const currencies = Array.from(new Set(rows.map((inv) => inv.currency)))
  return currencies.map((currency) => {
    const group = rows.filter((inv) => inv.currency === currency)
    const overdueRows = group.filter((inv) => isOverdue(inv.status, inv.due_date))
    return {
      currency,
      invoiced_total: sumBy(group, 'total'),
      paid_total: sumBy(group, 'amount_paid'),
      outstanding_total: sumBy(group, 'balance_due'),
      overdue_total: sumBy(overdueRows, 'balance_due'),
      top_clients: topClients(group),
    }
  })
}

/**
 * Registers the informational/reporting tools (list_businesses, get_business,
 * revenue_summary) on the given MCP server, scoped to the businesses in
 * ctx.db.scope.
 */
export function registerInfoTools(server: McpServer, ctx: McpCtx) {
  // ChatGPT and Codex call this to tell connected accounts apart, so someone
  // with two Billr logins can see which one a conversation is using. The id is
  // a hash of the user id: stable across reconnects, and not the internal id.
  server.registerTool(
    'get_profile',
    {
      title: 'Get Profile',
      description:
        'Return the Billr account this connection signs in as: a stable opaque id, the name and the email address. Use it to confirm which Billr login is connected; use list_businesses for the businesses it can act on.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        id: z.string().min(1),
        name: z.string().optional(),
        email: z.string().optional(),
      }),
      _meta: { 'openai/profile': true },
    },
    async () => {
      const { data, error } = await ctx.db.svc.auth.admin.getUserById(ctx.userId)
      if (error || !data?.user) {
        console.error('get_profile:', error)
        return errorResult('Could not load the signed-in profile.')
      }
      const user = data.user
      const meta = (user.user_metadata ?? {}) as Record<string, unknown>
      const name =
        (typeof meta.full_name === 'string' && meta.full_name) ||
        (typeof meta.name === 'string' && meta.name) ||
        undefined
      const profile = {
        id: createHash('sha256').update(`billr-profile:${ctx.userId}`).digest('hex').slice(0, 32),
        ...(name ? { name } : {}),
        ...(user.email ? { email: user.email } : {}),
      }
      return { ...jsonResult(profile), structuredContent: profile }
    }
  )

  server.registerTool(
    'list_businesses',
    {
      title: 'List Businesses',
      description:
        "List every business this API key can act on, ordered by name. Call this first when you don't know which business_id to pass to the other tools. If exactly one is returned, business_id can be omitted everywhere.",
      inputSchema: z.object({}),
    },
    async () => {
      const { data, error } = await ctx.db.svc
        .from('businesses')
        .select('id, name, default_currency, invoice_prefix')
        .in('id', ctx.db.scope.businessIds)
        .order('name', { ascending: true })

      if (error) {
        console.error('list_businesses:', error)
        return errorResult('Could not list businesses.')
      }

      const businesses = (data ?? []).map((b) => ({
        id: b.id,
        name: b.name,
        currency: b.default_currency,
        invoice_prefix: b.invoice_prefix,
        app_url: `${appUrl()}/settings/business`,
      }))

      const result = {
        summary: `${businesses.length} business${businesses.length === 1 ? '' : 'es'} in scope: ${
          businesses.map((b) => b.name).join(', ') || 'none'
        }.`,
        businesses,
      }

      return jsonResult(result)
    }
  )

  server.registerTool(
    'get_business',
    {
      title: 'Get Business',
      description:
        "Fetch details for one of the caller's businesses: name, contact email, currency, invoice numbering. If the API key is scoped to a single business, business_id can be omitted.",
      inputSchema: z.object({
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Id of the business to fetch. Optional when the API key is scoped to exactly one business; required if scoped to multiple.'
          ),
      }),
    },
    async ({ business_id }) => {
      let resolvedId: string
      try {
        resolvedId = ctx.db.resolveBusinessId(business_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve business.')
      }

      const { data, error } = await ctx.db.svc
        .from('businesses')
        .select('id, name, email, default_currency, invoice_prefix, next_invoice_number')
        .eq('id', resolvedId)
        .maybeSingle()

      if (error || !data) {
        return errorResult(`Business ${resolvedId} not found.`)
      }

      const result = {
        summary: `${data.name}: invoices prefixed "${data.invoice_prefix}", next number ${data.next_invoice_number}.`,
        business: {
          id: data.id,
          name: data.name,
          email: data.email,
          currency: data.default_currency,
          invoice_prefix: data.invoice_prefix,
          next_invoice_number: data.next_invoice_number,
        },
        app_url: appUrl(),
      }

      return jsonResult(result)
    }
  )

  server.registerTool(
    'revenue_summary',
    {
      title: 'Revenue Summary',
      description:
        'Summarize invoiced, paid, outstanding, and overdue amounts for one of the caller\'s businesses over a period (default this_year), plus status counts and the top 5 clients by invoiced amount. Draft and cancelled invoices are excluded from all dollar totals (but still counted in by_status); "overdue" means balance still due, due date past, and status is sent/viewed/partial; overdue_total is a subset of outstanding_total, not additional to it.',
      inputSchema: z.object({
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Id of the business to summarize. Optional when the API key is scoped to exactly one business; required if scoped to multiple.'
          ),
        period: periodEnum
          .optional()
          .describe(
            'Reporting period, matched against each invoice\'s issue_date: "this_month", "last_month", "this_year" (default), or "all" (no date filter).'
          ),
      }),
    },
    async ({ business_id, period }) => {
      let resolvedId: string
      try {
        resolvedId = ctx.db.resolveBusinessId(business_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve business.')
      }

      const resolvedPeriod = period ?? 'this_year'
      const range = periodRange(resolvedPeriod)

      let query = ctx.db.svc
        .from('invoices')
        .select('id, status, total, amount_paid, balance_due, currency, due_date, issue_date, client_id, clients(name)')
        .eq('business_id', resolvedId)
        .limit(REVENUE_LIMIT)

      if (range) {
        query = query.gte('issue_date', range.start).lte('issue_date', range.end)
      }

      const { data, error } = await query

      if (error) {
        console.error('revenue_summary:', error)
        return errorResult('Could not compute revenue summary.')
      }

      const invoices = (data ?? []) as unknown as SummaryRow[]
      const truncated = invoices.length === REVENUE_LIMIT
      const truncNote = truncated ? truncationNote(REVENUE_LIMIT) : ''

      const byStatus: Record<string, number> = {}
      for (const inv of invoices) {
        byStatus[inv.status] = (byStatus[inv.status] ?? 0) + 1
      }

      const counted = invoices.filter((inv) => !EXCLUDED_FROM_TOTALS.has(inv.status))
      const currencies = Array.from(new Set(counted.map((inv) => inv.currency)))

      const periodLabel = resolvedPeriod.replace(/_/g, ' ')

      if (currencies.length <= 1) {
        const currency = currencies[0] ?? null
        const invoicedTotal = sumBy(counted, 'total')
        const paidTotal = sumBy(counted, 'amount_paid')
        const outstandingTotal = sumBy(counted, 'balance_due')
        const overdueRows = counted.filter((inv) => isOverdue(inv.status, inv.due_date))
        const overdueTotal = sumBy(overdueRows, 'balance_due')

        const summary = currency
          ? `${periodLabel}: ${formatCurrency(invoicedTotal, currency)} invoiced, ${formatCurrency(paidTotal, currency)} paid, ${formatCurrency(outstandingTotal, currency)} outstanding (${formatCurrency(overdueTotal, currency)} overdue).`
          : `${periodLabel}: no invoices found.`

        const result = {
          summary: `${summary}${truncNote}`,
          period: resolvedPeriod,
          currency,
          invoiced_total: invoicedTotal,
          paid_total: paidTotal,
          outstanding_total: outstandingTotal,
          overdue_total: overdueTotal,
          by_status: byStatus,
          top_clients: topClients(counted),
          ...(truncated ? { truncated: true } : {}),
        }

        return jsonResult(result)
      }

      // Mixed currencies within one business (unusual, but not impossible if
      // an invoice's currency was changed after creation): totals can't be
      // summed across currencies, so break them out per-currency instead of
      // returning a meaningless combined number.
      const byCurrency = summarizeByCurrency(counted)

      const summary = `${periodLabel} (mixed currencies): ${byCurrency
        .map((c) => `${formatCurrency(c.invoiced_total, c.currency)} invoiced`)
        .join('; ')}.`

      const result = {
        summary: `${summary}${truncNote}`,
        period: resolvedPeriod,
        currency: null,
        invoiced_total: null,
        paid_total: null,
        outstanding_total: null,
        overdue_total: null,
        by_currency: byCurrency,
        by_status: byStatus,
        top_clients: [],
        ...(truncated ? { truncated: true } : {}),
      }

      return jsonResult(result)
    }
  )
}
