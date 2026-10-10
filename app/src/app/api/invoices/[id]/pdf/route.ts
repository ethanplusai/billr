import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildInvoicePdfData, renderInvoicePdf } from '@/lib/pdf/invoice-pdf'
import { stripePaymentsConfigured } from '@/lib/stripe/config'

export const runtime = 'nodejs'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  // RLS scopes this to invoices the signed-in user can access
  const { data: invoice, error } = await supabase
    .from('invoices')
    .select(
      `*, client:clients(*), line_items:invoice_line_items(*), business:businesses(*)`
    )
    .eq('id', id)
    .single()

  if (error || !invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  const data = buildInvoicePdfData(
    invoice,
    invoice.line_items,
    invoice.business,
    invoice.client,
    stripePaymentsConfigured()
  )
  const pdf = await renderInvoicePdf(data, invoice.business?.logo_url)

  // Sanitize for the Content-Disposition header: strip anything outside a safe
  // filename charset (and any CR/LF) to prevent header injection.
  const safeName = String(invoice.invoice_number).replace(/[^A-Za-z0-9._-]/g, '_') || 'invoice'

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeName}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
