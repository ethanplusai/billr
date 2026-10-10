import { secondsFromHours, timeAmount, entrySeconds } from '@/lib/work/time'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { McpCtx } from '@/lib/mcp/context'
import { ScopeError } from '@/lib/mcp/scoped-db'
import { resolveClient } from './invoices-write'
import { appUrl, errorResult, jsonResult, truncationNote } from '@/lib/mcp/shared'
import type { Database } from '@/types/database'

const DATE_FIELD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Registers the time-entry management tools (list_time_entries,
 * update_time_entry, delete_time_entry) that complement log_time in work.ts,
 * scoped to the businesses in ctx.db.scope.
 *
 * Schema mapping matches log_time: hours are stored as duration_minutes,
 * hourly_rate is nullable (null means "no rate agreed yet", which is different
 * from an explicit 0), amount = hours * rate, and an entry counts as billed
 * once invoice_id is set.
 *
 * Safety rule shared by update and delete: an entry already attached to an
 * invoice is refused. Editing it would silently desync the invoice the client
 * has already been shown.
 */
export function registerTimeTools(server: McpServer, ctx: McpCtx) {
  server.registerTool(
    'list_time_entries',
    {
      title: 'List Time Entries',
      description:
        'List tracked time, filtered by client, date range, and billed status. Use this to answer "how many hours did I put into X" or to find the entry to correct. To draft an invoice from unbilled work, prefer list_unbilled, which groups by client and totals it for you.',
      inputSchema: z.object({
        offset: z.number().int().min(0).max(1000000).optional().describe('Page offset. Start at 0, then use next_offset until it is null. Keep other filters unchanged.'),
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Id of the business whose time to list. Optional when the API key is scoped to exactly one business; required if scoped to multiple.'
          ),
        client_id: z.string().uuid().optional().describe('Restrict to one client. Provide this or client_name.'),
        client_name: z
          .string()
          .max(200)
          .optional()
          .describe('Exact (case-insensitive) client name to restrict to. Provide this or client_id.'),
        from: DATE_FIELD.optional().describe('Earliest entry date to include, YYYY-MM-DD (inclusive).'),
        to: DATE_FIELD.optional().describe('Latest entry date to include, YYYY-MM-DD (inclusive).'),
        billed: z
          .enum(['billed', 'unbilled', 'all'])
          .optional()
          .describe(
            '"unbilled" returns entries not yet on an invoice, "billed" returns those already invoiced, "all" returns both. Defaults to "all".'
          ),
        billable: z
          .boolean()
          .optional()
          .describe('Filter by the billable flag. Omit to include both billable and non-billable time.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max entries to return (default 50, max 200).'),
      }),
    },
    async ({ offset, business_id, client_id, client_name, from, to, billed, billable, limit }) => {
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
        .from('time_entries')
        .select(
          'id, client_id, currency, description, date, duration_seconds, duration_minutes, hourly_rate, amount, is_billable, is_billed, invoice_id, clients(name)'
        )
        .eq('business_id', resolvedBusinessId)
        .order('date', { ascending: false })
        .order('id', { ascending: true })
        .range(offset ?? 0, (offset ?? 0) + resolvedLimit - 1)

      if (clientFilterId) query = query.eq('client_id', clientFilterId)
      if (from) query = query.gte('date', from)
      if (to) query = query.lte('date', to)
      if (billable !== undefined) query = query.eq('is_billable', billable)
      if (billed === 'billed') query = query.not('invoice_id', 'is', null)
      if (billed === 'unbilled') query = query.is('invoice_id', null)

      const { data, error } = await query

      if (error) {
        console.error('list_time_entries:', error)
        return errorResult('Could not list time entries.')
      }

      const rows = data ?? []
      const entries = rows.map((row) => {
        const hours = entrySeconds(row) / 3600
        return {
          id: row.id,
          date: row.date,
          client_id: row.client_id,
          client_name: (row.clients as { name: string } | null)?.name ?? null,
          description: row.description,
          hours,
          rate: row.hourly_rate,
          amount: row.amount,
          missing_rate: row.hourly_rate === null,
          currency: row.currency,
          is_billable: row.is_billable,
          is_billed: !!row.invoice_id,
          invoice_id: row.invoice_id,
        }
      })

      const totalHours = round2(entries.reduce((sum, e) => sum + e.hours, 0))
      const truncated = entries.length === resolvedLimit

      return jsonResult({
        offset: offset ?? 0,
        next_offset: (data ?? []).length === resolvedLimit ? (offset ?? 0) + resolvedLimit : null,
        summary: `${entries.length} time entr${entries.length === 1 ? 'y' : 'ies'}, ${totalHours}h total${truncated ? truncationNote(resolvedLimit) : ''}`,
        total_hours: totalHours,
        entries,
        app_url: `${appUrl()}/time`,
      })
    }
  )

  server.registerTool(
    'update_time_entry',
    {
      title: 'Update Time Entry',
      description:
        'Correct a single logged time entry: its hours, rate, description, date, client, or billable flag. Use it to fix a mistake before the work is invoiced. Refuses entries already attached to an invoice, since changing those would not change the invoice the client received.',
      inputSchema: z.object({
        time_entry_id: z
          .string()
          .uuid()
          .describe('Id of the entry to update, from list_time_entries or list_unbilled. Exactly one entry is affected.'),
        description: z.string().min(1).max(500).optional().describe('New description of what the time was spent on.'),
        hours: z.number().gt(0).lte(24).describe('New hours worked, > 0 and <= 24.').optional(),
        date: DATE_FIELD.optional().describe('New date of the work, YYYY-MM-DD.'),
        rate: z
          .number()
          .min(0)
          .optional()
          .describe('New hourly rate. Setting this also recomputes the entry amount as hours * rate.'),
        client_id: z.string().uuid().optional().describe('Reassign to this client id. Provide this or client_name.'),
        client_name: z
          .string()
          .max(200)
          .optional()
          .describe('Reassign to this exact (case-insensitive) client name. Provide this or client_id.'),
        billable: z.boolean().optional().describe('New billable flag. Non-billable time never appears in list_unbilled.'),
      }),
    },
    async ({ time_entry_id, description, hours, date, rate, client_id, client_name, billable }) => {
      let entry
      try {
        entry = await ctx.db.assertTimeEntryAccess(time_entry_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access time entry.')
      }

      if (entry.invoice_id) {
        return errorResult(
          `Time entry ${time_entry_id} is already billed on invoice ${entry.invoice_id} and cannot be edited. Adjust the invoice itself, or log a separate correcting entry.`
        )
      }

      let reassignedClientId: string | undefined
      let reassignedClientName: string | undefined
      if (client_id || client_name) {
        try {
          const client = await resolveClient(ctx, entry.business_id, client_id, client_name)
          reassignedClientId = client.id
          reassignedClientName = client.name
        } catch (err) {
          return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve client.')
        }
      }

      const updates: Database['public']['Tables']['time_entries']['Update'] = {}
      if (description !== undefined) updates.description = description
      if (date !== undefined) updates.date = date
      if (billable !== undefined) updates.is_billable = billable
      if (reassignedClientId !== undefined) updates.client_id = reassignedClientId
      if (hours !== undefined) updates.duration_seconds = secondsFromHours(hours)
      if (rate !== undefined) updates.hourly_rate = rate

      // amount is derived, so recompute it whenever either input moved, using
      // the post-update values rather than a mix of old and new.
      if (hours !== undefined || rate !== undefined) {
        const effectiveHours = hours ?? entrySeconds(entry) / 3600
        const effectiveRate = rate ?? entry.hourly_rate
        updates.amount = effectiveRate === null ? null : timeAmount(secondsFromHours(effectiveHours), effectiveRate)
      }

      if (Object.keys(updates).length === 0) {
        return errorResult('Nothing to update. Pass at least one field to change.')
      }

      const { data: updated, error } = await ctx.db.svc
        .from('time_entries')
        .update(updates)
        .eq('id', time_entry_id)
        .eq('business_id', entry.business_id)
        .select('*')
        .single()

      if (error || !updated) {
        console.error('update_time_entry (update):', error)
        return errorResult('Could not update time entry.')
      }

      const updatedHours = entrySeconds(updated) / 3600
      const forClient = reassignedClientName ? ` (reassigned to ${reassignedClientName})` : ''

      return jsonResult({
        summary: `Updated time entry: ${updatedHours}h on ${updated.date}${forClient}`,
        time_entry: {
          id: updated.id,
          business_id: updated.business_id,
          client_id: updated.client_id,
          description: updated.description,
          date: updated.date,
          hours: updatedHours,
          rate: updated.hourly_rate,
          amount: updated.amount,
          currency: updated.currency,
          is_billable: updated.is_billable,
          is_billed: !!updated.invoice_id,
        },
        app_url: `${appUrl()}/time`,
      })
    }
  )

  server.registerTool(
    'delete_time_entry',
    {
      title: 'Delete Time Entry',
      description:
        'Permanently delete ONE time entry by its id, returning what was deleted so it can be re-logged if that was a mistake. There is no bulk delete and no filter-based delete on purpose. Refuses entries already attached to an invoice. Prefer update_time_entry when the entry is merely wrong rather than unwanted.',
      inputSchema: z.object({
        time_entry_id: z
          .string()
          .uuid()
          .describe(
            'Id of the single entry to delete, from list_time_entries. Required and exact: this tool never deletes by client, date, or any other filter.'
          ),
      }),
    },
    async ({ time_entry_id }) => {
      let entry
      try {
        entry = await ctx.db.assertTimeEntryAccess(time_entry_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access time entry.')
      }

      if (entry.invoice_id) {
        return errorResult(
          `Time entry ${time_entry_id} is already billed on invoice ${entry.invoice_id} and cannot be deleted. Adjust the invoice instead.`
        )
      }

      const { error } = await ctx.db.svc
        .from('time_entries')
        .delete()
        .eq('id', time_entry_id)
        .eq('business_id', entry.business_id)

      if (error) {
        console.error('delete_time_entry (delete):', error)
        return errorResult('Could not delete time entry.')
      }

      const hours = round2(entrySeconds(entry) / 3600)

      return jsonResult({
        summary: `Deleted time entry: ${hours}h on ${entry.date}. This cannot be undone; re-log it with log_time if it was removed by mistake.`,
        deleted_time_entry: {
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
      })
    }
  )
}
