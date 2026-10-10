import { z } from 'zod'
import type { McpCtx } from '@/lib/mcp/context'
import { ScopeError } from '@/lib/mcp/scoped-db'
import { escapeLike } from '@/lib/mcp/shared'
import type { BuildLineItem } from '@/lib/invoices/build'
import type { Database } from '@/types/database'

export type ItemRow = Database['public']['Tables']['items']['Row']

/** A line with every blank filled in, ready for the shared totals math. */
export interface ResolvedLineItem extends BuildLineItem {
  description: string
}

const ITEM_LOOKUP_LIMIT = 5

/**
 * Shared line-item input schema for create_invoice / update_draft_invoice /
 * create_estimate / update_draft_estimate.
 *
 * A line can be written out longhand (description + quantity + rate) or it can
 * point at a saved catalog item by id or name, in which case the item supplies
 * whatever the caller left out. That is what lets an agent turn "bill 3 hours
 * of Consulting" into a correctly priced line without the caller knowing the
 * stored rate.
 */
export const lineItemInput = z.object({
  description: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'Line item description. Required unless item_id or item_name is given, in which case it defaults to the saved item\'s description (or its name if it has none).'
    ),
  quantity: z.number().positive().max(99999999).multipleOf(0.000001).optional().describe('Quantity (must be > 0). Defaults to 1.'),
  rate: z
    .number()
    .min(0).max(99999999).multipleOf(0.000001)
    .optional()
    .describe(
      'Rate per unit. Required unless item_id or item_name is given, in which case it defaults to the saved item\'s rate. Pass it explicitly to override the saved rate for this line only.'
    ),
  item_id: z
    .string()
    .uuid()
    .optional()
    .describe('Id of a saved item (from list_items) to price this line from. Takes precedence over item_name.'),
  item_name: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Exact (case-insensitive) name of a saved item to price this line from, e.g. "Consulting". Use list_items first if you are unsure of the exact name.'
    ),
})

export type LineItemInput = z.infer<typeof lineItemInput>

/**
 * Resolves caller-supplied lines into the plain { description, quantity, rate }
 * shape the shared totals math consumes, filling in blanks from the saved item
 * catalog where a line references one.
 *
 * Scoping: the catalog fetch is filtered to `resolvedBusinessId`, which the
 * caller must already have obtained from `ctx.db.resolveBusinessId`.
 *
 * Throws ScopeError with an instructive message when a referenced item does not
 * exist, is ambiguous, or when a line ends up without a description or rate.
 */
export async function resolveLineItems(
  ctx: McpCtx,
  resolvedBusinessId: string,
  lines: LineItemInput[]
): Promise<{ resolved: ResolvedLineItem[]; usedItems: ItemRow[] }> {
  const needsCatalog = lines.some((line) => line.item_id || line.item_name)
  const usedItems: ItemRow[] = []

  const resolved: ResolvedLineItem[] = []
  for (const [index, line] of lines.entries()) {
    const position = `line ${index + 1}`
    let item: ItemRow | null = null

    if (needsCatalog && (line.item_id || line.item_name)) {
      item = await resolveItem(ctx, resolvedBusinessId, line.item_id, line.item_name, position)
      usedItems.push(item)
    }

    const description = line.description ?? (item ? item.description?.trim() || item.name : undefined)
    const rate = line.rate ?? item?.rate

    if (!description) {
      throw new ScopeError(
        `Missing description on ${position}. Provide description, or reference a saved item with item_id / item_name.`
      )
    }
    if (rate === undefined) {
      throw new ScopeError(
        `Missing rate on ${position}. Provide rate, or reference a saved item with item_id / item_name so the saved rate can be used.`
      )
    }

    resolved.push({ description, quantity: line.quantity ?? 1, rate })
  }

  return { resolved, usedItems }
}

/**
 * Looks up one saved item by id or by exact (case-insensitive) name within a
 * business. Mirrors resolveClient's behavior: exact match only, ambiguity is an
 * error rather than a guess, and a miss suggests near matches so the caller can
 * correct the name instead of retrying blind.
 */
export async function resolveItem(
  ctx: McpCtx,
  resolvedBusinessId: string,
  itemId: string | undefined,
  itemName: string | undefined,
  position = 'this line'
): Promise<ItemRow> {
  if (itemId) {
    const { data, error } = await ctx.db.svc
      .from('items')
      .select('*')
      .eq('id', itemId)
      .eq('business_id', resolvedBusinessId)
      .maybeSingle()

    if (error) {
      console.error('resolveItem (by id):', error)
      throw new Error('Could not look up saved item.')
    }
    if (!data) {
      throw new ScopeError(`No saved item ${itemId} in this business (${position}). Call list_items to see what exists.`)
    }
    return data
  }

  if (!itemName) {
    throw new ScopeError(`Provide item_id or item_name to identify the saved item for ${position}.`)
  }

  const escaped = escapeLike(itemName)

  const { data: exact, error } = await ctx.db.svc
    .from('items')
    .select('*')
    .eq('business_id', resolvedBusinessId)
    .ilike('name', escaped)

  if (error) {
    console.error('resolveItem (exact):', error)
    throw new Error('Could not look up saved item.')
  }

  if (exact && exact.length === 1) {
    return exact[0]
  }

  if (exact && exact.length > 1) {
    throw new ScopeError(
      `Multiple saved items named "${itemName}" exist in this business; pass item_id to disambiguate: ${exact
        .map((i) => `"${i.name}" (${i.id})`)
        .join(', ')}.`
    )
  }

  const { data: close } = await ctx.db.svc
    .from('items')
    .select('id, name')
    .eq('business_id', resolvedBusinessId)
    .ilike('name', `%${escaped}%`)
    .limit(ITEM_LOOKUP_LIMIT)

  if (close && close.length > 0) {
    throw new ScopeError(
      `No saved item named "${itemName}" found in this business. Did you mean: ${close
        .map((i) => `"${i.name}" (${i.id})`)
        .join(', ')}?`
    )
  }

  throw new ScopeError(
    `No saved item named "${itemName}" found in this business. Call list_items to see the catalog, or create_item to add it.`
  )
}
