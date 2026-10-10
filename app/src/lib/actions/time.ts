'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { secondsFromHours, timeAmount } from '@/lib/work/time'
import { failure, type WriteResult } from './result'

/**
 * Logging time runs as server actions that validate their input before
 * anything is written.
 *
 * Every call uses the caller's own Supabase client, so RLS decides membership.
 */

const entryInput = z.object({
  client_id: z.string().uuid().nullish(),
  description: z.string().trim().min(1).max(2000),
  hours: z.number().finite().positive().max(24),
  rate: z.number().finite().min(0).max(999999).nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  is_billable: z.boolean(),
  project_name: z.string().trim().max(200).nullish(),
})

export type TimeEntryInput = z.input<typeof entryInput>

/**
 * The currency of a work entry is never taken from the browser: it follows the
 * client being billed, and falls back to the business default.
 */
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

export async function createTimeEntryAction(
  businessId: string,
  input: TimeEntryInput,
  requestId: string,
): Promise<WriteResult> {
  try {
    const data = entryInput.parse(input)
    const supabase = await createClient()
    const seconds = secondsFromHours(data.hours)
    const clientId = data.client_id || null

    // The request id is minted once per form and reused on every retry, so
    // create_work_entry_once returns the first entry rather
    // than logging the same work twice.
    const { error } = await supabase.rpc('create_work_entry_once', {
      p_business_id: z.string().uuid().parse(businessId),
      p_kind: 'time',
      p_request_id: z.string().uuid().parse(requestId),
      p_record: {
        business_id: businessId,
        client_id: clientId,
        description: data.description,
        currency: await resolveCurrency(supabase, businessId, clientId),
        duration_seconds: seconds,
        hourly_rate: data.is_billable ? data.rate : 0,
        date: data.date,
        is_billable: data.is_billable,
        project_name: data.project_name || null,
      },
    })
    if (error) return { error: error.message }

    revalidatePath('/time')
    revalidatePath('/dashboard')
    return { ok: true }
  } catch (error) {
    return failure(error, 'Could not log that time entry.')
  }
}

export async function updateTimeEntryAction(
  entryId: string,
  input: TimeEntryInput,
): Promise<WriteResult> {
  try {
    const data = entryInput.parse(input)
    const supabase = await createClient()
    const seconds = secondsFromHours(data.hours)
    const clientId = data.client_id || null

    const { data: entry } = await supabase
      .from('time_entries')
      .select('business_id')
      .eq('id', entryId)
      .maybeSingle()
    if (!entry?.business_id) return { error: 'Time entry not found.' }

    // Invoiced work stays frozen: the `is('invoice_id', null)` filter is the
    // same one the browser used, and the row count tells us whether it held.
    const { data: saved, error } = await supabase
      .from('time_entries')
      .update({
        client_id: clientId,
        description: data.description,
        currency: await resolveCurrency(supabase, entry.business_id, clientId),
        duration_seconds: seconds,
        hourly_rate: data.is_billable ? data.rate : 0,
        amount: data.is_billable ? timeAmount(seconds, data.rate) : 0,
        date: data.date,
        is_billable: data.is_billable,
        project_name: data.project_name || null,
      })
      .eq('id', entryId)
      .is('invoice_id', null)
      .select('id')

    if (error) return { error: error.message }
    if (!saved?.length) return { error: 'Invoiced work cannot be edited.' }

    revalidatePath('/time')
    revalidatePath(`/time/${entryId}`)
    return { ok: true }
  } catch (error) {
    return failure(error, 'Could not save that time entry.')
  }
}

export async function deleteTimeEntryAction(entryId: string): Promise<WriteResult> {
  try {
    const supabase = await createClient()

    const { data: deleted, error } = await supabase
      .from('time_entries')
      .delete()
      .eq('id', entryId)
      .is('invoice_id', null)
      .select('id')

    if (error) return { error: error.message }
    if (!deleted?.length) return { error: 'Invoiced work cannot be deleted.' }

    revalidatePath('/time')
    revalidatePath('/dashboard')
    return { ok: true }
  } catch (error) {
    return failure(error, 'Could not delete that time entry.')
  }
}
