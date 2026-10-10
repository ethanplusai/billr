import { z } from 'zod'
import { addDays } from 'date-fns'
import type { McpServer } from '@modelcontextprotocol/server'
import type { McpCtx } from '@/lib/mcp/context'
import { ScopeError } from '@/lib/mcp/scoped-db'
import { generatePublicId } from '@/lib/utils/invoice'
import { computeInvoiceTotals } from '@/lib/invoices/build'
import { lineItemInput, resolveLineItems } from '@/lib/mcp/line-items'
import { resolveClient } from './invoices-write'
import { sendEstimateEmail, SendEstimateEmailError } from '@/lib/estimates/send-email'
import { appUrl, errorResult, jsonResult, formatCurrency, pdfUrl, truncationNote } from '@/lib/mcp/shared'
import type { Database } from '@/types/database'
import { parseDay, toISODate, todayISO } from '@/lib/dates'

type ClientRow = Database['public']['Tables']['clients']['Row']
type InvoiceRow = Database['public']['Tables']['invoices']['Row']
type EstimateRow = Database['public']['Tables']['estimates']['Row']

/** Shape returned by the convert_estimate_to_invoice RPC. */
interface ConversionResult {
  /**
   * False when another call had already claimed this estimate, in which case
   * this call wrote nothing and `invoice` is the one that already exists.
   */
  claimed: boolean
  invoice: InvoiceRow | null
  invoice_number: string | null
}

const DATE_FIELD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

/** Days added to issue_date when the caller does not supply an expiry date. */
const DEFAULT_EXPIRY_DAYS = 30

const ESTIMATE_STATUSES = [
  'draft',
  'sent',
  'viewed',
  'accepted',
  'declined',
  'expired',
  'converted',
] as const

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
  tax_rate: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('Tax rate percent, applied after the discount. Defaults to 0.'),
  shipping_amount: z.number().min(0).optional().describe('Flat shipping amount, added after tax. Defaults to 0.'),
}

function estimatePublicUrl(publicId: string): string {
  return `${appUrl()}/e/${publicId}`
}

/**
 * The answer convert_estimate_to_invoice gives when the estimate was ALREADY
 * converted: the invoice that exists, reported as a success.
 *
 * Deliberately not an error. Both callers that reach it, the caller whose
 * estimate was converted before the call started and the loser of a concurrent
 * claim, are almost always the same agent retrying a request that already
 * succeeded. Telling it that its work failed is what produced duplicate
 * invoices in the first place. The shape matches the freshly converted result
 * field for field, with `already_converted` distinguishing the two, so a caller
 * needs no branch to read it.
 */
async function alreadyConvertedResult(ctx: McpCtx, estimate: EstimateRow, invoice: InvoiceRow) {
  const { data: lineItems } = await ctx.db.svc
    .from('invoice_line_items')
    .select('description, quantity, rate, amount, sort_order')
    .eq('invoice_id', invoice.id)
    .order('sort_order', { ascending: true })
    .limit(500)

  return jsonResult({
    summary: `Estimate ${estimate.estimate_number} had already been converted into draft invoice ${invoice.invoice_number}: ${formatCurrency(invoice.total, invoice.currency)}. Nothing new was created and no second invoice exists. Call send_invoice to deliver it.`,
    already_converted: true,
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
      total: invoice.total,
      balance_due: invoice.balance_due,
      line_items: (lineItems ?? []).map((item) => ({
        description: item.description,
        quantity: item.quantity,
        rate: item.rate,
        amount: item.amount,
      })),
    },
    estimate: {
      id: estimate.id,
      estimate_number: estimate.estimate_number,
      status: 'converted',
      converted_invoice_id: invoice.id,
    },
    pdf_url: pdfUrl(invoice.public_id),
    app_url: `${appUrl()}/invoices/${invoice.id}`,
  })
}

/**
 * Registers the estimate tools (create_estimate, update_draft_estimate,
 * get_estimate, list_estimates, send_estimate, convert_estimate_to_invoice),
 * scoped to the businesses in ctx.db.scope.
 *
 * These mirror the app's own estimate flow (src/lib/actions/estimates.ts):
 * both write through the create_estimate_document and
 * convert_estimate_to_invoice database functions, so an estimate written by
 * an agent, and the invoice a conversion produces, are indistinguishable from
 * the ones the UI writes. Totals go through the shared
 * round-once-at-storage math in src/lib/invoices/build.ts, the same module the
 * invoice tools use.
 */
export function registerEstimateTools(server: McpServer, ctx: McpCtx) {
  server.registerTool(
    'list_estimates',
    {
      title: 'List Estimates',
      description:
        'List estimates (quotes) for the caller\'s businesses, most recent first, optionally filtered by business, status, or client. Use this to answer "what quotes are outstanding". Estimates are NOT invoices and never carry a balance; use list_invoices for anything about money owed.',
      inputSchema: z.object({
        offset: z.number().int().min(0).max(1000000).optional().describe('Page offset. Start at 0, then use next_offset until it is null. Keep other filters unchanged.'),
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe('Id of the business whose estimates to list. Omit to list across every business in scope.'),
        status: z
          .enum(ESTIMATE_STATUSES)
          .optional()
          .describe(
            'Filter by status: draft, sent, viewed, accepted, declined, expired, or converted (already turned into an invoice).'
          ),
        client_id: z.string().uuid().optional().describe('Filter to estimates for this client only.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max estimates to return (default 20, max 100).'),
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
        .from('estimates')
        .select(
          'id, estimate_number, status, issue_date, expiry_date, total, currency, converted_invoice_id, client:clients(name)'
        )
        .in('business_id', ctx.db.scope.businessIds)
        .in('business_id', businessIds)
        .order('issue_date', { ascending: false })
        .order('id', { ascending: true })
        .range(offset ?? 0, (offset ?? 0) + resolvedLimit - 1)

      if (status) {
        query = query.eq('status', status)
      }
      if (client_id) {
        query = query.eq('client_id', client_id)
      }

      const { data, error } = await query

      if (error) {
        console.error('list_estimates:', error)
        return errorResult('Could not list estimates.')
      }

      const estimates = (data ?? []).map((est) => ({
        id: est.id,
        estimate_number: est.estimate_number,
        client_name: (est.client as { name: string } | null)?.name ?? null,
        status: est.status,
        issue_date: est.issue_date,
        expiry_date: est.expiry_date,
        currency: est.currency,
        total: est.total,
        converted_invoice_id: est.converted_invoice_id,
        app_url: `${appUrl()}/estimates/${est.id}`,
      }))

      const truncated = estimates.length === resolvedLimit
      const countLabel = `${estimates.length} estimate${estimates.length === 1 ? '' : 's'}`

      return jsonResult({
        offset: offset ?? 0,
        next_offset: (data ?? []).length === resolvedLimit ? (offset ?? 0) + resolvedLimit : null,
        summary: `${countLabel}${status ? ` with status "${status}"` : ''}${truncated ? truncationNote(resolvedLimit) : ''}`,
        estimates,
      })
    }
  )

  server.registerTool(
    'get_estimate',
    {
      title: 'Get Estimate',
      description:
        'Fetch one estimate in full: line items, totals, client, status, and the shareable link. Use it before update_draft_estimate or convert_estimate_to_invoice so you are editing the real current contents rather than assumed ones. It does not return payment or balance information, because an estimate is not an invoice; use get_payment_status for money owed.',
      inputSchema: z.object({
        estimate_id: z.string().uuid().describe('Id of the estimate to fetch (from list_estimates or create_estimate).'),
      }),
    },
    async ({ estimate_id }) => {
      let estimate
      try {
        estimate = await ctx.db.assertEstimateAccess(estimate_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access estimate.')
      }

      const [{ data: lineItems, error: lineItemsError }, { data: client }] = await Promise.all([
        ctx.db.svc
          .from('estimate_line_items')
          .select('description, quantity, rate, amount, sort_order')
          .eq('estimate_id', estimate_id)
          .order('sort_order', { ascending: true })
          .limit(500),
        ctx.db.svc
          .from('clients')
          .select('id, name, email')
          .eq('id', estimate.client_id)
          .eq('business_id', estimate.business_id)
          .maybeSingle(),
      ])

      if (lineItemsError) {
        console.error('get_estimate (line items):', lineItemsError)
        return errorResult('Could not load estimate line items.')
      }

      return jsonResult({
        summary: `${estimate.estimate_number} for ${client?.name ?? 'unknown client'}: ${formatCurrency(estimate.total, estimate.currency)} (${estimate.status})`,
        estimate: {
          id: estimate.id,
          business_id: estimate.business_id,
          client_id: estimate.client_id,
          client_name: client?.name ?? null,
          client_email: client?.email ?? null,
          estimate_number: estimate.estimate_number,
          status: estimate.status,
          issue_date: estimate.issue_date,
          expiry_date: estimate.expiry_date,
          currency: estimate.currency,
          subtotal: estimate.subtotal,
          discount_type: estimate.discount_type,
          discount_value: estimate.discount_value,
          discount_amount: estimate.discount_amount,
          tax_rate: estimate.tax_rate,
          tax_amount: estimate.tax_amount,
          shipping_amount: estimate.shipping_amount,
          total: estimate.total,
          notes: estimate.notes,
          terms: estimate.terms,
          converted_invoice_id: estimate.converted_invoice_id,
          line_items: (lineItems ?? []).map((li) => ({
            description: li.description,
            quantity: li.quantity,
            rate: li.rate,
            amount: li.amount,
          })),
        },
        public_url: estimatePublicUrl(estimate.public_id),
        app_url: `${appUrl()}/estimates/${estimate.id}`,
      })
    }
  )

  server.registerTool(
    'create_estimate',
    {
      title: 'Create Estimate',
      description:
        'Draft a new estimate (quote) for a client, identified by client_id or client_name. Use this when work has not been agreed yet and the client needs a price first. Always created as a draft: call send_estimate to deliver it, then convert_estimate_to_invoice once it is accepted. Do NOT use this for work already delivered; create_invoice is the right tool there.',
      inputSchema: z.object({
        request_id: z.uuid().describe('Stable request ID. Reuse with identical input on retries.'),
        business_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Id of the business to create the estimate under. Optional when the API key is scoped to exactly one business; required if scoped to multiple.'
          ),
        client_id: z.string().uuid().optional().describe('Id of the client. Provide this or client_name.'),
        client_name: z
          .string()
          .max(200)
          .optional()
          .describe('Exact (case-insensitive) client name. Provide this or client_id.'),
        line_items: z
          .array(lineItemInput)
          .min(1)
          .describe(
            'Estimate line items; at least one required. Each line is either written out (description + quantity + rate) or points at a saved item via item_id / item_name, which supplies the description and rate.'
          ),
        issue_date: DATE_FIELD.optional().describe('Issue date, YYYY-MM-DD. Defaults to today.'),
        expiry_date: DATE_FIELD.optional().describe(
          `Date the quote stops being valid, YYYY-MM-DD. Defaults to issue_date plus ${DEFAULT_EXPIRY_DAYS} days.`
        ),
        notes: z.string().max(2000).optional().describe('Notes shown on the estimate.'),
        terms: z.string().max(2000).optional().describe('Terms shown on the estimate, e.g. what the quote does not cover.'),
        ...discountFields,
      }),
    },
    async ({ request_id,
      business_id,
      client_id,
      client_name,
      line_items,
      issue_date,
      expiry_date,
      notes,
      terms,
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

      let resolvedLineItems
      try {
        resolvedLineItems = (await resolveLineItems(ctx, resolvedBusinessId, line_items)).resolved
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not resolve line items.')
      }

      const { data: business, error: businessError } = await ctx.db.svc
        .from('businesses')
        .select('*')
        .eq('id', resolvedBusinessId)
        .maybeSingle()

      if (businessError || !business) {
        console.error('create_estimate (business):', businessError)
        return errorResult('Could not load business.')
      }

      const totals = computeInvoiceTotals(resolvedLineItems, {
        discount_type,
        discount_value,
        tax_rate,
        shipping_amount,
      })

      const resolvedIssueDate = issue_date || todayISO()
      const resolvedExpiryDate =
        expiry_date || toISODate(addDays(parseDay(resolvedIssueDate), DEFAULT_EXPIRY_DAYS))

      // Currency follows the client, falling back to the business default,
      // the same rule createEstimateAction applies in the app.
      const estimateCurrency = client.currency || business.default_currency

      const {data:created,error:estimateError}=await ctx.db.svc.rpc('create_estimate_document',{p_business_id:resolvedBusinessId,p_client_id:client.id,p_request_id:request_id,p_key_id:ctx.keyId,p_patch:{issue_date:resolvedIssueDate,expiry_date:resolvedExpiryDate,discount_type,discount_value,tax_rate,shipping_amount,notes,terms},p_lines:resolvedLineItems.map(line=>({...line}))})
      if(estimateError||!created)return errorResult(estimateError?.message||'Could not create estimate')
      const estimate=created as Database['public']['Tables']['estimates']['Row']
      const estimateNumber=estimate.estimate_number

      return jsonResult({
        summary: `Drafted estimate ${estimateNumber} for ${client.name}: ${formatCurrency(totals.total, estimateCurrency)}`,
        estimate: {
          id: estimate.id,
          business_id: estimate.business_id,
          client_id: estimate.client_id,
          estimate_number: estimate.estimate_number,
          status: estimate.status,
          issue_date: estimate.issue_date,
          expiry_date: estimate.expiry_date,
          currency: estimate.currency,
          subtotal: estimate.subtotal,
          discount_amount: estimate.discount_amount,
          tax_amount: estimate.tax_amount,
          shipping_amount: estimate.shipping_amount,
          total: estimate.total,
          notes: estimate.notes,
          terms: estimate.terms,
          line_items: totals.line_items.map((item) => ({
            description: item.description,
            quantity: item.quantity,
            rate: item.rate,
            amount: item.amount,
          })),
        },
        public_url: estimatePublicUrl(estimate.public_id),
        app_url: `${appUrl()}/estimates/${estimate.id}`,
      })
    }
  )

  server.registerTool(
    'update_draft_estimate',
    {
      title: 'Update Draft Estimate',
      description:
        'Update a draft estimate: replace its line items and/or adjust dates, notes, terms, discount, tax, or shipping. Refuses to touch an estimate that has already been sent, accepted, declined, or converted, because the client has seen those numbers; create a new estimate instead.',
      inputSchema: z.object({
        estimate_id: z.string().uuid().describe('Id of the draft estimate to update.'),
        line_items: z
          .array(lineItemInput)
          .min(1)
          .optional()
          .describe(
            'If provided, replaces ALL existing line items and recomputes totals. Lines may reference saved items via item_id / item_name.'
          ),
        issue_date: DATE_FIELD.optional().describe('Replaces the issue date, YYYY-MM-DD.'),
        expiry_date: DATE_FIELD.optional().describe('Replaces the expiry date, YYYY-MM-DD.'),
        notes: z.string().max(2000).optional().describe('Replaces the notes field.'),
        terms: z.string().max(2000).optional().describe('Replaces the terms field.'),
        ...discountFields,
        discount_type: discountFields.discount_type.describe(
          'Discount type. If provided alone, the existing discount_value is reinterpreted under the new type (a stored fixed 50 discount becomes a 50% discount). Pass discount_value together with discount_type to set both explicitly.'
        ),
      }),
    },
    async ({
      estimate_id,
      line_items,
      issue_date,
      expiry_date,
      notes,
      terms,
      discount_type,
      discount_value,
      tax_rate,
      shipping_amount,
    }) => {
      let estimate
      try {
        estimate = await ctx.db.assertEstimateAccess(estimate_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access estimate.')
      }

      if (estimate.status !== 'draft') {
        return errorResult(
          `Estimate ${estimate.estimate_number} is "${estimate.status}", not "draft". Only draft estimates can be edited. Create a new estimate if the numbers need to change.`
        )
      }

      // Only read when the caller is NOT replacing the lines, because then the
      // stored lines are the input to the recomputed totals. When line_items IS
      // supplied the replacement happens inside replace_estimate_line_items and
      // there is nothing to restore, so the read is dead weight.
      let storedLineItems: { description: string; quantity: number; rate: number }[] = []
      if (!line_items) {
        const { data, error: storedError } = await ctx.db.svc
          .from('estimate_line_items')
          .select('description, quantity, rate, sort_order')
          .eq('estimate_id', estimate_id)
          .order('sort_order', { ascending: true })
          .limit(500)

        if (storedError) {
          console.error('update_draft_estimate (load line items):', storedError)
          return errorResult('Could not load existing line items.')
        }
        storedLineItems = data ?? []
      }

      let currentLineItems: { description: string; quantity: number; rate: number }[]
      if (line_items) {
        try {
          currentLineItems = (await resolveLineItems(ctx, estimate.business_id, line_items)).resolved
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
        discount_type: discount_type ?? (estimate.discount_type as 'percentage' | 'fixed'),
        discount_value: discount_value ?? estimate.discount_value,
        tax_rate: tax_rate ?? estimate.tax_rate,
        shipping_amount: shipping_amount ?? estimate.shipping_amount,
      })

      const patch = {
        issue_date: issue_date ?? estimate.issue_date,
        expiry_date: expiry_date ?? estimate.expiry_date,
        notes: notes ?? estimate.notes,
        terms: terms ?? estimate.terms,
        subtotal: totals.subtotal,
        discount_type: discount_type ?? estimate.discount_type,
        discount_value: discount_value ?? estimate.discount_value,
        discount_amount: totals.discount_amount,
        tax_rate: tax_rate ?? estimate.tax_rate,
        tax_amount: totals.tax_amount,
        shipping_amount: shipping_amount ?? estimate.shipping_amount,
        total: totals.total,
      }

      let updated: EstimateRow | null = null

      if (line_items) {
        // ONE TRANSACTION. replace_estimate_line_items does
        // the delete, the re-insert and the totals update together, so the
        // estimate can no longer be left showing a total with no lines under
        // it. The hand-rolled version this replaces deleted the old rows,
        // inserted the new ones, and on failure tried to re-insert the rows it
        // had just deleted; when that restore itself failed the tool had to
        // tell the caller the estimate was now empty and ask it to repair the
        // document by hand. That state is no longer reachable.
        const { data, error: replaceError } = await ctx.db.svc.rpc('replace_estimate_line_items', {
          p_estimate_id: estimate_id,
          p_line_items: totals.line_items.map((item) => ({
            description: item.description ?? '',
            quantity: item.quantity,
            rate: item.rate,
            amount: item.amount,
          })),
          p_estimate_patch: patch,
        })

        if (replaceError || !data) {
          console.error('update_draft_estimate (replace line items):', replaceError)
          if (replaceError?.message === 'invalid_line_items') {
            return errorResult(
              'Those line items were rejected; the estimate was left unchanged. Send between 1 and 500 lines and retry.'
            )
          }
          return errorResult('Could not update the estimate; it was left unchanged.')
        }

        updated = data as unknown as EstimateRow
      } else {
        const { data, error: updateError } = await ctx.db.svc
          .from('estimates')
          .update(patch)
          .eq('id', estimate_id)
          .select('*')
          .single()

        if (updateError || !data) {
          console.error('update_draft_estimate (update):', updateError)
          return errorResult('Could not update estimate.')
        }

        updated = data
      }

      return jsonResult({
        summary: `Updated draft estimate ${updated.estimate_number}: ${formatCurrency(totals.total, updated.currency)}`,
        estimate: {
          id: updated.id,
          estimate_number: updated.estimate_number,
          status: updated.status,
          issue_date: updated.issue_date,
          expiry_date: updated.expiry_date,
          currency: updated.currency,
          subtotal: updated.subtotal,
          discount_type: updated.discount_type,
          discount_value: updated.discount_value,
          discount_amount: updated.discount_amount,
          tax_rate: updated.tax_rate,
          tax_amount: updated.tax_amount,
          shipping_amount: updated.shipping_amount,
          total: updated.total,
          notes: updated.notes,
          terms: updated.terms,
          line_items: totals.line_items.map((item) => ({
            description: item.description,
            quantity: item.quantity,
            rate: item.rate,
            amount: item.amount,
          })),
        },
        public_url: estimatePublicUrl(updated.public_id),
        app_url: `${appUrl()}/estimates/${updated.id}`,
      })
    }
  )

  server.registerTool(
    'send_estimate',
    {
      title: 'Send Estimate',
      description:
        'Email an estimate to its client and advance a draft to "sent". Defaults the recipient to the client\'s own email. Use it once the quote is final; it does not create an invoice and takes no payment. Refuses estimates that were already converted to an invoice.',
      inputSchema: z.object({
        request_id: z.uuid().describe('Stable delivery ID. Reuse on retries with identical recipients and content.'),
        estimate_id: z.string().uuid().describe('Id of the estimate to send.'),
        to: z.string().email().optional().describe("Recipient email. Defaults to the estimate's client email."),
        cc: z.array(z.string().email()).max(10).optional().describe('Cc recipients, at most 10.'),
        bcc: z.array(z.string().email()).max(10).optional().describe('Bcc recipients, at most 10.'),
        subject: z
          .string()
          .max(200)
          .optional()
          .describe('Email subject. Defaults to "Estimate <number> from <business>".'),
        message: z.string().max(2000).optional().describe('Optional personal message shown above the quote summary.'),
      }),
    },
    async ({ request_id, estimate_id, to, cc, bcc, subject, message }) => {
      let estimate
      try {
        estimate = await ctx.db.assertEstimateAccess(estimate_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access estimate.')
      }

      if (estimate.status === 'converted') {
        return errorResult(
          `Estimate ${estimate.estimate_number} was already converted to an invoice. Send that invoice with send_invoice instead.`
        )
      }

      let recipient = to
      if (!recipient) {
        const { data: client, error: clientError } = await ctx.db.svc
          .from('clients')
          .select('email')
          .eq('id', estimate.client_id)
          .eq('business_id', estimate.business_id)
          .maybeSingle()

        if (clientError) {
          console.error('send_estimate (client lookup):', clientError)
          return errorResult('Could not look up client email.')
        }

        if (!client?.email) {
          return errorResult(
            `Estimate ${estimate.estimate_number}'s client has no email on file. Pass "to" explicitly.`
          )
        }

        recipient = client.email
      }

      try {
        const result = await sendEstimateEmail(ctx.db.svc, estimate_id, {
          requestId: request_id,
          to: recipient,
          cc,
          bcc,
          subject,
          message,
        })

        return jsonResult({
          summary: `Sent estimate ${estimate.estimate_number} to ${result.to}.`,
          to: result.to,
          public_url: estimatePublicUrl(estimate.public_id),
        })
      } catch (err) {
        if (err instanceof SendEstimateEmailError) {
          return errorResult(err.message)
        }
        console.error('send_estimate (send):', err)
        return errorResult('Could not send estimate.')
      }
    }
  )

  server.registerTool(
    'convert_estimate_to_invoice',
    {
      title: 'Convert Estimate to Invoice',
      description:
        'Turn an estimate into a draft invoice carrying the same line items, currency, notes, and terms, then mark the estimate "converted" and link the two. Use it once the client has agreed. It does NOT send the invoice; call send_invoice after. Refuses an estimate that was already converted, declined, or expired.',
      inputSchema: z.object({
        estimate_id: z.string().uuid().describe('Id of the estimate to convert.'),
        issue_date: DATE_FIELD.optional().describe('Invoice issue date, YYYY-MM-DD. Defaults to today.'),
        due_date: DATE_FIELD.optional().describe(
          "Invoice due date, YYYY-MM-DD. Defaults to issue_date plus the business's default payment terms."
        ),
      }),
    },
    async ({ estimate_id, issue_date, due_date }) => {
      let estimate
      try {
        estimate = await ctx.db.assertEstimateAccess(estimate_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access estimate.')
      }

      // Already converted before we even started: the caller is acting on stale
      // information, most often because an earlier call of its own succeeded
      // and it is retrying. Hand back the invoice that already exists instead
      // of failing, so a retry converges. See alreadyConvertedResult.
      if (estimate.status === 'converted' || estimate.converted_invoice_id) {
        if (estimate.converted_invoice_id) {
          try {
            const existing = await ctx.db.assertInvoiceAccess(estimate.converted_invoice_id)
            return await alreadyConvertedResult(ctx, estimate, existing)
          } catch {
            // Fall through to the refusal below: the link points at an invoice
            // this key cannot see or that no longer exists, so there is nothing
            // safe to return and nothing safe to create either.
          }
        }
        return errorResult(
          `Estimate ${estimate.estimate_number} was already converted to invoice ${estimate.converted_invoice_id ?? '(unknown)'}. Use get_invoice on that invoice rather than converting again.`
        )
      }
      if (estimate.status === 'declined' || estimate.status === 'expired') {
        return errorResult(
          `Estimate ${estimate.estimate_number} is "${estimate.status}". Create a fresh estimate and get it accepted before invoicing.`
        )
      }

      const [{ data: lineItems, error: lineItemsError }, { data: business, error: businessError }] =
        await Promise.all([
          ctx.db.svc
            .from('estimate_line_items')
            .select('description, quantity, rate, sort_order')
            .eq('estimate_id', estimate_id)
            .order('sort_order', { ascending: true })
            .limit(500),
          ctx.db.svc.from('businesses').select('*').eq('id', estimate.business_id).maybeSingle(),
        ])

      if (lineItemsError || businessError || !business) {
        console.error('convert_estimate_to_invoice (load):', lineItemsError ?? businessError)
        return errorResult('Could not load the estimate contents.')
      }

      if (!lineItems || lineItems.length === 0) {
        return errorResult(
          `Estimate ${estimate.estimate_number} has no line items, so there is nothing to invoice.`
        )
      }

      const totals = { ...computeInvoiceTotals(lineItems), subtotal: estimate.subtotal, total: estimate.total }

      const resolvedIssueDate = issue_date || todayISO()
      const resolvedDueDate =
        due_date || toISODate(addDays(parseDay(resolvedIssueDate), business.default_payment_terms))

      // ONE TRANSACTION, CLAIM FIRST. convert_estimate_to_invoice marks the estimate converted with a conditional UPDATE before
      // it writes anything, allocates the invoice number through
      // allocate_document_number, and inserts the invoice and its line items,
      // all in the same transaction.
      //
      // This replaces a read-then-write guard that two concurrent calls with
      // the same estimate_id could both pass, each then creating a real
      // invoice and consuming an invoice number. An agent retrying a timed-out
      // request was enough to bill a client twice.
      const { data: converted, error: convertError } = await ctx.db.svc.rpc(
        'convert_estimate_to_invoice',
        {
          p_estimate_id: estimate_id,
          p_public_id: generatePublicId(),
          p_issue_date: resolvedIssueDate,
          p_due_date: resolvedDueDate,
          p_line_items: totals.line_items.map((item) => ({
            description: item.description ?? '',
            quantity: item.quantity,
            rate: item.rate,
            amount: item.amount,
          })),
          p_subtotal: totals.subtotal,
          p_total: totals.total,
          p_created_via: 'agent',
          p_created_by_key_id: ctx.keyId,
        }
      )

      if (convertError || !converted) {
        console.error('convert_estimate_to_invoice (rpc):', convertError)
        const code = convertError?.message ?? ''
        if (code === 'estimate_not_found') {
          return errorResult('Estimate not found')
        }
        if (code === 'estimate_not_convertible') {
          return errorResult(
            `Estimate ${estimate.estimate_number} is "${estimate.status}". Create a fresh estimate and get it accepted before invoicing.`
          )
        }
        return errorResult('Could not convert the estimate; nothing was created.')
      }

      const result = converted as unknown as ConversionResult

      // LOSER OF THE RACE. Another call claimed the estimate between our read
      // and our claim, so this call wrote nothing at all: no invoice, no line
      // items, no invoice number consumed. Report the winner's invoice as a
      // success. Failing here would tell a retrying agent that work it in fact
      // completed had failed, which is how the duplicate invoices got created
      // in the first place.
      if (!result.claimed) {
        if (result.invoice) {
          return await alreadyConvertedResult(ctx, estimate, result.invoice)
        }
        return errorResult(
          `Estimate ${estimate.estimate_number} was converted by another request that is still in flight. Call get_estimate to find the invoice it created, and do not convert again.`
        )
      }

      const invoice = result.invoice
      if (!invoice) {
        console.error('convert_estimate_to_invoice (rpc): claimed with no invoice')
        return errorResult('Could not convert the estimate; nothing was created.')
      }

      const notAcceptedNote =
        estimate.status === 'accepted' ? '' : ` (estimate was "${estimate.status}", not formally accepted)`

      return jsonResult({
        summary: `Converted estimate ${estimate.estimate_number} into draft invoice ${invoice.invoice_number}: ${formatCurrency(invoice.total, invoice.currency)}${notAcceptedNote}. Call send_invoice to deliver it.`,
        already_converted: false,
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
          total: invoice.total,
          balance_due: invoice.balance_due,
          line_items: totals.line_items.map((item) => ({
            description: item.description,
            quantity: item.quantity,
            rate: item.rate,
            amount: item.amount,
          })),
        },
        estimate: {
          id: estimate.id,
          estimate_number: estimate.estimate_number,
          status: 'converted',
          converted_invoice_id: invoice.id,
        },
        pdf_url: pdfUrl(invoice.public_id),
        app_url: `${appUrl()}/invoices/${invoice.id}`,
      })
    }
  )
}
