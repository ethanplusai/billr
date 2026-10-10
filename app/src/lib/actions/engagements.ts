'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { engagementErrorMessage } from '@/lib/engagements/errors'
import { BILLING_MODES, DUE_RULES, MAX_ENTRIES } from '@/lib/engagements/schedule'
import { failure } from './result'

/**
 * Engagement writes from the browser.
 *
 * Every one of them is a thin wrapper around a SECURITY DEFINER RPC. The rules live there, not here: the schedule is expanded in
 * SQL so the entries always add up, request_id makes a retry a replay rather
 * than a second write, and billed money is refused by the database whatever
 * this file does.
 *
 * What this file adds is input validation and a message a person can read.
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const entryInput = z.object({
  label: z.string().trim().max(200).optional(),
  amount: z.number().finite().positive().optional(),
  percent: z.number().finite().positive().max(100).optional(),
  due_rule: z.enum(DUE_RULES).optional(),
  due_on: DATE.nullish(),
})

const engagementInput = z.object({
  client_id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  total: z.number().finite().positive().max(99999999),
  currency: z.string().trim().length(3).optional(),
  billing_mode: z.enum(BILLING_MODES),
  entries: z.array(entryInput).max(MAX_ENTRIES).optional(),
  installments: z.number().int().min(1).max(MAX_ENTRIES).optional(),
  start_now: z.boolean().optional(),
  starts_on: DATE.nullish(),
  target_end: DATE.nullish(),
  notes: z.string().trim().max(2000).nullish(),
  source_estimate_id: z.string().uuid().nullish(),
})

export type EngagementInput = z.input<typeof engagementInput>

export type EngagementWriteResult =
  | { ok: true; engagementId: string; warning?: string | null }
  | { error: string }

/** The shape every engagement RPC answers with. */
interface EngagementRpcResult {
  engagement: { id: string }
  warning?: string | null
}

function rpcFailure(error: { message?: string } | null, fallback: string): { error: string } {
  const message = engagementErrorMessage(error?.message)
  if (!message) console.error('engagement action:', error)
  return { error: message ?? fallback }
}

/** A thrown failure (such as a zod refusal) as something to show. */
function thrown(error: unknown, fallback: string): { error: string } {
  const result = failure(error, fallback)
  return 'error' in result ? result : { error: fallback }
}

function revalidateEngagement(engagementId: string) {
  revalidatePath('/engagements')
  revalidatePath(`/engagements/${engagementId}`)
}

export async function createEngagementAction(
  businessId: string,
  input: EngagementInput,
  requestId: string,
): Promise<EngagementWriteResult> {
  try {
    const data = engagementInput.parse(input)
    const supabase = await createClient()

    const { data: result, error } = await supabase.rpc('create_engagement_with_schedule', {
      p_request_id: z.string().uuid().parse(requestId),
      p_business_id: z.string().uuid().parse(businessId),
      p_client_id: data.client_id,
      p_name: data.name,
      p_total: data.total,
      p_currency: data.currency ?? '',
      p_billing_mode: data.billing_mode,
      p_entries: (data.entries ?? []) as never,
      p_installments: data.installments,
      p_status: data.start_now ? 'active' : 'draft',
      p_starts_on: data.starts_on ?? undefined,
      p_target_end: data.target_end ?? undefined,
      p_notes: data.notes ?? undefined,
      p_source_estimate_id: data.source_estimate_id ?? undefined,
    })

    if (error || !result) return rpcFailure(error, 'Could not create that engagement.')

    const created = result as unknown as EngagementRpcResult
    revalidateEngagement(created.engagement.id)
    return { ok: true, engagementId: created.engagement.id }
  } catch (error) {
    return thrown(error, 'Could not create that engagement.')
  }
}

/**
 * Start, pause, complete or cancel. Completing an engagement with money still
 * unbilled is allowed and returns the warning the database produced, so the
 * page can say how much is left rather than closing it silently.
 */
export async function setEngagementStatusAction(
  engagementId: string,
  status: 'draft' | 'active' | 'paused' | 'completed' | 'cancelled',
  requestId: string,
): Promise<EngagementWriteResult> {
  try {
    const supabase = await createClient()

    const { data: result, error } = await supabase.rpc('set_engagement_status', {
      p_request_id: z.string().uuid().parse(requestId),
      p_engagement_id: z.string().uuid().parse(engagementId),
      p_status: status,
    })

    if (error || !result) return rpcFailure(error, 'Could not change that engagement.')

    revalidateEngagement(engagementId)
    return {
      ok: true,
      engagementId,
      warning: (result as unknown as EngagementRpcResult).warning ?? null,
    }
  } catch (error) {
    return thrown(error, 'Could not change that engagement.')
  }
}

export async function markEntryCompleteAction(
  entryId: string,
  requestId: string,
): Promise<EngagementWriteResult> {
  try {
    const supabase = await createClient()

    const { data: result, error } = await supabase.rpc('mark_entry_complete', {
      p_request_id: z.string().uuid().parse(requestId),
      p_entry_id: z.string().uuid().parse(entryId),
    })

    if (error || !result) return rpcFailure(error, 'Could not mark that entry complete.')

    const done = result as unknown as EngagementRpcResult
    revalidateEngagement(done.engagement.id)
    return { ok: true, engagementId: done.engagement.id }
  } catch (error) {
    return thrown(error, 'Could not mark that entry complete.')
  }
}

export async function waiveEntryAction(
  entryId: string,
  reason: string,
  requestId: string,
): Promise<EngagementWriteResult> {
  try {
    const supabase = await createClient()

    const { data: result, error } = await supabase.rpc('waive_entry', {
      p_request_id: z.string().uuid().parse(requestId),
      p_entry_id: z.string().uuid().parse(entryId),
      p_reason: z.string().trim().min(1).max(2000).parse(reason),
    })

    if (error || !result) return rpcFailure(error, 'Could not waive that entry.')

    const done = result as unknown as EngagementRpcResult
    revalidateEngagement(done.engagement.id)
    return { ok: true, engagementId: done.engagement.id }
  } catch (error) {
    return thrown(error, 'Could not waive that entry.')
  }
}

const conversionInput = z.object({
  billing_mode: z.enum(BILLING_MODES),
  entries: z.array(entryInput).max(MAX_ENTRIES).optional(),
  installments: z.number().int().min(1).max(MAX_ENTRIES).optional(),
})

export type EngagementConversionInput = z.input<typeof conversionInput>

/**
 * Turns an accepted estimate into the agreement it was quoting.
 *
 * The client, the total and the currency are read off the estimate inside the
 * RPC and are deliberately not parameters here: a conversion must never be a
 * place a price quietly changes. All this passes is the SHAPE of the schedule.
 *
 * The new engagement is a draft. Accepting a quote is not the same event as
 * starting the work, and starting an engagement is what makes its deposit
 * billable, so that stays a separate, deliberate click.
 */
export async function convertEstimateToEngagementAction(
  estimateId: string,
  input: EngagementConversionInput,
  requestId: string,
): Promise<EngagementWriteResult> {
  try {
    const data = conversionInput.parse(input)
    const supabase = await createClient()

    const { data: result, error } = await supabase.rpc('convert_estimate_to_engagement', {
      p_request_id: z.string().uuid().parse(requestId),
      p_estimate_id: z.string().uuid().parse(estimateId),
      p_billing_mode: data.billing_mode,
      p_entries: (data.entries ?? []) as never,
      p_installments: data.installments,
    })

    if (error || !result) return rpcFailure(error, 'Could not turn that estimate into an engagement.')

    const created = result as unknown as EngagementRpcResult
    revalidateEngagement(created.engagement.id)
    revalidatePath('/estimates')
    revalidatePath(`/estimates/${estimateId}`)
    return { ok: true, engagementId: created.engagement.id }
  } catch (error) {
    return thrown(error, 'Could not turn that estimate into an engagement.')
  }
}
