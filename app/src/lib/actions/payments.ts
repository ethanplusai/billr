'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { correctionMessage } from '@/lib/payments/messages'
import { failure, type WriteResult } from './result'

/**
 * Recording a payment, correcting one and voiding one, as server actions that
 * validate their input before anything is written. See src/lib/actions/time.ts
 * for the same shape on work entries.
 *
 * Every call uses the caller's own Supabase client, so membership is decided
 * by RLS for record_payment_once, which is SECURITY INVOKER, and by
 * resolve_payment_actor inside the two SECURITY DEFINER corrections.
 *
 * Money collected by Stripe does not come through here at all: the webhook
 * records it with record_stripe_payment through the service
 * role.
 */

const uuid = z.string().uuid()
/** TEXT in SQL, not a uuid: the corrections accept any stable request id. */
const requestText = z.string().trim().min(1).max(200)
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const amount = z.number().finite().positive().max(99999999)
const optionalText = z.string().trim().max(2000).nullish()

const recordInput = z.object({
  invoice_id: uuid,
  amount,
  payment_date: isoDate,
  payment_method: z.string().trim().min(1).max(50),
  reference_number: z.string().trim().max(200).nullish(),
  notes: optionalText,
})

export type RecordPaymentInput = z.input<typeof recordInput>

const updateInput = z.object({
  payment_date: isoDate.nullish(),
  method: z.string().trim().min(1).max(50).nullish(),
  notes: optionalText,
  reference_number: z.string().trim().max(200).nullish(),
  amount: amount.nullish(),
})

export type UpdatePaymentInput = z.input<typeof updateInput>

export async function recordPaymentAction(
  businessId: string,
  input: RecordPaymentInput,
  requestId: string,
): Promise<WriteResult> {
  try {
    const data = recordInput.parse(input)
    const supabase = await createClient()

    // The request id is minted once per form and reused on every retry, so
    // record_payment_once returns the first payment rather
    // than recording the same money twice. business_id, client_id and currency
    // come from the invoice inside the RPC, never from the browser.
    const { error } = await supabase.rpc('record_payment_once', {
      p_request_id: uuid.parse(requestId),
      p_invoice_id: data.invoice_id,
      p_amount: data.amount,
      p_payment_date: data.payment_date,
      p_payment_method: data.payment_method,
      p_reference_number: data.reference_number || undefined,
      p_notes: data.notes || undefined,
      p_created_via: 'web',
    })
    if (error) return { error: correctionMessage(error.message, 'Could not record that payment.') }

    revalidatePath('/payments')
    revalidatePath(`/invoices/${data.invoice_id}`)
    revalidatePath('/dashboard')
    return { ok: true }
  } catch (error) {
    return failure(error, 'Could not record that payment.')
  }
}

export async function updatePaymentAction(
  paymentId: string,
  input: UpdatePaymentInput,
  requestId: string,
): Promise<WriteResult> {
  try {
    const data = updateInput.parse(input)
    const supabase = await createClient()

    // One request id per open dialog, replayed on every attempt: update_payment
    // keys its audit row on (payment_id, request_id) so a double submit
    // returns the first answer instead of applying the change twice.
    const { error } = await supabase.rpc('update_payment', {
      p_payment_id: uuid.parse(paymentId),
      p_request_id: requestText.parse(requestId),
      p_payment_date: data.payment_date || undefined,
      p_method: data.method || undefined,
      p_notes: data.notes || undefined,
      p_reference_number: data.reference_number || undefined,
      p_amount: data.amount ?? undefined,
    })
    if (error) return { error: correctionMessage(error.message, 'Could not update that payment.') }

    revalidatePath('/payments')
    revalidatePath('/invoices')
    revalidatePath('/dashboard')
    return { ok: true }
  } catch (error) {
    return failure(error, 'Could not update that payment.')
  }
}

export async function voidPaymentAction(
  paymentId: string,
  reason: string,
  requestId: string,
): Promise<WriteResult> {
  try {
    const voidReason = z.string().trim().min(1).max(2000).safeParse(reason)
    if (!voidReason.success) return { error: 'Enter a reason for voiding this payment.' }

    const supabase = await createClient()

    const { error } = await supabase.rpc('void_payment', {
      p_payment_id: uuid.parse(paymentId),
      p_request_id: requestText.parse(requestId),
      p_reason: voidReason.data,
    })
    if (error) return { error: correctionMessage(error.message, 'Could not void that payment.') }

    revalidatePath('/payments')
    revalidatePath('/invoices')
    revalidatePath('/dashboard')
    return { ok: true }
  } catch (error) {
    return failure(error, 'Could not void that payment.')
  }
}
