import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { McpCtx } from '@/lib/mcp/context'
import { ScopeError } from '@/lib/mcp/scoped-db'
import {
  appUrl,
  errorResult,
  jsonResult,
  formatCurrency,
  UNPAID_STATUSES,
  isOverdue,
  publicUrl,
  pdfUrl,
  truncationNote,
} from '@/lib/mcp/shared'

const statusEnum = z.enum([
  'draft',
  'sent',
  'viewed',
  'paid',
  'partial',
  'overdue',
  'cancelled',
  'unpaid',
])

/**
 * Registers the invoice read tools (list, get, get link) on the given MCP
 * server, scoped to the businesses in ctx.db.scope.
 */
export function registerInvoiceReadTools(server: McpServer, ctx: McpCtx) {
  server.registerTool(
    'list_invoices',
    {
      title: 'List Invoices',
      description:
        "List invoices for the caller's businesses, most recent first. Optionally filter by business, status (including the synthetic 'unpaid' status, which matches sent/viewed/partial/overdue), and/or client.",
      inputSchema: z.object({
        offset: z.number().int().min(0).max(1000000).optional().describe('Page offset. Start at 0, then use next_offset until it is null. Keep other filters unchanged.'),
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Id of the business whose invoices to list. Optional. Omit to list across all businesses in scope.'
          ),
        status: statusEnum
          .optional()
          .describe(
            "Filter by status. 'unpaid' is a synthetic filter matching sent, viewed, partial, and overdue invoices."
          ),
        client_id: z.string().uuid().optional().describe('Filter to invoices for this client only.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Max invoices to return (default 20, max 100).'),
      }),
    },
    async ({ offset, business_id, status, client_id, limit }) => {
      let businessIds = ctx.db.scope.businessIds
      if (business_id !== undefined) {
        let resolvedId: string
        try {
          resolvedId = ctx.db.resolveBusinessId(business_id)
        } catch (err) {
          return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve business.')
        }
        businessIds = [resolvedId]
      }

      const resolvedLimit = limit ?? 20

      let query = ctx.db.svc
        .from('invoices')
        .select(
          'id, invoice_number, status, issue_date, due_date, total, balance_due, currency, client:clients(name)'
        )
        .in('business_id', ctx.db.scope.businessIds)
        .in('business_id', businessIds)
        .order('issue_date', { ascending: false })
        .order('id', { ascending: true })
        .range(offset ?? 0, (offset ?? 0) + resolvedLimit - 1)

      if (status === 'unpaid') {
        query = query.in('status', UNPAID_STATUSES)
      } else if (status) {
        query = query.eq('status', status)
      }

      if (client_id) {
        query = query.eq('client_id', client_id)
      }

      const { data, error } = await query

      if (error) {
        console.error('list_invoices:', error)
        return errorResult('Could not list invoices.')
      }

      const invoices = (data ?? []).map((inv) => ({
        id: inv.id,
        invoice_number: inv.invoice_number,
        client_name: (inv.client as { name: string } | null)?.name ?? null,
        status: inv.status,
        is_overdue: isOverdue(inv.status, inv.due_date),
        issue_date: inv.issue_date,
        due_date: inv.due_date,
        currency: inv.currency,
        total: inv.total,
        balance_due: inv.balance_due,
        app_url: `${appUrl()}/invoices/${inv.id}`,
      }))

      const currencies = Array.from(new Set(invoices.map((inv) => inv.currency)))
      const countLabel = `${invoices.length} invoice${invoices.length === 1 ? '' : 's'}`

      let summary: string
      if (invoices.length === 0) {
        summary = `${countLabel}.`
      } else if (currencies.length === 1) {
        const outstanding = invoices.reduce((sum, inv) => sum + (inv.balance_due ?? 0), 0)
        summary = `${countLabel}, ${formatCurrency(outstanding, currencies[0])} outstanding`
      } else {
        const byCurrency = currencies.map((currency) => {
          const group = invoices.filter((inv) => inv.currency === currency)
          const outstanding = group.reduce((sum, inv) => sum + (inv.balance_due ?? 0), 0)
          return `${group.length} ${currency}: ${formatCurrency(outstanding, currency)} outstanding`
        })
        summary = `${countLabel} (${byCurrency.join('; ')})`
      }

      const truncated = invoices.length === resolvedLimit
      const result = {
        offset: offset ?? 0,
        next_offset: (data ?? []).length === resolvedLimit ? (offset ?? 0) + resolvedLimit : null,
        summary: `${summary}${truncated ? truncationNote(resolvedLimit) : ''}`,
        invoices,
        ...(truncated ? { truncated: true } : {}),
      }

      return jsonResult(result)
    }
  )

  server.registerTool(
    'get_invoice',
    {
      title: 'Get Invoice',
      description:
        'Fetch full details for one invoice, including line items, client, and public/PDF links. Identify the invoice by invoice_id, or by invoice_number (optionally scoped to a specific business if the caller has more than one).',
      inputSchema: z.object({
        invoice_id: z.string().uuid().optional().describe('Id of the invoice to fetch.'),
        invoice_number: z
          .string()
          .optional()
          .describe('Invoice number to look up (e.g. "INV-0004"). Used only if invoice_id is omitted.'),
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'When looking up by invoice_number, restrict the search to this business. Optional when scoped to a single business; recommended if scoped to multiple.'
          ),
      }),
    },
    async ({ invoice_id, invoice_number, business_id }) => {
      let invoice
      try {
        if (invoice_id) {
          invoice = await ctx.db.assertInvoiceAccess(invoice_id)
        } else if (invoice_number) {
          let businessIds = ctx.db.scope.businessIds
          if (business_id !== undefined) {
            const resolvedId = ctx.db.resolveBusinessId(business_id)
            businessIds = [resolvedId]
          }

          const { data, error } = await ctx.db.svc
            .from('invoices')
            .select('*')
            .eq('invoice_number', invoice_number)
            .in('business_id', businessIds)

          if (error) {
            console.error('get_invoice (by number):', error)
            return errorResult('Could not look up invoice.')
          }

          if (!data || data.length === 0) {
            return errorResult(`No invoice found with number "${invoice_number}".`)
          }

          if (data.length > 1) {
            return errorResult(
              `Multiple invoices found with number "${invoice_number}" across businesses in scope; pass business_id to disambiguate.`
            )
          }

          invoice = data[0]
        } else {
          return errorResult('Provide either invoice_id or invoice_number.')
        }
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access invoice.')
      }

      const [{ data: lineItems, error: lineItemsError }, { data: client, error: clientError }] =
        await Promise.all([
          ctx.db.svc
            .from('invoice_line_items')
            .select('id, description, quantity, rate, discount_percent, discount_amount, tax_rate, tax_amount, amount, sort_order')
            .eq('invoice_id', invoice.id)
            .order('sort_order', { ascending: true })
            .limit(500),
          ctx.db.svc
            .from('clients')
            .select('id, name, email')
            .eq('id', invoice.client_id)
            .eq('business_id', invoice.business_id)
            .maybeSingle(),
        ])

      if (lineItemsError) {
        console.error('get_invoice (line items):', lineItemsError)
        return errorResult('Could not load line items.')
      }

      if (clientError) {
        console.error('get_invoice (client):', clientError)
        return errorResult('Could not load client.')
      }

      const result = {
        summary: `Invoice ${invoice.invoice_number}: ${invoice.status}, ${formatCurrency(invoice.balance_due, invoice.currency)} balance due.`,
        invoice: {
          id: invoice.id,
          business_id: invoice.business_id,
          invoice_number: invoice.invoice_number,
          status: invoice.status,
          is_overdue: isOverdue(invoice.status, invoice.due_date),
          issue_date: invoice.issue_date,
          due_date: invoice.due_date,
          currency: invoice.currency,
          subtotal: invoice.subtotal,
          discount_type: invoice.discount_type,
          discount_value: invoice.discount_value,
          discount_amount: invoice.discount_amount,
          tax_rate: invoice.tax_rate,
          tax_amount: invoice.tax_amount,
          shipping_amount: invoice.shipping_amount,
          total: invoice.total,
          amount_paid: invoice.amount_paid,
          balance_due: invoice.balance_due,
          notes: invoice.notes,
          terms: invoice.terms,
          po_number: invoice.po_number,
          client: client
            ? { id: client.id, name: client.name, email: client.email }
            : null,
          line_items: (lineItems ?? []).map((li) => ({
            id: li.id,
            description: li.description,
            quantity: li.quantity,
            rate: li.rate,
            discount_percent: li.discount_percent,
            discount_amount: li.discount_amount,
            tax_rate: li.tax_rate,
            tax_amount: li.tax_amount,
            amount: li.amount,
          })),
          public_url: publicUrl(invoice.public_id),
          pdf_url: pdfUrl(invoice.public_id),
          app_url: `${appUrl()}/invoices/${invoice.id}`,
        },
      }

      return jsonResult(result)
    }
  )

  server.registerTool(
    'get_invoice_link',
    {
      title: 'Get Invoice Link',
      description:
        "Get the shareable public link and PDF download link for an invoice. The invoice must belong to one of the caller's businesses.",
      inputSchema: z.object({
        invoice_id: z.string().uuid().describe('Id of the invoice.'),
      }),
    },
    async ({ invoice_id }) => {
      let invoice
      try {
        invoice = await ctx.db.assertInvoiceAccess(invoice_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access invoice.')
      }

      const result = {
        summary: `Invoice ${invoice.invoice_number} link.`,
        public_url: publicUrl(invoice.public_id),
        pdf_url: pdfUrl(invoice.public_id),
      }

      return jsonResult(result)
    }
  )
}
