import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { McpCtx } from '@/lib/mcp/context'
import { ScopeError } from '@/lib/mcp/scoped-db'
import { sendInvoiceEmail, SendInvoiceEmailError } from '@/lib/invoices/send-email'
import { errorResult, jsonResult, formatCurrency, publicUrl } from '@/lib/mcp/shared'
import { todayISO } from '@/lib/dates'

const DATE_FIELD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

const PAYMENT_METHODS = ['cash', 'check', 'bank_transfer', 'credit_card', 'stripe', 'paypal', 'other'] as const

/**
 * Registers the invoice send/payment tools (send_invoice, record_payment) on
 * the given MCP server, scoped to the businesses in ctx.db.scope.
 */
export function registerInvoiceSendTools(server: McpServer, ctx: McpCtx) {
  server.registerTool(
    'send_invoice',
    {
      title: 'Send Invoice',
      description:
        'Email an invoice (with PDF attached) to its client, advancing a draft to "sent"; defaults the recipient to the client\'s own email if `to` is omitted. Refuses to send invoices that are already paid or cancelled.',
      inputSchema: z.object({
        request_id: z.uuid().describe('Stable delivery ID. Reuse on retries with identical recipients and content.'),
        invoice_id: z.string().uuid().describe('Id of the invoice to send.'),
        to: z
          .string()
          .email()
          .optional()
          .describe("Recipient email. Defaults to the invoice's client email if omitted."),
        cc: z
          .array(z.string().email())
          .max(10)
          .optional()
          .describe('Cc recipients. At most 10; split larger sends across multiple calls.'),
        bcc: z
          .array(z.string().email())
          .max(10)
          .optional()
          .describe('Bcc recipients. At most 10; split larger sends across multiple calls.'),
        subject: z.string().max(200).optional().describe('Email subject. Defaults to "Invoice <number> from <business>".'),
        message: z.string().max(2000).optional().describe('Optional personal message included above the invoice summary.'),
      }),
    },
    async ({ request_id, invoice_id, to, cc, bcc, subject, message }) => {
      let invoice
      try {
        invoice = await ctx.db.assertInvoiceAccess(invoice_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access invoice.')
      }

      if (invoice.status === 'paid') {
        return errorResult(
          `Invoice ${invoice.invoice_number} is already paid. There is nothing to send.`
        )
      }
      if (invoice.status === 'cancelled') {
        return errorResult(
          `Invoice ${invoice.invoice_number} is cancelled. Cancelled invoices cannot be sent.`
        )
      }

      let recipient = to
      if (!recipient) {
        const { data: client, error: clientError } = await ctx.db.svc
          .from('clients')
          .select('email')
          .eq('id', invoice.client_id)
          .eq('business_id', invoice.business_id)
          .maybeSingle()

        if (clientError) {
          console.error('send_invoice (client lookup):', clientError)
          return errorResult('Could not look up client email.')
        }

        if (!client?.email) {
          return errorResult(
            `Invoice ${invoice.invoice_number}'s client has no email on file. Pass "to" explicitly.`
          )
        }

        recipient = client.email
      }

      try {
        const result = await sendInvoiceEmail(ctx.db.svc, invoice_id, {
          requestId: request_id,
          to: recipient,
          cc,
          bcc,
          subject,
          message,
        })

        const resultBody = {
          summary: `Sent ${invoice.invoice_number} to ${result.to} with PDF attached.`,
          to: result.to,
          public_url: publicUrl(invoice.public_id),
        }

        return jsonResult(resultBody)
      } catch (err) {
        if (err instanceof SendInvoiceEmailError) {
          return errorResult(err.message)
        }
        console.error('send_invoice (send):', err)
        return errorResult('Could not send invoice.')
      }
    }
  )

  server.registerTool(
    'record_payment',
    {
      title: 'Record Payment',
      description:
        "Record a payment received against an invoice, updating the invoice's amount_paid/balance_due and status (\"paid\" once the balance reaches zero, \"partial\" otherwise). Mirrors the app's own Record Payment flow.",
      inputSchema: z.object({
        request_id: z.uuid().describe('Stable payment ID; reuse with identical input on retries.'),
        invoice_id: z.string().uuid().describe('Id of the invoice the payment applies to.'),
        amount: z.number().positive().describe('Payment amount received (must be > 0).'),
        payment_date: DATE_FIELD.optional().describe('Date the payment was received, YYYY-MM-DD. Defaults to today.'),
        method: z
          .enum(PAYMENT_METHODS)
          .optional()
          .describe('Payment method. Defaults to "other".'),
        notes: z.string().max(2000).optional().describe('Optional notes about the payment.'),
        reference_number: z.string().max(100).optional().describe('Optional reference/check/transaction number.'),
      }),
    },
    async ({ request_id, invoice_id, amount, payment_date, method, notes, reference_number }) => {
      let invoice
      try {
        invoice = await ctx.db.assertInvoiceAccess(invoice_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access invoice.')
      }

      if (invoice.status === 'cancelled') {
        return errorResult(
          `Invoice ${invoice.invoice_number} is cancelled. Payments cannot be recorded against it.`
        )
      }

      const resolvedPaymentDate = payment_date || todayISO()

      // One transaction. record_invoice_payment inserts the
      // ledger row and recomputes the invoice from SUM(payments), so there is
      // no longer a window in which the payment exists but the invoice still
      // reads unpaid, and the arithmetic is absolute rather than delta-based.
      const { data: recorded, error: recordError } = await ctx.db.svc.rpc('record_payment_once', {
        p_request_id: request_id,
        p_invoice_id: invoice_id,
        p_amount: amount,
        p_payment_date: resolvedPaymentDate,
        p_payment_method: method ?? 'other',
        p_reference_number: reference_number || undefined,
        p_notes: notes || undefined,
        p_created_via: 'agent',
        p_created_by_key_id: ctx.keyId,
      })

      if (recordError || !recorded) {
        console.error('record_payment (rpc):', recordError)
        return errorResult('Could not record payment.')
      }

      const updated = (recorded as { invoice: { status: string; amount_paid: number; balance_due: number } })
        .invoice

      const result = {
        summary: `Recorded ${formatCurrency(amount, invoice.currency)} payment on ${invoice.invoice_number}. It is now ${updated.status} with ${formatCurrency(updated.balance_due, invoice.currency)} balance due.`,
        invoice: {
          status: updated.status,
          amount_paid: updated.amount_paid,
          balance_due: updated.balance_due,
        },
      }

      return jsonResult(result)
    }
  )
}
