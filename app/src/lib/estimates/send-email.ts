import 'server-only'
import { prepareDelivery, finishDelivery } from '@/lib/email/delivery'
import { EmailQuotaError } from '@/lib/email/quota'
import { Resend } from 'resend'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { appUrl } from '@/lib/mcp/shared'
import { parseDay } from '@/lib/dates'
import { formatFromAddress, invoiceFromEmail } from '@/lib/email/from'
import { safeSubject } from '@/lib/email/subject'

/**
 * Shared estimate-email sending logic, modelled directly on
 * src/lib/invoices/send-email.ts (same From/reply-to handling, same escaping
 * rules, same "only move draft forward" status advance).
 *
 * Difference from the invoice version: there is no estimate PDF renderer in
 * this codebase (src/lib/pdf only has invoice-pdf.tsx), so the estimate email
 * carries the line items inline plus a link to the public estimate page where
 * the client can accept or decline. Nothing is faked: if Resend is not
 * configured the call fails loudly rather than reporting a send that did not
 * happen.
 *
 * DB CONTRACT (read before calling): `db` is used for BOTH the estimate fetch
 * and the status update, and this function performs NO authorization check of
 * its own. A caller passing the service-role client (the MCP tool) MUST have
 * called ctx.db.assertEstimateAccess(estimateId) first, since the service
 * client bypasses RLS entirely.
 */

export type SendEstimateEmailErrorCode =
  | 'not_configured'
  | 'estimate_not_found'
  | 'send_failed'
  /** The business has spent its daily outbound email allowance. */
  | 'quota_exceeded'

export class SendEstimateEmailError extends Error {
  code: SendEstimateEmailErrorCode
  constructor(code: SendEstimateEmailErrorCode, message: string) {
    super(message)
    this.name = 'SendEstimateEmailError'
    this.code = code
  }
}

export interface SendEstimateEmailOptions {
  requestId: string
  to: string
  cc?: string[]
  bcc?: string[]
  subject?: string
  message?: string
}

export interface SendEstimateEmailResult {
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

export async function sendEstimateEmail(
  db: SupabaseClient<Database>,
  estimateId: string,
  opts: SendEstimateEmailOptions,
): Promise<SendEstimateEmailResult> {
  if (!process.env.RESEND_API_KEY) {
    throw new SendEstimateEmailError(
      'not_configured',
      'Email is not configured (missing RESEND_API_KEY)',
    )
  }

  const to = opts.to.trim()
  const cc = opts.cc ?? []
  const bcc = opts.bcc ?? []

  const { data: estimate, error } = await db
    .from('estimates')
    .select(
      `*, client:clients(*), line_items:estimate_line_items(*), business:businesses(*)`,
    )
    .eq('id', estimateId)
    .single()

  if (error || !estimate) {
    throw new SendEstimateEmailError('estimate_not_found', 'Estimate not found')
  }

  if (['declined', 'expired', 'converted'].includes(estimate.status))
    throw new SendEstimateEmailError(
      'send_failed',
      'This estimate cannot be sent in its current status',
    )
  const business =
    estimate.business_snapshot && typeof estimate.business_snapshot === 'object'
      ? ({
          ...estimate.business,
          ...estimate.business_snapshot,
        } as typeof estimate.business)
      : estimate.business
  const publicEstimateUrl = `${appUrl()}/e/${estimate.public_id}`
  // Client-facing mail sends from RESEND_INVOICE_FROM. See src/lib/email/from.ts.
  const from = formatFromAddress(
    safeDisplayName(business?.name || 'Billr') || 'Billr',
    invoiceFromEmail(),
  )
  // Header sanitised at the point the subject is built, not at the transport.
  const subject = safeSubject(
    opts.subject,
    `Estimate ${estimate.estimate_number} from ${business?.name || 'Billr'}`,
  )

  const lineRows = (estimate.line_items || [])
    .sort(
      (a: { sort_order: number }, b: { sort_order: number }) =>
        a.sort_order - b.sort_order,
    )
    .map(
      (li: { description: string; amount: number }) => `
          <tr>
            <td style="padding:8px 0;border-bottom:1px solid #eee;">${escapeHtml(li.description)}</td>
            <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${formatCurrency(li.amount, estimate.currency)}</td>
          </tr>`,
    )
    .join('')

  const messageBlock = opts.message
    ? `<p style="margin:0 0 24px;white-space:pre-wrap;">${escapeHtml(opts.message)}</p>`
    : ''

  const expiryBlock = estimate.expiry_date
    ? `<p style="margin:8px 0 0;color:#666;font-size:13px;">Valid until ${formatDate(estimate.expiry_date)}</p>`
    : ''

  const html = `
    <div style="background:#f6f7f9;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
      <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;">
        <h2 style="margin:0 0 4px;font-size:20px;">${escapeHtml(business?.name || '')}</h2>
        <p style="margin:0 0 24px;color:#666;">Estimate ${escapeHtml(estimate.estimate_number)}</p>
        ${messageBlock}
        <div style="background:#f6f7f9;border-radius:8px;padding:20px;margin-bottom:24px;">
          <p style="margin:0;color:#666;font-size:13px;">Estimated total</p>
          <p style="margin:4px 0 0;font-size:28px;font-weight:700;">${formatCurrency(estimate.total, estimate.currency)}</p>
          ${expiryBlock}
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px;">${lineRows}</table>
        <a href="${publicEstimateUrl}" style="display:block;background:${safeHexColor(business?.primary_color)};color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:8px;font-weight:600;">Review estimate</a>
        <p style="margin:24px 0 0;color:#999;font-size:12px;text-align:center;">Sent via <a href="${appUrl()}" style="color:#999;">Billr</a></p>
      </div>
    </div>`

  const resend = new Resend(process.env.RESEND_API_KEY)
  const payload = {
    from,
    to,
    cc: cc.length ? cc : undefined,
    bcc: bcc.length ? bcc : undefined,
    replyTo: business?.email || undefined,
    subject,
    html,
  }
  // The daily send quota lives in prepareDelivery so both surfaces are
  // covered by one check. Re-thrown as a typed error here because the MCP
  // send tool only passes through this class; a bare Error would reach the
  // agent as a generic "could not send" with no way to tell it to wait.
  let delivery
  try {
    delivery = await prepareDelivery(
      db,
      estimate.business_id,
      estimateId,
      'estimate',
      opts.requestId,
      {
        to,
        cc,
        bcc,
        subject,
        message: opts.message || '',
        document_id: estimateId,
      },
      payload,
    )
  } catch (err) {
    if (err instanceof EmailQuotaError) throw new SendEstimateEmailError('quota_exceeded', err.message)
    throw err
  }
  if (delivery.alreadySent) return { sent: true, to }
  const { error: sendError } = await resend.emails.send(delivery.payload, {
    idempotencyKey: delivery.key,
  })

  if (sendError) {
    throw new SendEstimateEmailError(
      'send_failed',
      `Failed to send email: ${sendError.message}`,
    )
  }

  const { error: statusError } = await db
    .from('estimates')
    .update({ status: 'sent' })
    .eq('id', estimateId)
    .eq('status', 'draft')
  if (statusError)
    throw new Error(
      'Email accepted, but status could not be saved. Retry with the same request ID.',
    )
  await finishDelivery(db, estimate.business_id, opts.requestId)

  return { sent: true, to }
}
