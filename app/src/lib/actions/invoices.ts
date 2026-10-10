'use server'

import { calculateLineItemAmount, calculateInvoiceTotals } from '@/lib/utils/invoice'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import type { Database } from '@/types/database'
import type { InvoiceStatus } from '@/types'
import { invoiceSchema } from '@/lib/validations/invoice'
import type { InvoiceFormData } from '@/lib/validations/invoice'
import { engagementErrorMessage } from '@/lib/engagements/errors'

/**
 * Creates an invoice.
 *
 * engagementEntryIds bills schedule entries off an engagement. The lines for them are built in SQL from the entry's own amount and
 * the entry is claimed as invoiced in the SAME transaction, so an invoice that
 * exists always has its entries marked billed and an entry can never end up on
 * two invoices. Nothing is claimed if any part of the call is refused.
 */
export async function createInvoiceAction(
  businessId: string,
  input: InvoiceFormData,
  _status: 'draft' | 'sent' = 'draft',
  requestId: string,
  engagementEntryIds: string[] = []
) {
  const data = invoiceSchema.parse(input)
  const supabase = await createClient()
  const { data: invoice, error } = await supabase.rpc('create_invoice_document', {
    p_business_id: businessId, p_client_id: data.client_id,
    p_request_id: requestId,
    p_patch: { ...data, line_items: undefined },
    // An invoice billed purely from engagement entries has no written out
    // lines at all; the RPC builds them and then insists on at least one.
    p_lines: data.line_items,
    p_engagement_entry_ids: engagementEntryIds,
  })
  if (error || !invoice) {
    // Engagement refusals carry a stable code. Map it to the sentence a person
    // and an agent are both told, rather than relaying a Postgres error.
    throw new Error(
      engagementErrorMessage(error?.message) || error?.message || 'Could not create invoice'
    )
  }
  revalidatePath('/invoices')
  revalidatePath('/dashboard')
  revalidatePath('/engagements')
  return invoice as unknown as Database['public']['Tables']['invoices']['Row']
}

/**
 * Saves an edited invoice.
 *
 * The whole save is one call to replace_invoice_line_items,
 * which runs the delete, the re-insert and the totals update in a single
 * transaction. Before this it was three unchecked round trips: if the re-insert
 * failed, the invoice was left with no line items at all while still showing a
 * total, and none of the three results were even inspected.
 *
 * balance_due is no longer passed. The RPC derives it as total - amount_paid,
 * so editing a partly paid invoice cannot wipe the payments recorded against it.
 */
export async function updateInvoiceAction(
  invoiceId: string,
  input: InvoiceFormData
) {
  const supabase = await createClient()

  const data = invoiceSchema.parse(input)
  data.line_items=data.line_items.map(calculateLineItemAmount)
  Object.assign(data,calculateInvoiceTotals(data.line_items,data.discount_type,data.discount_value,data.tax_rate,data.shipping_amount))
  const { data: invoice, error } = await supabase.rpc('replace_invoice_line_items', {
    p_invoice_id: invoiceId,
    p_line_items: data.line_items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      rate: item.rate,
      amount: item.amount,
      tax_rate: item.tax_rate,
      tax_amount: item.tax_amount,
      discount_percent: item.discount_percent,
      discount_amount: item.discount_amount,
    })),
    p_invoice_patch: {
      client_id: data.client_id,
      invoice_number: data.invoice_number,
      issue_date: data.issue_date,
      due_date: data.due_date,
      currency: data.currency,
      po_number: data.po_number || null,
      subtotal: data.subtotal,
      discount_type: data.discount_type,
      discount_value: data.discount_value,
      discount_amount: data.discount_amount,
      tax_rate: data.tax_rate,
      tax_amount: data.tax_amount,
      shipping_amount: data.shipping_amount,
      total: data.total,
      notes: data.notes || null,
      terms: data.terms || null,
      footer: data.footer || null,
      payment_instructions: data.payment_instructions || null,
      is_recurring: data.is_recurring,
      recurring_interval: data.recurring_interval || null,
      recurring_end_date: data.recurring_end_date || null,
    },
  })

  if (error) {
    throw new Error(error.message)
  }

  revalidatePath('/invoices')
  revalidatePath(`/invoices/${invoiceId}`)
  return invoice
}

export async function deleteInvoiceAction(invoiceId: string) {
  const supabase = await createClient()

  // Only allow deleting draft invoices
  const { data: invoice } = await supabase
    .from('invoices')
    .select('status')
    .eq('id', invoiceId)
    .single()

  if (invoice?.status !== 'draft') {
    throw new Error('Only draft invoices can be deleted')
  }

  const { error } = await supabase
    .from('invoices')
    .delete()
    .eq('id', invoiceId)

  if (error) {
    throw new Error(error.message)
  }

  revalidatePath('/invoices')
}

/**
 * Marks a draft invoice as sent without emailing it, for an owner who
 * delivers the public link or the PDF themselves (or has no email set up).
 * A draft has no public page and does not count towards client totals; a
 * sent invoice does. Only a draft moves, and RLS limits it to members. For an
 * invoice already past draft it changes nothing and returns the current
 * status, so a repeat click is a quiet no-op.
 */
export async function markInvoiceSentAction(invoiceId: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('invoices')
    .update({ status: 'sent' })
    .eq('id', invoiceId)
    .eq('status', 'draft')
    .select('id')

  if (error) {
    throw new Error(error.message)
  }
  if (!data?.length) {
    // Already past draft: a repeat click or a page opened before the
    // document was sent. Report where it stands instead of failing.
    const { data: current, error: readError } = await supabase
      .from('invoices')
      .select('status')
      .eq('id', invoiceId)
      .maybeSingle()
    if (readError) {
      throw new Error(readError.message)
    }
    if (!current) {
      throw new Error('Invoice not found')
    }
    // The invoices status CHECK constraint matches InvoiceStatus.
    return { changed: false, status: current.status as InvoiceStatus }
  }

  revalidatePath('/invoices')
  revalidatePath(`/invoices/${invoiceId}`)
  revalidatePath('/dashboard')
  return { changed: true, status: 'sent' as const }
}
