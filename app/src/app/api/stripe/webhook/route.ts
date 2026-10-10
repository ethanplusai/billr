import { NextRequest, NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe/client'
import { createServiceClient } from '@/lib/supabase/service'
import { reconcileEvent } from '@/lib/stripe/reconcile'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const signature = request.headers.get('stripe-signature')
  const secret = process.env.STRIPE_WEBHOOK_SECRET

  if (!signature || !secret) {
    return NextResponse.json({ error: 'Missing signature.' }, { status: 400 })
  }

  // Signature verification needs the exact raw request body - never
  // JSON.parse before constructEvent, since re-serializing would not
  // reproduce the byte-for-byte string Stripe signed.
  const rawBody = await request.text()

  let event
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret)
  } catch (err) {
    // Never log the raw body/signature/secret - only that verification failed.
    console.error('stripe webhook: signature verification failed', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 400 })
  }

  const service = createServiceClient()

  const { data: processed, error: readError } = await service
    .from('stripe_events')
    .select('id')
    .eq('id', event.id)
    .maybeSingle()
  if (readError) {
    return NextResponse.json({ error: 'Could not check event status.' }, { status: 503 })
  }
  if (processed) {
    return NextResponse.json({ received: true, duplicate: true })
  }

  try {
    await reconcileEvent(service, event)
  } catch (err) {
    console.error('stripe webhook: reconcile failed', event.type, err instanceof Error ? err.message : err)
    // No completion marker is written, so Stripe's automatic retry
    // reconciles the event again instead of treating it as handled.
    return NextResponse.json({ error: 'Reconcile failed.' }, { status: 500 })
  }

  const { error: finishError } = await service
    .from('stripe_events')
    .insert({ id: event.id, type: event.type })
  if (finishError && finishError.code !== '23505') {
    return NextResponse.json({ error: 'Could not finish event.' }, { status: 503 })
  }
  return NextResponse.json({ received: true })
}
