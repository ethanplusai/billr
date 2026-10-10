import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { McpCtx } from '@/lib/mcp/context'
import { ScopeError } from '@/lib/mcp/scoped-db'
import { resolveItem } from '@/lib/mcp/line-items'
import { appUrl, errorResult, jsonResult, escapeLike, truncationNote } from '@/lib/mcp/shared'
import type { Database } from '@/types/database'

const UNITS = ['hour', 'day', 'week', 'month', 'project', 'item', 'unit'] as const

/**
 * items rows carry the same provenance columns (created_via,
 * created_by_key_id) as every other agent-writable table.
 */
type ItemInsert = Database['public']['Tables']['items']['Insert']

/**
 * Registers the saved-item catalog tools (create_item, update_item,
 * list_items), scoped to the businesses in ctx.db.scope.
 *
 * The catalog is what makes "bill 3 hours of Consulting" work: create_invoice
 * and create_estimate accept item_id / item_name per line and pull the stored
 * rate and description from here (see src/lib/mcp/line-items.ts).
 */
export function registerItemTools(server: McpServer, ctx: McpCtx) {
  server.registerTool(
    'list_items',
    {
      title: 'List Saved Items',
      description:
        'List the saved product/service catalog for a business, with each item\'s stored rate. Use this before create_invoice or create_estimate when the user names a service ("Consulting", "Design retainer") so you bill the saved rate instead of guessing. Not for looking up what was billed on a specific invoice; use get_invoice for that.',
      inputSchema: z.object({
        offset: z.number().int().min(0).max(1000000).optional().describe('Page offset. Start at 0, then use next_offset until it is null. Keep other filters unchanged.'),
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Id of the business whose catalog to list. Optional when the API key is scoped to exactly one business; required if scoped to multiple.'
          ),
        search: z
          .string()
          .max(200)
          .optional()
          .describe('Case-insensitive substring match on the item name. Omit to list everything.'),
        include_inactive: z
          .boolean()
          .optional()
          .describe('Include items that have been deactivated. Defaults to false (active items only).'),
        limit: z.number().int().min(1).max(200).optional().describe('Max items to return (default 50, max 200).'),
      }),
    },
    async ({ offset, business_id, search, include_inactive, limit }) => {
      let resolvedBusinessId: string
      try {
        resolvedBusinessId = ctx.db.resolveBusinessId(business_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve business.')
      }

      const resolvedLimit = limit ?? 50

      let query = ctx.db.svc
        .from('items')
        .select('id, name, description, type, rate, unit, tax_rate, is_active')
        .eq('business_id', resolvedBusinessId)
        .order('name', { ascending: true })
        .order('id', { ascending: true })
        .range(offset ?? 0, (offset ?? 0) + resolvedLimit - 1)

      if (!include_inactive) {
        query = query.eq('is_active', true)
      }
      if (search) {
        query = query.ilike('name', `%${escapeLike(search)}%`)
      }

      const { data, error } = await query

      if (error) {
        console.error('list_items:', error)
        return errorResult('Could not list saved items.')
      }

      const items = data ?? []
      const truncated = items.length === resolvedLimit

      return jsonResult({
        offset: offset ?? 0,
        next_offset: (data ?? []).length === resolvedLimit ? (offset ?? 0) + resolvedLimit : null,
        summary: `${items.length} saved item${items.length === 1 ? '' : 's'}${truncated ? truncationNote(resolvedLimit) : ''}`,
        items,
        app_url: `${appUrl()}/items`,
      })
    }
  )

  server.registerTool(
    'create_item',
    {
      title: 'Create Saved Item',
      description:
        'Add a product or service to the saved catalog so future invoices and estimates can bill it by name at a consistent rate. Use this when the user says "my rate for X is Y" or wants a reusable line. Do NOT use it to add a one-off line to an existing invoice; pass line_items to create_invoice or update_draft_invoice instead.',
      inputSchema: z.object({
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Id of the business to add the item under. Optional when the API key is scoped to exactly one business; required if scoped to multiple.'
          ),
        name: z
          .string()
          .min(1)
          .max(200)
          .describe('Short catalog name, e.g. "Consulting". This is what item_name matches on later, so keep it distinct.'),
        rate: z.number().min(0).describe('Default rate per unit, in the business currency.'),
        description: z
          .string()
          .max(500)
          .optional()
          .describe('Longer description used as the invoice line text. Defaults to the name when omitted.'),
        unit: z
          .enum(UNITS)
          .optional()
          .describe('Unit the rate is quoted in, e.g. "hour". Display only; it does not affect the math.'),
        type: z.enum(['service', 'product']).optional().describe('Item type. Defaults to "service".'),
        tax_rate: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Default tax rate percent stored with the item. Defaults to 0.'),
      }),
    },
    async ({ business_id, name, rate, description, unit, type, tax_rate }) => {
      let resolvedBusinessId: string
      try {
        resolvedBusinessId = ctx.db.resolveBusinessId(business_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve business.')
      }

      const { data: existing, error: existingError } = await ctx.db.svc
        .from('items')
        .select('id, name, rate')
        .eq('business_id', resolvedBusinessId)
        .ilike('name', escapeLike(name))
        .limit(1)

      if (existingError) {
        console.error('create_item (duplicate check):', existingError)
        return errorResult('Could not check for an existing item with that name.')
      }

      if (existing && existing.length > 0) {
        return errorResult(
          `An item named "${existing[0].name}" already exists in this business (${existing[0].id}, rate ${existing[0].rate}). Use update_item to change its rate instead of creating a duplicate.`
        )
      }

      const payload: ItemInsert = {
        business_id: resolvedBusinessId,
        name,
        rate,
        description: description ?? null,
        unit: unit ?? null,
        type: type ?? 'service',
        tax_rate: tax_rate ?? 0,
        is_active: true,
        created_via: 'agent',
        created_by_key_id: ctx.keyId,
      }

      const { data: item, error } = await ctx.db.svc.from('items').insert(payload).select('*').single()

      if (error || !item) {
        console.error('create_item (insert):', error)
        return errorResult('Could not create saved item.')
      }

      return jsonResult({
        summary: `Saved "${item.name}" at ${item.rate}${item.unit ? ` per ${item.unit}` : ''}`,
        item: {
          id: item.id,
          business_id: item.business_id,
          name: item.name,
          description: item.description,
          type: item.type,
          rate: item.rate,
          unit: item.unit,
          tax_rate: item.tax_rate,
          is_active: item.is_active,
        },
        app_url: `${appUrl()}/items/${item.id}`,
      })
    }
  )

  server.registerTool(
    'update_item',
    {
      title: 'Update Saved Item',
      description:
        'Change a saved item\'s rate, name, description, unit, or active flag. Identify it by item_id or by exact item_name. Changes apply to FUTURE invoices and estimates only; already-issued documents keep the rate they were billed at, so do not use this to correct an invoice (use update_draft_invoice).',
      inputSchema: z.object({
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Id of the business the item belongs to. Optional when the API key is scoped to exactly one business; required if scoped to multiple.'
          ),
        item_id: z.string().uuid().optional().describe('Id of the item to update. Provide this or item_name.'),
        item_name: z
          .string()
          .max(200)
          .optional()
          .describe('Exact (case-insensitive) current item name. Provide this or item_id.'),
        name: z.string().min(1).max(200).optional().describe('New catalog name.'),
        rate: z.number().min(0).optional().describe('New default rate per unit.'),
        description: z.string().max(500).optional().describe('New description used as invoice line text.'),
        unit: z.enum(UNITS).optional().describe('New unit the rate is quoted in.'),
        type: z.enum(['service', 'product']).optional().describe('New item type.'),
        tax_rate: z.number().min(0).max(100).optional().describe('New default tax rate percent.'),
        is_active: z
          .boolean()
          .optional()
          .describe('Set false to retire an item without deleting it. Retired items are hidden from list_items by default.'),
      }),
    },
    async ({ business_id, item_id, item_name, name, rate, description, unit, type, tax_rate, is_active }) => {
      let resolvedBusinessId: string
      try {
        resolvedBusinessId = ctx.db.resolveBusinessId(business_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve business.')
      }

      let item
      try {
        item = await resolveItem(ctx, resolvedBusinessId, item_id, item_name)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve saved item.')
      }

      const updates: Database['public']['Tables']['items']['Update'] = {}
      if (name !== undefined) updates.name = name
      if (rate !== undefined) updates.rate = rate
      if (description !== undefined) updates.description = description
      if (unit !== undefined) updates.unit = unit
      if (type !== undefined) updates.type = type
      if (tax_rate !== undefined) updates.tax_rate = tax_rate
      if (is_active !== undefined) updates.is_active = is_active

      if (Object.keys(updates).length === 0) {
        return errorResult('Nothing to update. Pass at least one field to change.')
      }

      const { data: updated, error } = await ctx.db.svc
        .from('items')
        .update(updates)
        .eq('id', item.id)
        .eq('business_id', resolvedBusinessId)
        .select('*')
        .single()

      if (error || !updated) {
        console.error('update_item (update):', error)
        return errorResult('Could not update saved item.')
      }

      return jsonResult({
        summary: `Updated "${updated.name}" (${Object.keys(updates).join(', ')})`,
        item: {
          id: updated.id,
          business_id: updated.business_id,
          name: updated.name,
          description: updated.description,
          type: updated.type,
          rate: updated.rate,
          unit: updated.unit,
          tax_rate: updated.tax_rate,
          is_active: updated.is_active,
        },
        app_url: `${appUrl()}/items/${updated.id}`,
      })
    }
  )
}
