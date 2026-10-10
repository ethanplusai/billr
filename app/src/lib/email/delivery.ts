import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Json } from '@/types/database'
import type { Database } from '@/types/database'
import { consumeEmailQuota } from '@/lib/email/quota'
/**
 * The single chokepoint every outbound invoice/estimate email passes
 * through, from the web server actions and the MCP send tools alike. That is
 * why the daily send quota is enforced here rather than at either call site:
 * neither surface can grow a path around it.
 */
export async function prepareDelivery<T>(
  db: SupabaseClient<Database>,
  businessId: string,
  documentId: string,
  kind: 'invoice' | 'estimate',
  requestId: string,
  input: unknown,
  payload: T
) {
  z.uuid().parse(requestId)
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const read = () =>
    db
      .from('email_deliveries')
      .select('*')
      .eq('business_id', businessId)
      .eq('request_id', requestId)
      .maybeSingle()
  const initial = await read()
  let row = initial.data
  const error = initial.error
  if (error) throw new Error('Could not check email delivery')
  if (!row) {
    // Spent once per NEW request id, and before the delivery row exists.
    // Both halves matter: a retry of an in-flight send reuses its request id
    // and so must not be charged twice, and a rejected send must leave no
    // half-created delivery row behind for a later retry to trip over.
    await consumeEmailQuota(businessId)
    const inserted = await db
      .from('email_deliveries')
      .insert({
        business_id: businessId,
        document_id: documentId,
        kind,
        request_id: requestId,
        input_hash: hash,
        payload: payload as Json,
      })
      .select('*')
      .single()
    if (inserted.error && inserted.error.code !== '23505')
      throw new Error('Could not prepare email delivery')
    row = inserted.data
    if (!row) {
      const replay = await read()
      if (replay.error) throw new Error('Could not check email delivery')
      row = replay.data
    }
  }
  if (
    !row ||
    row.document_id !== documentId ||
    row.kind !== kind ||
    row.input_hash !== hash
  )
    throw new Error(
      'This request ID was used for different email content. Review and use a new request ID.'
    )
  if (row.sent_at)
    return {
      payload: row.payload as T,
      alreadySent: true,
      key: `billr:${businessId}:${requestId}`,
    }
  // Resend retains idempotency keys for 24 hours. Never resend an unknown old outcome.
  if (Date.now() - Date.parse(row.created_at) > 23 * 3600000)
    throw new Error(
      'Delivery outcome needs review in the email provider before sending again.'
    )
  return {
    payload: row.payload as T,
    alreadySent: false,
    key: `billr:${businessId}:${requestId}`,
  }
}
export async function finishDelivery(
  db: SupabaseClient<Database>,
  businessId: string,
  requestId: string
) {
  const { error } = await db
    .from('email_deliveries')
    .update({ sent_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('request_id', requestId)
  if (error)
    throw new Error(
      'Email accepted, but delivery status could not be saved. Retry with the same request ID.'
    )
}
