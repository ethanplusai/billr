'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { failure, type WriteResult } from './result'

/**
 * Expense writes, as server actions in the same shape as time entries. See
 * src/lib/actions/time.ts.
 */

const expenseInput = z.object({
  client_id: z.string().uuid().nullish(),
  category: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).nullish(),
  amount: z.number().finite().positive().max(99999999),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vendor: z.string().trim().max(200).nullish(),
  is_billable: z.boolean(),
})

export type ExpenseInput = z.input<typeof expenseInput>

async function resolveCurrency(
  supabase: Awaited<ReturnType<typeof createClient>>,
  businessId: string,
  clientId: string | null,
): Promise<string> {
  if (clientId) {
    const { data } = await supabase
      .from('clients')
      .select('currency')
      .eq('id', clientId)
      .maybeSingle()
    if (data?.currency) return data.currency
  }
  const { data } = await supabase
    .from('businesses')
    .select('default_currency')
    .eq('id', businessId)
    .maybeSingle()
  return data?.default_currency || 'USD'
}

export async function createExpenseAction(
  businessId: string,
  input: ExpenseInput,
  requestId: string,
): Promise<WriteResult> {
  try {
    const data = expenseInput.parse(input)
    const supabase = await createClient()
    const clientId = data.client_id || null

    // Same durable retry as the time form: one request id per form, replayed
    // on every attempt, so a timeout cannot record the expense twice.
    const { error } = await supabase.rpc('create_work_entry_once', {
      p_business_id: z.string().uuid().parse(businessId),
      p_kind: 'expense',
      p_request_id: z.string().uuid().parse(requestId),
      p_record: {
        business_id: businessId,
        client_id: clientId,
        category: data.category,
        description: data.description || null,
        amount: data.amount,
        currency: await resolveCurrency(supabase, businessId, clientId),
        date: data.date,
        vendor: data.vendor || null,
        is_billable: data.is_billable,
      },
    })
    if (error) return { error: error.message }

    revalidatePath('/expenses')
    revalidatePath('/dashboard')
    return { ok: true }
  } catch (error) {
    return failure(error, 'Could not save that expense.')
  }
}

export async function updateExpenseAction(
  expenseId: string,
  input: ExpenseInput,
): Promise<WriteResult> {
  try {
    const data = expenseInput.parse(input)
    const supabase = await createClient()

    const { data: saved, error } = await supabase
      .from('expenses')
      .update({
        client_id: data.client_id || null,
        category: data.category,
        description: data.description || null,
        amount: data.amount,
        date: data.date,
        vendor: data.vendor || null,
        is_billable: data.is_billable,
      })
      .eq('id', expenseId)
      .is('invoice_id', null)
      .select('id')

    if (error) return { error: error.message }
    if (!saved?.length) return { error: 'Invoiced expenses cannot be edited.' }

    revalidatePath('/expenses')
    revalidatePath(`/expenses/${expenseId}`)
    return { ok: true }
  } catch (error) {
    return failure(error, 'Could not save that expense.')
  }
}

export async function deleteExpenseAction(expenseId: string): Promise<WriteResult> {
  try {
    const supabase = await createClient()

    const { data: deleted, error } = await supabase
      .from('expenses')
      .delete()
      .eq('id', expenseId)
      .is('invoice_id', null)
      .select('id')

    if (error) return { error: error.message }
    if (!deleted?.length) return { error: 'Invoiced expenses cannot be deleted.' }

    revalidatePath('/expenses')
    revalidatePath('/dashboard')
    return { ok: true }
  } catch (error) {
    return failure(error, 'Could not delete that expense.')
  }
}
