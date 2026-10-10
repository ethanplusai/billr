import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { McpCtx } from '@/lib/mcp/context'
import { ScopeError } from '@/lib/mcp/scoped-db'
import { resolveClient } from './invoices-write'
import { appUrl, errorResult, jsonResult, formatCurrency, truncationNote } from '@/lib/mcp/shared'
import type { Database } from '@/types/database'

const DATE_FIELD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

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

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Registers the expense management tools (list_expenses, update_expense,
 * delete_expense) that complement log_expense in work.ts, scoped to the
 * businesses in ctx.db.scope.
 *
 * An expense counts as billed once invoice_id is set; as with time entries,
 * billed rows are refused by update and delete so an invoice the client has
 * already seen cannot be silently contradicted.
 *
 * Currency discipline: expenses are stored with their own currency, so totals
 * are grouped per currency and never summed across them.
 */
export function registerExpenseTools(server: McpServer, ctx: McpCtx) {
  server.registerTool(
    'list_expenses',
    {
      title: 'List Expenses',
      description:
        'List expenses filtered by category, client, date range, and billed status, with totals grouped per currency. Use this for "what did I spend on software last quarter" or to find an expense to correct. For rebilling unbilled costs to a client, prefer list_unbilled.',
      inputSchema: z.object({
        offset: z.number().int().min(0).max(1000000).optional().describe('Page offset. Start at 0, then use next_offset until it is null. Keep other filters unchanged.'),
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Id of the business whose expenses to list. Optional when the API key is scoped to exactly one business; required if scoped to multiple.'
          ),
        category: z
          .enum(EXPENSE_CATEGORIES)
          .optional()
          .describe('Restrict to a single expense category. Omit to include every category.'),
        client_id: z.string().uuid().optional().describe('Restrict to one client. Provide this or client_name.'),
        client_name: z
          .string()
          .max(200)
          .optional()
          .describe('Exact (case-insensitive) client name to restrict to. Provide this or client_id.'),
        from: DATE_FIELD.optional().describe('Earliest expense date to include, YYYY-MM-DD (inclusive).'),
        to: DATE_FIELD.optional().describe('Latest expense date to include, YYYY-MM-DD (inclusive).'),
        billed: z
          .enum(['billed', 'unbilled', 'all'])
          .optional()
          .describe(
            '"unbilled" returns expenses not yet on an invoice, "billed" returns those already invoiced, "all" returns both. Defaults to "all".'
          ),
        billable: z
          .boolean()
          .optional()
          .describe('Filter by the billable flag. Omit to include both billable and non-billable expenses.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max expenses to return (default 50, max 200).'),
      }),
    },
    async ({ offset, business_id, category, client_id, client_name, from, to, billed, billable, limit }) => {
      let resolvedBusinessId: string
      try {
        resolvedBusinessId = ctx.db.resolveBusinessId(business_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve business.')
      }

      let clientFilterId: string | undefined
      if (client_id || client_name) {
        try {
          clientFilterId = (await resolveClient(ctx, resolvedBusinessId, client_id, client_name)).id
        } catch (err) {
          return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve client.')
        }
      }

      const resolvedLimit = limit ?? 50

      let query = ctx.db.svc
        .from('expenses')
        .select(
          'id, client_id, description, vendor, category, date, amount, currency, is_billable, is_billed, invoice_id, clients(name)'
        )
        .eq('business_id', resolvedBusinessId)
        .order('date', { ascending: false })
        .order('id', { ascending: true })
        .range(offset ?? 0, (offset ?? 0) + resolvedLimit - 1)

      if (category) query = query.eq('category', category)
      if (clientFilterId) query = query.eq('client_id', clientFilterId)
      if (from) query = query.gte('date', from)
      if (to) query = query.lte('date', to)
      if (billable !== undefined) query = query.eq('is_billable', billable)
      if (billed === 'billed') query = query.not('invoice_id', 'is', null)
      if (billed === 'unbilled') query = query.is('invoice_id', null)

      const { data, error } = await query

      if (error) {
        console.error('list_expenses:', error)
        return errorResult('Could not list expenses.')
      }

      const rows = data ?? []
      const expenses = rows.map((row) => ({
        id: row.id,
        date: row.date,
        client_id: row.client_id,
        client_name: (row.clients as { name: string } | null)?.name ?? null,
        description: row.description,
        vendor: row.vendor,
        category: row.category,
        amount: row.amount,
        currency: row.currency,
        is_billable: row.is_billable,
        is_billed: !!row.invoice_id,
        invoice_id: row.invoice_id,
      }))

      // Never sum across currencies: one total per currency, each labeled.
      const byCurrency = new Map<string, number>()
      for (const expense of expenses) {
        byCurrency.set(expense.currency, round2((byCurrency.get(expense.currency) ?? 0) + expense.amount))
      }
      const totals = Array.from(byCurrency.entries()).map(([currency, total]) => ({ currency, total }))
      const totalsLabel = totals.map((t) => formatCurrency(t.total, t.currency)).join(', ')
      const truncated = expenses.length === resolvedLimit

      return jsonResult({
        offset: offset ?? 0,
        next_offset: (data ?? []).length === resolvedLimit ? (offset ?? 0) + resolvedLimit : null,
        summary: `${expenses.length} expense${expenses.length === 1 ? '' : 's'}${totalsLabel ? ` totaling ${totalsLabel}` : ''}${truncated ? truncationNote(resolvedLimit) : ''}`,
        totals_by_currency: totals,
        expenses,
        app_url: `${appUrl()}/expenses`,
      })
    }
  )

  server.registerTool(
    'update_expense',
    {
      title: 'Update Expense',
      description:
        'Correct a single logged expense: amount, description, vendor, category, date, client, or billable flag. Use it to fix a mistake before the cost is rebilled. Refuses expenses already attached to an invoice, since changing those would not change the invoice the client received.',
      inputSchema: z.object({
        expense_id: z
          .string()
          .uuid()
          .describe('Id of the expense to update, from list_expenses or list_unbilled. Exactly one expense is affected.'),
        description: z.string().min(1).max(500).optional().describe('New description of what the expense was for.'),
        amount: z.number().gt(0).optional().describe('New expense amount, must be > 0. Keeps the existing currency.'),
        date: DATE_FIELD.optional().describe('New expense date, YYYY-MM-DD.'),
        category: z.enum(EXPENSE_CATEGORIES).optional().describe('New expense category.'),
        vendor: z.string().max(200).optional().describe('New vendor or merchant name.'),
        notes: z.string().max(2000).optional().describe('New internal notes; not shown to the client.'),
        client_id: z.string().uuid().optional().describe('Reassign to this client id. Provide this or client_name.'),
        client_name: z
          .string()
          .max(200)
          .optional()
          .describe('Reassign to this exact (case-insensitive) client name. Provide this or client_id.'),
        billable: z
          .boolean()
          .optional()
          .describe('New billable flag. Non-billable expenses never appear in list_unbilled.'),
      }),
    },
    async ({ expense_id, description, amount, date, category, vendor, notes, client_id, client_name, billable }) => {
      let expense
      try {
        expense = await ctx.db.assertExpenseAccess(expense_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access expense.')
      }

      if (expense.invoice_id) {
        return errorResult(
          `Expense ${expense_id} is already billed on invoice ${expense.invoice_id} and cannot be edited. Adjust the invoice itself, or log a separate correcting expense.`
        )
      }

      let reassignedClientId: string | undefined
      let reassignedClientName: string | undefined
      if (client_id || client_name) {
        try {
          const client = await resolveClient(ctx, expense.business_id, client_id, client_name)
          reassignedClientId = client.id
          reassignedClientName = client.name
        } catch (err) {
          return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve client.')
        }
      }

      const updates: Database['public']['Tables']['expenses']['Update'] = {}
      if (description !== undefined) updates.description = description
      if (amount !== undefined) updates.amount = amount
      if (date !== undefined) updates.date = date
      if (category !== undefined) updates.category = category
      if (vendor !== undefined) updates.vendor = vendor
      if (notes !== undefined) updates.notes = notes
      if (billable !== undefined) updates.is_billable = billable
      if (reassignedClientId !== undefined) updates.client_id = reassignedClientId

      if (Object.keys(updates).length === 0) {
        return errorResult('Nothing to update. Pass at least one field to change.')
      }

      const { data: updated, error } = await ctx.db.svc
        .from('expenses')
        .update(updates)
        .eq('id', expense_id)
        .eq('business_id', expense.business_id)
        .select('*')
        .single()

      if (error || !updated) {
        console.error('update_expense (update):', error)
        return errorResult('Could not update expense.')
      }

      const forClient = reassignedClientName ? ` (reassigned to ${reassignedClientName})` : ''

      return jsonResult({
        summary: `Updated expense: ${formatCurrency(updated.amount, updated.currency)} on ${updated.date}${forClient}`,
        expense: {
          id: updated.id,
          business_id: updated.business_id,
          client_id: updated.client_id,
          description: updated.description,
          vendor: updated.vendor,
          category: updated.category,
          date: updated.date,
          amount: updated.amount,
          currency: updated.currency,
          is_billable: updated.is_billable,
          is_billed: !!updated.invoice_id,
        },
        app_url: `${appUrl()}/expenses`,
      })
    }
  )

  server.registerTool(
    'delete_expense',
    {
      title: 'Delete Expense',
      description:
        'Permanently delete ONE expense by its id, returning what was deleted so it can be re-logged if that was a mistake. There is no bulk delete and no filter-based delete on purpose. Refuses expenses already attached to an invoice. Prefer update_expense when the expense is merely wrong rather than unwanted.',
      inputSchema: z.object({
        expense_id: z
          .string()
          .uuid()
          .describe(
            'Id of the single expense to delete, from list_expenses. Required and exact: this tool never deletes by category, client, date, or any other filter.'
          ),
      }),
    },
    async ({ expense_id }) => {
      let expense
      try {
        expense = await ctx.db.assertExpenseAccess(expense_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access expense.')
      }

      if (expense.invoice_id) {
        return errorResult(
          `Expense ${expense_id} is already billed on invoice ${expense.invoice_id} and cannot be deleted. Adjust the invoice instead.`
        )
      }

      const { error } = await ctx.db.svc
        .from('expenses')
        .delete()
        .eq('id', expense_id)
        .eq('business_id', expense.business_id)

      if (error) {
        console.error('delete_expense (delete):', error)
        return errorResult('Could not delete expense.')
      }

      return jsonResult({
        summary: `Deleted expense: ${formatCurrency(expense.amount, expense.currency)} on ${expense.date}. This cannot be undone; re-log it with log_expense if it was removed by mistake.`,
        deleted_expense: {
          id: expense.id,
          business_id: expense.business_id,
          client_id: expense.client_id,
          description: expense.description,
          vendor: expense.vendor,
          category: expense.category,
          date: expense.date,
          amount: expense.amount,
          currency: expense.currency,
          is_billable: expense.is_billable,
        },
      })
    }
  )
}
