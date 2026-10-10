import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { RATE_LIMITS, clientIpFrom, consumeRateLimits, ipKey, rateLimitKey } from '@/lib/rate-limit'
import { buildInvoicePdfData, renderInvoicePdf } from '@/lib/pdf/invoice-pdf'
import { stripePaymentsConfigured } from '@/lib/stripe/config'

export const runtime = 'nodejs'

// Public download keyed on unguessable public_id, via the SECURITY DEFINER RPC
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ publicId: string }> }
) {
  const { publicId } = await params

  // Unauthenticated and expensive: every hit renders a PDF. Limited per
  // document and per IP against the durable store, so
  // neither one link nor one source can turn this into a CPU sink. The per-IP
  // key ignores the spoofable first x-forwarded-for entry. Fails closed.
  const limited = await consumeRateLimits([
    { bucket: rateLimitKey('pdf:invoice', publicId), policy: RATE_LIMITS.publicDocument },
    { bucket: ipKey('pdf:invoice:ip', clientIpFrom(req.headers)), policy: RATE_LIMITS.publicDocumentIp },
  ])
  if (!limited.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait a moment and try again.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfterSeconds) } }
    )
  }

  const supabase = await createClient()

  const { data, error } = await supabase.rpc('get_public_invoice', {
    p_public_id: publicId,
  })

  const payload = data as { invoice: Record<string, unknown>; line_items: Record<string, unknown>[] } | null
  if (error || !payload?.invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  const invoice = payload.invoice
  const business = invoice.business_snapshot as Record<string, unknown> | null
  const client = invoice.client_snapshot as Record<string, unknown> | null

  const pdfData = buildInvoicePdfData(
    invoice,
    payload.line_items,
    business,
    client,
    stripePaymentsConfigured()
  )
  const pdf = await renderInvoicePdf(pdfData, business?.logo_url as string | undefined)

  // Sanitize for the Content-Disposition header: strip anything outside a safe
  // filename charset (and any CR/LF) to prevent header injection.
  const safeName = String(invoice.invoice_number).replace(/[^A-Za-z0-9._-]/g, '_') || 'invoice'

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeName}.pdf"`,
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
  })
}
