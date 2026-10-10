import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { McpCtx } from '@/lib/mcp/context'
import { ScopeError } from '@/lib/mcp/scoped-db'
import { appUrl, errorResult, jsonResult, escapeLike, likeAnyFilter, truncationNote } from '@/lib/mcp/shared'

const CLIENTS_LIMIT = 100

export interface ClientFinancials {
  total_invoiced: number
  outstanding_balance: number
  total_paid: number
}

const ZERO_FINANCIALS: ClientFinancials = {
  total_invoiced: 0,
  outstanding_balance: 0,
  total_paid: 0,
}

/**
 * Computes per-client invoiced/outstanding totals from the invoices table.
 *
 * The clients table has stored total_invoiced/outstanding_balance columns, but
 * nothing in the app maintains them, so they are permanently stale. These
 * tools derive the figures instead, in one query per call, scoped to the
 * caller's businesses. Non-draft, non-cancelled invoices only, matching
 * revenue_summary's EXCLUDED_FROM_TOTALS rule.
 */
async function computeClientFinancials(
  ctx: McpCtx,
  businessIds: string[],
  clientIds: string[]
): Promise<Map<string, ClientFinancials>> {
  const totals = new Map<string, ClientFinancials>()
  if (clientIds.length === 0) return totals

  const { data, error } = await ctx.db.svc.from('client_financials').select('*').in('business_id',businessIds).in('client_id',clientIds)
  if(error)throw error
  for(const row of data||[]){if(row.client_id&&row.currency)totals.set(`${row.client_id}:${row.currency}`,{total_invoiced:row.total_invoiced||0,total_paid:row.total_paid||0,outstanding_balance:row.outstanding_balance||0})}

  return totals
}

const clientMutableFields = {
  name: z.string().min(1).max(200).describe('Client name (person or company).'),
  email: z.string().email().max(320).optional().describe("Client's email address."),
  phone: z.string().max(50).optional().describe("Client's phone number."),
  address_line1: z.string().max(200).optional().describe('Street address, line 1.'),
  address_line2: z.string().max(200).optional().describe('Street address, line 2 (suite, unit, etc).'),
  city: z.string().max(100).optional().describe('City.'),
  state: z.string().max(100).optional().describe('State or province.'),
  postal_code: z.string().max(20).optional().describe('Postal or ZIP code.'),
  country: z.string().max(100).optional().describe('Country.'),
  currency: z.string().max(10).optional().describe('ISO currency code for this client, e.g. "USD". Defaults to the business currency if omitted.'),
  notes: z.string().max(2000).optional().describe('Free-form internal notes about this client.'),
}

/**
 * Registers the four client-management tools (list, get, create, update) on
 * the given MCP server, scoped to the businesses in ctx.db.scope.
 */
export function registerClientTools(server: McpServer, ctx: McpCtx) {
  server.registerTool(
    'list_clients',
    {
      title: 'List Clients',
      description:
        "List clients for one of the caller's businesses, ordered by name. Optionally filter by a case-insensitive substring search on name or email.",
      inputSchema: z.object({
        offset: z.number().int().min(0).max(1000000).optional().describe('Page offset. Start at 0, then use next_offset until it is null. Keep other filters unchanged.'),
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Id of the business whose clients to list. Optional when the API key is scoped to exactly one business; required if scoped to multiple.'
          ),
        search: z
          .string()
          .max(200)
          .optional()
          .describe('Case-insensitive substring to filter clients by name or email.'),
      }),
    },
    async ({ offset, business_id, search }) => {
      let resolvedId: string
      try {
        resolvedId = ctx.db.resolveBusinessId(business_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve business.')
      }

      let query = ctx.db.svc
        .from('clients')
        .select('id, name, email, currency')
        .in('business_id', ctx.db.scope.businessIds)
        .eq('business_id', resolvedId)
        .order('name', { ascending: true })
        .order('id', { ascending: true })
        .range(offset ?? 0, (offset ?? 0) + CLIENTS_LIMIT - 1)

      if (search) {
        // likeAnyFilter quotes the term: `.or()` takes a raw PostgREST filter
        // expression, so an unquoted search containing a comma or a dot became
        // extra filters of the agent's choosing.
        query = query.or(likeAnyFilter(['name', 'email'], search))
      }

      const { data, error } = await query

      if (error) {
        console.error('list_clients:', error)
        return errorResult('Could not list clients.')
      }

      const rows = data ?? []

      let financials: Map<string, ClientFinancials>
      try {
        financials = await computeClientFinancials(
          ctx,
          [resolvedId],
          rows.map((c) => c.id)
        )
      } catch {
        return errorResult('Could not compute client totals.')
      }

      const clients = rows.map((c) => {
        const f = financials.get(`${c.id}:${c.currency}`)
        return {
          id: c.id,
          name: c.name,
          email: c.email,
          currency: c.currency,
          outstanding_balance: f?.outstanding_balance ?? 0,
          total_invoiced: f?.total_invoiced ?? 0,
          app_url: `${appUrl()}/clients/${c.id}`,
        }
      })

      const truncated = rows.length === CLIENTS_LIMIT
      const result = {
        offset: offset ?? 0,
        next_offset: (data ?? []).length === CLIENTS_LIMIT ? (offset ?? 0) + CLIENTS_LIMIT : null,
        summary: `${clients.length} client${clients.length === 1 ? '' : 's'} found.${truncated ? truncationNote(CLIENTS_LIMIT) : ''}`,
        clients,
        ...(truncated ? { truncated: true } : {}),
      }

      return jsonResult(result)
    }
  )

  server.registerTool(
    'get_client',
    {
      title: 'Get Client',
      description:
        "Fetch full details for one client, including their five most recent invoices. The client must belong to one of the caller's businesses.",
      inputSchema: z.object({
        client_id: z.string().uuid().describe('Id of the client to fetch.'),
      }),
    },
    async ({ client_id }) => {
      let client
      try {
        client = await ctx.db.assertClientAccess(client_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access client.')
      }

      const { data: invoices, error } = await ctx.db.svc
        .from('invoices')
        .select('id, invoice_number, status, total')
        .eq('client_id', client_id)
        .eq('business_id', client.business_id)
        .order('issue_date', { ascending: false })
        .limit(5)

      if (error) {
        console.error('get_client:', error)
        return errorResult('Could not load recent invoices.')
      }

      let financials: ClientFinancials
      try {
        const map = await computeClientFinancials(ctx, [client.business_id], [client.id])
        financials = map.get(`${client.id}:${client.currency}`) ?? { ...ZERO_FINANCIALS }
      } catch {
        return errorResult('Could not compute client totals.')
      }

      const result = {
        summary: `${client.name}: outstanding ${financials.outstanding_balance} ${client.currency}, total invoiced ${financials.total_invoiced} ${client.currency}.`,
        client: {
          id: client.id,
          business_id: client.business_id,
          name: client.name,
          email: client.email,
          phone: client.phone,
          address_line1: client.address_line1,
          address_line2: client.address_line2,
          city: client.city,
          state: client.state,
          postal_code: client.postal_code,
          country: client.country,
          currency: client.currency,
          notes: client.notes,
          outstanding_balance: financials.outstanding_balance,
          total_invoiced: financials.total_invoiced,
          total_paid: financials.total_paid,
          is_active: client.is_active,
          app_url: `${appUrl()}/clients/${client.id}`,
        },
        recent_invoices: (invoices ?? []).map((inv) => ({
          id: inv.id,
          invoice_number: inv.invoice_number,
          status: inv.status,
          total: inv.total,
        })),
      }

      return jsonResult(result)
    }
  )

  server.registerTool(
    'create_client',
    {
      title: 'Create Client',
      description:
        "Create a new client under one of the caller's businesses. Fails with an instructive error if a client with the same name already exists in that business. Use update_client instead in that case.",
      inputSchema: z.object({
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Id of the business to create the client under. Optional when the API key is scoped to exactly one business; required if scoped to multiple.'
          ),
        ...clientMutableFields,
      }),
    },
    async ({ business_id, ...fields }) => {
      let resolvedId: string
      try {
        resolvedId = ctx.db.resolveBusinessId(business_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve business.')
      }

      const { data: existing, error: existingError } = await ctx.db.svc
        .from('clients')
        .select('id')
        .eq('business_id', resolvedId)
        .ilike('name', escapeLike(fields.name))
        .maybeSingle()

      if (existingError) {
        console.error('create_client (duplicate check):', existingError)
        return errorResult('Could not verify client uniqueness.')
      }

      if (existing) {
        return errorResult(
          `A client named "${fields.name}" already exists in this business (id ${existing.id}). Use update_client with client_id "${existing.id}" instead of creating a duplicate.`
        )
      }

      const { data: created, error } = await ctx.db.svc
        .from('clients')
        .insert({
          business_id: resolvedId,
          ...fields,
          created_via: 'agent',
          created_by_key_id: ctx.keyId,
        })
        .select('*')
        .single()

      if (error || !created) {
        console.error('create_client:', error)
        return errorResult('Could not create client.')
      }

      const result = {
        summary: `Created client "${created.name}".`,
        client: {
          id: created.id,
          business_id: created.business_id,
          name: created.name,
          email: created.email,
          phone: created.phone,
          address_line1: created.address_line1,
          address_line2: created.address_line2,
          city: created.city,
          state: created.state,
          postal_code: created.postal_code,
          country: created.country,
          currency: created.currency,
          notes: created.notes,
          app_url: `${appUrl()}/clients/${created.id}`,
        },
      }

      return jsonResult(result)
    }
  )

  server.registerTool(
    'update_client',
    {
      title: 'Update Client',
      description:
        "Update fields on an existing client. Only fields provided are changed; omitted fields are left as-is. The client must belong to one of the caller's businesses.",
      inputSchema: z.object({
        client_id: z.string().uuid().describe('Id of the client to update.'),
        name: z.string().min(1).max(200).optional().describe('Client name (person or company).'),
        email: z.string().email().max(320).optional().describe("Client's email address."),
        phone: z.string().max(50).optional().describe("Client's phone number."),
        address_line1: z.string().max(200).optional().describe('Street address, line 1.'),
        address_line2: z.string().max(200).optional().describe('Street address, line 2 (suite, unit, etc).'),
        city: z.string().max(100).optional().describe('City.'),
        state: z.string().max(100).optional().describe('State or province.'),
        postal_code: z.string().max(20).optional().describe('Postal or ZIP code.'),
        country: z.string().max(100).optional().describe('Country.'),
        currency: z.string().max(10).optional().describe('ISO currency code for this client, e.g. "USD".'),
        notes: z.string().max(2000).optional().describe('Free-form internal notes about this client.'),
      }),
    },
    async ({ client_id, ...fields }) => {
      if (Object.keys(fields).length === 0) {
        return errorResult(
          'No fields to update. Provide at least one of name, email, phone, address_line1, address_line2, city, state, postal_code, country, currency, or notes.'
        )
      }

      let existing
      try {
        existing = await ctx.db.assertClientAccess(client_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access client.')
      }

      if (fields.name && fields.name.toLowerCase() !== existing.name.toLowerCase()) {
        const { data: dupe, error: dupeError } = await ctx.db.svc
          .from('clients')
          .select('id')
          .eq('business_id', existing.business_id)
          .ilike('name', escapeLike(fields.name))
          .neq('id', client_id)
          .maybeSingle()

        if (dupeError) {
          console.error('update_client (duplicate check):', dupeError)
          return errorResult('Could not verify client uniqueness.')
        }

        if (dupe) {
          return errorResult(
            `A client named "${fields.name}" already exists in this business (id ${dupe.id}). Choose a different name or update that client instead.`
          )
        }
      }

      const { data: updated, error } = await ctx.db.svc
        .from('clients')
        .update(fields)
        .eq('id', client_id)
        .select('*')
        .single()

      if (error || !updated) {
        console.error('update_client:', error)
        return errorResult('Could not update client.')
      }

      const result = {
        summary: `Updated client "${updated.name}".`,
        client: {
          id: updated.id,
          business_id: updated.business_id,
          name: updated.name,
          email: updated.email,
          phone: updated.phone,
          address_line1: updated.address_line1,
          address_line2: updated.address_line2,
          city: updated.city,
          state: updated.state,
          postal_code: updated.postal_code,
          country: updated.country,
          currency: updated.currency,
          notes: updated.notes,
          app_url: `${appUrl()}/clients/${updated.id}`,
        },
      }

      return jsonResult(result)
    }
  )
}
