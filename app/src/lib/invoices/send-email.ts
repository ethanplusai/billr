import 'server-only'
import { prepareDelivery, finishDelivery } from '@/lib/email/delivery'
import { EmailQuotaError } from '@/lib/email/quota'
import { Resend } from 'resend'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { buildInvoicePdfData, renderInvoicePdf } from '@/lib/pdf/invoice-pdf'
import { stripePaymentsConfigured } from '@/lib/stripe/config'
import { appUrl } from '@/lib/mcp/shared'
import { parseDay } from '@/lib/dates'
import { formatFromAddress, invoiceFromEmail } from '@/lib/email/from'
import { safeSubject } from '@/lib/email/subject'

/**
 * Shared invoice-email sending logic. Extracted from the web "Send Invoice"
 * server action (src/lib/actions/send-invoice.ts) so it can also be used by
 * the send_invoice MCP tool (src/lib/mcp/tools/invoices-send.ts). Contains
 * everything between "fetch the invoice" and "advance its status": the
 * relation fetch, HTML email body, PDF attachment (via renderInvoicePdf),
 * the Resend send, and the draft→sent status advance + last_sent_at bump.
 *
 * DB CONTRACT (read before calling): the `db` param is used for BOTH the
 * invoice fetch and the final status update, and this function does NOT
 * perform its own authorization/scoping check; it trusts that the caller
 * has already verified access to `invoiceId` via whatever client it hands
 * in.
 *   - The web action passes its cookie-authed client (`createClient()` from
 *     '@/lib/supabase/server'); RLS naturally scopes the invoice fetch to
 *     the signed-in user, so no extra check is needed there.
 *   - The MCP tool MUST pass `ctx.db.svc` (the service-role client) ONLY
 *     AFTER calling `ctx.db.assertInvoiceAccess(invoiceId)` itself. Passing
 *     `ctx.db.svc` without that prior check would let the caller send an
 *     email for (and mutate the status of) an invoice outside their API-key
 *     scope, since the service-role client bypasses RLS entirely.
 *
 * INPUT CONTRACT: `opts.to`/`opts.cc`/`opts.bcc` are assumed to already be
 * validated, trimmed email addresses; this function does not itself
 * re-validate email formatting or check RESEND_API_KEY presence beyond the
 * guard below; callers are expected to have done their own option parsing
 * (the web action via its EMAIL_RE checks, the MCP tool via its Zod schema)
 * before calling in.
 */

export type SendInvoiceEmailErrorCode =
  | 'not_configured'
  | 'invoice_not_found'
  | 'send_failed'
  /** The business has spent its daily outbound email allowance. */
  | 'quota_exceeded'

export class SendInvoiceEmailError extends Error {
  code: SendInvoiceEmailErrorCode
  constructor(code: SendInvoiceEmailErrorCode, message: string) {
    super(message)
    this.name = 'SendInvoiceEmailError'
    this.code = code
  }
}

export interface SendInvoiceEmailOptions {
  requestId: string
  to: string
  cc?: string[]
  bcc?: string[]
  subject?: string
  message?: string
}

export interface SendInvoiceEmailResult {
  sent: true
  to: string
}

const formatCurrency = (amount: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)

const formatDate = (date: string) =>
  parseDay(date).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// business.primary_color is user-controlled and interpolated into a style
// attribute; only allow a strict hex color, else fall back to the brand blue.
const safeHexColor = (c: string | null | undefined) =>
  typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#2563eb'

// The From display name lands in an email header: strip CR/LF (header
// injection) and angle brackets (which delimit the address).
const safeDisplayName = (s: string) => s.replace(/[\r\n<>]/g, '').trim()

export async function sendInvoiceEmail(
  db: SupabaseClient<Database>,
  invoiceId: string,
  opts: SendInvoiceEmailOptions,
): Promise<SendInvoiceEmailResult> {
  if (!process.env.RESEND_API_KEY) {
    throw new SendInvoiceEmailError(
      'not_configured',
      'Email is not configured (missing RESEND_API_KEY)',
    )
  }

  const to = opts.to.trim()
  const cc = opts.cc ?? []
  const bcc = opts.bcc ?? []

  const { data: invoice, error } = await db
    .from('invoices')
    .select(
      `*, client:clients(*), line_items:invoice_line_items(*), business:businesses(*)`,
    )
    .eq('id', invoiceId)
    .single()

  if (error || !invoice) {
    throw new SendInvoiceEmailError('invoice_not_found', 'Invoice not found')
  }

  if (invoice.status === 'cancelled')
    throw new SendInvoiceEmailError(
      'send_failed',
      'Cancelled documents cannot be sent',
    )
  const business =
    invoice.business_snapshot && typeof invoice.business_snapshot === 'object'
      ? ({
          ...invoice.business,
          ...invoice.business_snapshot,
        } as typeof invoice.business)
      : invoice.business
  const publicUrl = `${appUrl()}/i/${invoice.public_id}`
  const paymentsEnabled = stripePaymentsConfigured()
  const from = formatFromAddress(
    safeDisplayName(business?.name || 'Billr') || 'Billr',
    invoiceFromEmail(),
  )
  const amountDue = invoice.balance_due ?? invoice.total
  // Header sanitised at the point the subject is built, not at the transport.
  const subject = safeSubject(
    opts.subject,
    `Invoice ${invoice.invoice_number} from ${business?.name || 'Billr'}`,
  )

  const lineRows = (invoice.line_items || [])
    .sort(
      (a: { sort_order: number }, b: { sort_order: number }) =>
        a.sort_order - b.sort_order,
    )
    .map(
      (li: { description: string; amount: number }) => `
          <tr>
            <td style="padding:8px 0;border-bottom:1px solid #eee;">${escapeHtml(li.description)}</td>
            <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${formatCurrency(li.amount, invoice.currency)}</td>
          </tr>`,
    )
    .join('')

  const messageBlock = opts.message
    ? `<p style="margin:0 0 24px;white-space:pre-wrap;">${escapeHtml(opts.message)}</p>`
    : ''

  const html = `
    <div style="background:#f6f7f9;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
      <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;">
        <h2 style="margin:0 0 4px;font-size:20px;">${escapeHtml(business?.name || '')}</h2>
        <p style="margin:0 0 24px;color:#666;">Invoice ${escapeHtml(invoice.invoice_number)}</p>
        ${messageBlock}
        <div style="background:#f6f7f9;border-radius:8px;padding:20px;margin-bottom:24px;">
          <p style="margin:0;color:#666;font-size:13px;">Amount due</p>
          <p style="margin:4px 0 0;font-size:28px;font-weight:700;">${formatCurrency(amountDue, invoice.currency)}</p>
          <p style="margin:8px 0 0;color:#666;font-size:13px;">Due ${formatDate(invoice.due_date)}</p>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px;">${lineRows}</table>
        ${
          paymentsEnabled
            ? `<a href="${publicUrl}" style="display:block;background:${safeHexColor(business?.primary_color)};color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:8px;font-weight:600;margin-bottom:12px;">Pay online</a>
        <a href="${publicUrl}" style="display:block;background:#fff;color:${safeHexColor(business?.primary_color)};text-decoration:none;text-align:center;padding:12px;border-radius:8px;font-weight:600;border:1px solid #e5e5e5;">View Invoice</a>`
            : `<a href="${publicUrl}" style="display:block;background:${safeHexColor(business?.primary_color)};color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:8px;font-weight:600;">View Invoice</a>`
        }
        <p style="margin:24px 0 0;color:#999;font-size:12px;text-align:center;">Sent via <a href="${appUrl()}" style="color:#999;">Billr</a></p>
      </div>
    </div>`

  // Attach the same PDF served by the download buttons
  const pdf = await renderInvoicePdf(
    buildInvoicePdfData(
      invoice,
      invoice.line_items,
      business,
      invoice.client,
      paymentsEnabled,
    ),
    business?.logo_url,
  )

  const resend = new Resend(process.env.RESEND_API_KEY)
  const payload = {
    from,
    to,
    cc: cc.length ? cc : undefined,
    bcc: bcc.length ? bcc : undefined,
    replyTo: business?.email || undefined,
    subject,
    html,
    attachments: [
      {
        filename: `${invoice.invoice_number}.pdf`,
        content: pdf.toString('base64'),
      },
    ],
  }
  // The daily send quota lives in prepareDelivery so both surfaces are
  // covered by one check. Re-thrown as a typed error here because the MCP
  // send tool only passes through this class; a bare Error would reach the
  // agent as a generic "could not send" with no way to tell it to wait.
  let delivery
  try {
    delivery = await prepareDelivery(
      db,
      invoice.business_id,
      invoiceId,
      'invoice',
      opts.requestId,
      {
        to,
        cc,
        bcc,
        subject,
        message: opts.message || '',
        document_id: invoiceId,
      },
      payload,
    )
  } catch (err) {
    if (err instanceof EmailQuotaError) throw new SendInvoiceEmailError('quota_exceeded', err.message)
    throw err
  }
  if (delivery.alreadySent) return { sent: true, to }
  const { error: sendError } = await resend.emails.send(delivery.payload, {
    idempotencyKey: delivery.key,
  })

  if (sendError) {
    throw new SendInvoiceEmailError(
      'send_failed',
      `Failed to send email: ${sendError.message}`,
    )
  }

  const { error: stampError } = await db
    .from('invoices')
    .update({ last_sent_at: new Date().toISOString() })
    .eq('id', invoiceId)
  if (stampError)
    throw new Error(
      'Email accepted, but status could not be saved. Retry with the same request ID.',
    )
  const { error: statusError } = await db
    .from('invoices')
    .update({ status: 'sent' })
    .eq('id', invoiceId)
    .eq('status', 'draft')
  if (statusError)
    throw new Error(
      'Email accepted, but status could not be saved. Retry with the same request ID.',
    )
  await finishDelivery(db, invoice.business_id, opts.requestId)

  return { sent: true, to }
}
