'use server'

import { todayISO, toISODate } from '@/lib/dates'
import { addDays } from 'date-fns'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { generatePublicId } from '@/lib/utils/invoice'
import { z } from 'zod'
import type { Database } from '@/types/database'
import type { EstimateStatus } from '@/types'
import type { EstimateFormData } from '@/lib/validations/estimate'

const estimateInput=z.object({client_id:z.uuid(),issue_date:z.iso.date(),expiry_date:z.iso.date(),notes:z.string().max(5000).optional(),terms:z.string().max(5000).optional(),line_items:z.array(z.object({description:z.string().trim().min(1).max(2000),quantity:z.number().finite().positive(),rate:z.number().finite().nonnegative()})).min(1).max(500)})
export async function createEstimateAction(businessId:string,input:EstimateFormData,_status:'draft'|'sent'='draft',requestId:string){
 const db=await createClient(),data=estimateInput.parse(input)
 const {data:estimate,error}=await db.rpc('create_estimate_document',{p_business_id:businessId,p_client_id:data.client_id,p_request_id:requestId,p_patch:{issue_date:data.issue_date,expiry_date:data.expiry_date,notes:data.notes,terms:data.terms},p_lines:data.line_items})
 if(error)throw new Error(error.message)
 revalidatePath('/estimates')
 return estimate as Database['public']['Tables']['estimates']['Row']
}

/**
 * Saves an edited estimate. One transaction, via replace_estimate_line_items,
 * for the same reason as updateInvoiceAction: the old
 * delete-then-insert could leave an estimate with a total and no line items,
 * and it checked none of its three results.
 */
export async function updateEstimateAction(
  estimateId: string,
  input: EstimateFormData
) {
  const data=estimateInput.parse(input)
  const supabase = await createClient()

  const subtotal = data.line_items.reduce(
    (sum, item) => sum + Math.round(item.quantity * item.rate * 100) / 100,
    0
  )

  const { data: estimate, error } = await supabase.rpc('replace_estimate_line_items', {
    p_estimate_id: estimateId,
    p_line_items: data.line_items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      rate: item.rate,
      amount: Math.round(item.quantity * item.rate * 100) / 100,
    })),
    p_estimate_patch: {
      client_id: data.client_id,
      issue_date: data.issue_date,
      expiry_date: data.expiry_date,
      subtotal,
      total: subtotal,
      notes: data.notes || null,
      terms: data.terms || null,
    },
  })

  if (error) {
    throw new Error(error.message)
  }

  revalidatePath('/estimates')
  revalidatePath(`/estimates/${estimateId}`)
  return estimate
}

export async function deleteEstimateAction(estimateId: string) {
  const supabase = await createClient()

  // Only allow deleting draft estimates
  const { data: estimate } = await supabase
    .from('estimates')
    .select('status')
    .eq('id', estimateId)
    .single()

  if (estimate?.status !== 'draft') {
    throw new Error('Only draft estimates can be deleted')
  }

  const { error } = await supabase
    .from('estimates')
    .delete()
    .eq('id', estimateId)

  if (error) {
    throw new Error(error.message)
  }

  revalidatePath('/estimates')
}

/**
 * Marks a draft estimate as sent without emailing it, so its public page
 * opens for an owner who shares the link themselves. Only a draft moves; for
 * an estimate already past draft it changes nothing and returns the current
 * status, so a repeat click is a quiet no-op.
 */
export async function markEstimateSentAction(estimateId: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('estimates')
    .update({ status: 'sent' })
    .eq('id', estimateId)
    .eq('status', 'draft')
    .select('id')

  if (error) {
    throw new Error(error.message)
  }
  if (!data?.length) {
    // Already past draft: a repeat click or a page opened before the
    // document was sent. Report where it stands instead of failing.
    const { data: current, error: readError } = await supabase
      .from('estimates')
      .select('status')
      .eq('id', estimateId)
      .maybeSingle()
    if (readError) {
      throw new Error(readError.message)
    }
    if (!current) {
      throw new Error('Estimate not found')
    }
    // Typed like the estimate rows the detail page already holds.
    return { changed: false, status: current.status as EstimateStatus }
  }

  revalidatePath('/estimates')
  revalidatePath(`/estimates/${estimateId}`)
  return { changed: true, status: 'sent' as const }
}

export async function convertEstimateAction(estimateId: string) {
  const supabase = await createClient()
  const { data: estimate, error: fetchError } = await supabase.from('estimates')
    .select('*, line_items:estimate_line_items(*)').eq('id', estimateId).single()
  if (fetchError || !estimate) throw new Error('Estimate not found')
  const { data: result, error } = await supabase.rpc('convert_estimate_to_invoice', {
    p_estimate_id: estimateId, p_public_id: generatePublicId(),
    p_issue_date: todayISO(),
    p_due_date: toISODate(addDays(new Date(), 30)),
    p_line_items: estimate.line_items.map((line) => ({ ...line })),
    p_subtotal: estimate.subtotal, p_total: estimate.total,
  })
  if (error || !result) throw new Error(error?.message || 'Could not convert estimate')
  revalidatePath('/estimates')
  revalidatePath('/invoices')
  return (result as { invoice: { id: string } }).invoice
}
