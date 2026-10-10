import { z } from 'zod'
import { addDays } from 'date-fns'
import type { McpServer } from '@modelcontextprotocol/server'
import type { McpCtx } from '@/lib/mcp/context'
import { ScopeError } from '@/lib/mcp/scoped-db'
import { computeInvoiceTotals } from '@/lib/invoices/build'
import type { Database } from '@/types/database'
import { appUrl, errorResult, jsonResult, formatCurrency, publicUrl, pdfUrl, escapeLike } from '@/lib/mcp/shared'
import { lineItemInput, resolveLineItems } from '@/lib/mcp/line-items'
import { parseDay, toISODate, todayISO } from '@/lib/dates'
import { engagementErrorMessage } from '@/lib/engagements/errors'

type ClientRow = Database['public']['Tables']['clients']['Row']
type InvoiceRow = Database['public']['Tables']['invoices']['Row']

const DATE_FIELD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

const discountFields = {
  discount_type: z
    .enum(['percentage', 'fixed'])
    .optional()
    .describe('Discount type. Defaults to "percentage".'),
  discount_value: z
    .number()
    .min(0)
    .optional()
    .describe(
      'Discount value: a percent (0-100) if discount_type is "percentage", or a flat amount otherwise. Defaults to 0.'
    ),
  tax_rate: z.number().min(0).max(100).optional().describe('Tax rate percent, applied after the discount. Defaults to 0.'),
  shipping_amount: z.number().min(0).optional().describe('Flat shipping amount, added after tax. Defaults to 0.'),
}

/**
 * Resolves a client by client_id or client_name, scoped to resolvedBusinessId.
 * client_name is matched case-insensitively but must be an exact match (no
 * partial matching) to avoid silently picking the wrong client; on a miss it
 * surfaces close matches via ilike to help the caller correct the name.
 */
export async function resolveClient(
  ctx: McpCtx,
  resolvedBusinessId: string,
  client_id: string | undefined,
  client_name: string | undefined
): Promise<ClientRow> {
  if (client_id) {
    const client = await ctx.db.assertClientAccess(client_id)
    if (client.business_id !== resolvedBusinessId) {
      throw new ScopeError(`Client ${client_id} does not belong to business ${resolvedBusinessId}.`)
    }
    return client
  }

  if (!client_name) {
    throw new ScopeError('Provide either client_id or client_name to identify the client.')
  }

  // Escape ilike wildcards (% and _) so a literal client name containing
  // either character (e.g. "50% Off Co") is matched exactly rather than as
  // a pattern.
  const escaped = escapeLike(client_name)

  const { data: exact, error } = await ctx.db.svc
    .from('clients')
    .select('*')
    .eq('business_id', resolvedBusinessId)
    .ilike('name', escaped)

  if (error) {
    console.error('resolveClient (exact):', error)
    throw new Error('Could not look up client.')
  }

  if (exact && exact.length === 1) {
    return exact[0]
  }

  if (exact && exact.length > 1) {
    throw new ScopeError(
      `Multiple clients named "${client_name}" exist in this business; pass client_id to disambiguate: ${exact
        .map((c) => `"${c.name}" (${c.id})`)
        .join(', ')}.`
    )
  }

  const { data: close } = await ctx.db.svc
    .from('clients')
    .select('id, name')
    .eq('business_id', resolvedBusinessId)
    .ilike('name', `%${escaped}%`)
    .limit(5)

  if (close && close.length > 0) {
    throw new ScopeError(
      `No client named "${client_name}" found in this business. Did you mean: ${close
        .map((c) => `"${c.name}" (${c.id})`)
        .join(', ')}?`
    )
  }

  throw new ScopeError(`No client named "${client_name}" found in this business.`)
}

/**
 * Registers the invoice write tools (create_invoice, update_draft_invoice)
 * on the given MCP server, scoped to the businesses in ctx.db.scope.
 *
 * Both tools mirror the app's own invoice math and persistence flow
 * (see src/lib/actions/invoices.ts createInvoiceAction/updateInvoiceAction
 * and src/lib/invoices/build.ts for the shared totals math) so invoices
 * created via MCP are indistinguishable from ones created in the app.
 */
export function registerInvoiceWriteTools(server: McpServer, ctx: McpCtx) {
  server.registerTool(
    'create_invoice',
    {
      title: 'Create Invoice',
      description:
        'Draft a new invoice for a client, identified by client_id or client_name (exact match, case-insensitive). Always created as a draft. Use send_invoice separately to send it. Pass engagement_entry_ids to bill agreed work off an engagement schedule, which marks those entries invoiced in the same step so they can never be billed twice.',
      inputSchema: z.object({
        currency: z.string().regex(/^[A-Z]{3}$/).optional().describe('Invoice currency. Defaults to the client currency. Source work must use this currency; no implicit conversion.'),
        request_id: z.string().uuid().describe('Unique request ID. Reuse the same ID and input after a timeout to return the original draft.'),
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Id of the business to create the invoice under. Optional when the API key is scoped to exactly one business; required if scoped to multiple.'
          ),
        client_id: z.string().uuid().optional().describe('Id of the client. Provide this or client_name.'),
        client_name: z
          .string()
          .max(200)
          .optional()
          .describe('Exact (case-insensitive) client name. Provide this or client_id.'),
        line_items: z
          .array(lineItemInput)
          .min(1).optional()
          .describe(
            'Invoice line items. Omit when billing time_entry_ids or expense_ids; source work determines those lines. Each line is either written out (description + quantity + rate) or points at a saved item via item_id / item_name, which supplies the description and rate.'
          ),
        issue_date: DATE_FIELD.optional().describe('Issue date, YYYY-MM-DD. Defaults to today.'),
        due_date: DATE_FIELD.optional().describe(
          "Due date, YYYY-MM-DD. Defaults to issue_date + the business's default payment terms."
        ),
        notes: z.string().max(2000).optional().describe('Notes shown on the invoice. Defaults to the business notes template.'),
        status: z
          .literal('draft')
          .optional()
          .describe('Invoice status. Only "draft" is supported here. Use send_invoice to send.'),
        time_entry_ids: z
          .array(z.string().uuid())
          .max(100)
          .optional()
          .describe(
            'Ids of unbilled time entries (from list_unbilled) to mark as billed by attaching them to this invoice. Each must belong to the same business and not already be on another invoice.'
          ),
        expense_ids: z
          .array(z.string().uuid())
          .max(100)
          .optional()
          .describe(
            'Ids of unbilled expenses (from list_unbilled) to mark as billed by attaching them to this invoice. Each must belong to the same business and not already be on another invoice.'
          ),
        engagement_entry_ids: z
          .array(z.string().uuid())
          .max(100)
          .optional()
          .describe(
            'Ids of engagement schedule entries to bill (from list_ready_to_bill or get_engagement). Each becomes one line at the agreed amount and is marked invoiced in the same step, so it cannot be billed again. Every entry must be ready to bill, belong to this client, and be in the invoice currency; an entry that is already invoiced refuses the whole call.'
          ),
        ...discountFields,
      }),
    },
    async ({ currency,
      request_id,
      business_id,
      client_id,
      client_name,
      line_items = [],
      issue_date,
      due_date,
      notes,
      time_entry_ids,
      expense_ids,
      engagement_entry_ids,
      discount_type,
      discount_value,
      tax_rate,
      shipping_amount,
    }) => {
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

      const { data: business, error: businessError } = await ctx.db.svc
        .from('businesses')
        .select('*')
        .eq('id', resolvedBusinessId)
        .maybeSingle()

      if (businessError || !business) {
        console.error('create_invoice (business):', businessError)
        return errorResult('Could not load business.')
      }

      let resolvedLineItems
      try {
        resolvedLineItems = (await resolveLineItems(ctx, resolvedBusinessId, line_items)).resolved
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve line items.')
      }

      const resolvedIssueDate = issue_date || todayISO()
      const resolvedDueDate =
        due_date ||
        toISODate(addDays(parseDay(resolvedIssueDate), business.default_payment_terms))

      // Currency follows the client, falling back to the business default:
      // exactly what the app's invoice form does when a client is picked
      // (setValue('currency', client.currency) in invoice-form.tsx).
      const invoiceCurrency = currency || client.currency || business.default_currency

      const requestedTimeIds = time_entry_ids ?? []
      const requestedExpenseIds = expense_ids ?? []
      const requestedEntryIds = engagement_entry_ids ?? []
      const { data: created, error: createError } = await ctx.db.svc.rpc('create_invoice_document', {
        p_business_id: resolvedBusinessId, p_client_id: client.id,
        p_request_id: request_id, p_key_id: ctx.keyId,
        p_time_ids: requestedTimeIds, p_expense_ids: requestedExpenseIds,
        // Validated, priced and claimed inside the RPC's transaction.
        // Nothing is marked invoiced unless the whole
        // invoice is written.
        p_engagement_entry_ids: requestedEntryIds,
        p_patch: { issue_date: resolvedIssueDate, due_date: resolvedDueDate, currency: invoiceCurrency,
          notes: notes ?? business.invoice_notes, discount_type: discount_type ?? 'percentage',
          discount_value: discount_value ?? 0, tax_rate: tax_rate ?? 0, shipping_amount: shipping_amount ?? 0 },
        p_lines: resolvedLineItems.map((line) => ({ ...line })),
      })
      if (createError || !created) {
        return errorResult(
          engagementErrorMessage(createError?.message) ||
            createError?.message ||
            'Could not create invoice.'
        )
      }
      const invoice = created as unknown as Database['public']['Tables']['invoices']['Row']
      const invoiceNumber = invoice.invoice_number
      const linkageNote = requestedTimeIds.length + requestedExpenseIds.length > 0 ? ' Source work was priced and linked atomically.' : ''
      const engagementNote =
        requestedEntryIds.length > 0
          ? ` ${requestedEntryIds.length} engagement schedule ${requestedEntryIds.length === 1 ? 'entry is' : 'entries are'} now marked invoiced and cannot be billed again.`
          : ''
      const { data: savedLines } = await ctx.db.svc.from('invoice_line_items').select('description,quantity,rate,amount').eq('invoice_id', invoice.id)

      const result = {
        summary: `Drafted ${invoiceNumber} for ${client.name}: ${formatCurrency(invoice.total, invoice.currency)}${linkageNote}${engagementNote}`,
        invoice: {
          id: invoice.id,
          business_id: invoice.business_id,
          client_id: invoice.client_id,
          invoice_number: invoice.invoice_number,
          status: invoice.status,
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
          balance_due: invoice.balance_due,
          notes: invoice.notes,
          line_items: savedLines ?? [],
        },
        linked_time_entry_ids: requestedTimeIds,
        linked_expense_ids: requestedExpenseIds,
        billed_engagement_entry_ids: requestedEntryIds,
        public_url: publicUrl(invoice.public_id),
        pdf_url: pdfUrl(invoice.public_id),
        app_url: `${appUrl()}/invoices/${invoice.id}`,
      }

      return jsonResult(result)
    }
  )

  server.registerTool(
    'update_draft_invoice',
    {
      title: 'Update Draft Invoice',
      description:
        'Update a draft invoice: replace its line items and/or adjust dates, notes, discount, tax, or shipping. Refuses to modify invoices that are no longer in draft status. Cancel and recreate instead.',
      inputSchema: z.object({
        invoice_id: z.string().uuid().describe('Id of the draft invoice to update.'),
        line_items: z
          .array(lineItemInput)
          .min(1)
          .optional()
          .describe(
            'If provided, replaces ALL existing line items and recomputes totals. Lines may reference saved items via item_id / item_name.'
          ),
        notes: z.string().max(2000).optional().describe('Replaces the notes field.'),
        issue_date: DATE_FIELD.optional().describe('Replaces the issue date, YYYY-MM-DD.'),
        due_date: DATE_FIELD.optional().describe('Replaces the due date, YYYY-MM-DD.'),
        ...discountFields,
        discount_type: discountFields.discount_type.describe(
          'Discount type. Defaults to "percentage". If provided alone, the existing discount_value is reinterpreted under the new type (e.g. a stored fixed $50 discount becomes a 50% discount). Pass discount_value together with discount_type to set both explicitly.'
        ),
      }),
    },
    async ({ invoice_id, line_items, notes, issue_date, due_date, discount_type, discount_value, tax_rate, shipping_amount }) => {
      let invoice
      try {
        invoice = await ctx.db.assertInvoiceAccess(invoice_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access invoice.')
      }

      if (invoice.status !== 'draft') {
        return errorResult(
          `Invoice ${invoice.invoice_number} is "${invoice.status}", not "draft". Only draft invoices can be edited. Cancel it and create a new one if changes are needed.`
        )
      }

      // Only read when the caller is NOT replacing the lines, because then the
      // stored lines are the input to the recomputed totals. When line_items IS
      // supplied the replacement happens inside replace_invoice_line_items and
      // there are no rows to restore, so the read is dead weight.
      let storedLineItems: { description: string; quantity: number; rate: number }[] = []
      if (!line_items) {
        const { data, error: existingError } = await ctx.db.svc
          .from('invoice_line_items')
          .select('description, quantity, rate, sort_order')
          .eq('invoice_id', invoice_id)
          .order('sort_order', { ascending: true })
          .limit(500)

        if (existingError) {
          console.error('update_draft_invoice (load line items):', existingError)
          return errorResult('Could not load existing line items.')
        }
        storedLineItems = data ?? []
      }

      let currentLineItems: { description: string; quantity: number; rate: number }[]
      if (line_items) {
        try {
          currentLineItems = (await resolveLineItems(ctx, invoice.business_id, line_items)).resolved
        } catch (err) {
          return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve line items.')
        }
      } else {
        currentLineItems = storedLineItems.map((li) => ({
          description: li.description,
          quantity: li.quantity,
          rate: li.rate,
        }))
      }

      const totals = computeInvoiceTotals(currentLineItems, {
        discount_type: discount_type ?? (invoice.discount_type as 'percentage' | 'fixed'),
        discount_value: discount_value ?? invoice.discount_value,
        tax_rate: tax_rate ?? invoice.tax_rate,
        shipping_amount: shipping_amount ?? invoice.shipping_amount,
      })

      // balance_due is deliberately absent. replace_invoice_line_items derives
      // it as total - amount_paid, which is the same number for a draft (whose
      // amount_paid is 0) and the correct one if that ever stops being true.
      const patch = {
        issue_date: issue_date ?? invoice.issue_date,
        due_date: due_date ?? invoice.due_date,
        notes: notes ?? invoice.notes,
        subtotal: totals.subtotal,
        discount_type: discount_type ?? invoice.discount_type,
        discount_value: discount_value ?? invoice.discount_value,
        discount_amount: totals.discount_amount,
        tax_rate: tax_rate ?? invoice.tax_rate,
        tax_amount: totals.tax_amount,
        shipping_amount: shipping_amount ?? invoice.shipping_amount,
        total: totals.total,
      }

      let updated: InvoiceRow | null = null

      if (line_items) {
        // ONE TRANSACTION. replace_invoice_line_items does
        // the delete, the re-insert and the totals update together. What this
        // replaces deleted the old rows, inserted the new ones, and on failure
        // tried to re-insert the rows it had just deleted; when that restore
        // itself failed the tool had to tell the caller that the invoice now
        // had no line items and ask it to repair the document. A billing
        // document showing a total with nothing under it is no longer a state
        // this path can produce.
        const { data, error: replaceError } = await ctx.db.svc.rpc('replace_invoice_line_items', {
          p_invoice_id: invoice_id,
          p_line_items: totals.line_items.map((item) => ({
            description: item.description ?? '',
            quantity: item.quantity,
            rate: item.rate,
            amount: item.amount,
          })),
          p_invoice_patch: patch,
        })

        if (replaceError || !data) {
          console.error('update_draft_invoice (replace line items):', replaceError)
          if (replaceError?.message === 'invalid_line_items') {
            return errorResult(
              'Those line items were rejected; the invoice was left unchanged. Send between 1 and 500 lines and retry.'
            )
          }
          return errorResult('Could not update the invoice; it was left unchanged.')
        }

        updated = data as unknown as InvoiceRow
      } else {
        const { data, error: updateError } = await ctx.db.svc
          .from('invoices')
          .update(patch)
          .eq('id', invoice_id)
          .select('*')
          .single()

        if (updateError || !data) {
          console.error('update_draft_invoice (update):', updateError)
          return errorResult('Could not update invoice.')
        }

        updated = data
      }

      const result = {
        summary: `Updated draft ${updated.invoice_number}: ${formatCurrency(totals.total, updated.currency)}`,
        invoice: {
          id: updated.id,
          invoice_number: updated.invoice_number,
          status: updated.status,
          issue_date: updated.issue_date,
          due_date: updated.due_date,
          currency: updated.currency,
          subtotal: updated.subtotal,
          discount_type: updated.discount_type,
          discount_value: updated.discount_value,
          discount_amount: updated.discount_amount,
          tax_rate: updated.tax_rate,
          tax_amount: updated.tax_amount,
          shipping_amount: updated.shipping_amount,
          total: updated.total,
          balance_due: updated.balance_due,
          notes: updated.notes,
          line_items: totals.line_items.map((item) => ({
            description: item.description,
            quantity: item.quantity,
            rate: item.rate,
            amount: item.amount,
          })),
        },
        public_url: publicUrl(updated.public_id),
        pdf_url: pdfUrl(updated.public_id),
        app_url: `${appUrl()}/invoices/${updated.id}`,
      }

      return jsonResult(result)
    }
  )
}
