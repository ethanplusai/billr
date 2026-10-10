import 'server-only'
import { minorUnitsToAmount } from './money'
import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import { computePaymentUpdate } from '@/lib/invoices/payment-math'
import type { Database } from '@/types/database'
import { todayISO } from '@/lib/dates'

export interface ReconcileInvoiceRow {
  id: string
  business_id: string
  client_id: string
  currency: string
  total: number
  amount_paid: number
  status: string
  /**
   * The attempt the invoice currently points at. Only read by the failed
   * handler, which must ignore an event describing an attempt that has been
   * superseded.
   */
  stripe_payment_intent_id?: string | null
}

export interface PaymentInsert {
  business_id: string
  client_id: string
  invoice_id: string
  amount: number
  currency: string
  payment_method: 'stripe'
  stripe_payment_id: string | null
  payment_date: string
  notes?: string
  created_via: 'stripe'
}

export interface InvoiceUpdate {
  amount_paid: number
  balance_due: number
  status: 'paid' | 'partial' | 'sent'
  paid_at: string | null
  /**
   * Only present when a paid event supplies its authoritative payment_intent
   * id, in which case it's backfilled onto the invoice regardless of
   * whether the write when the intent was created succeeded - this is
   * what refund/dispute matching by stripe_payment_intent_id relies on.
   */
  stripe_payment_intent_id?: string
}

/** A single Stripe refund object's own (incremental, non-cumulative) amount. */
export interface RefundEventInput {
  /** The refund's own id, e.g. `re_...` - NOT the charge or payment_intent id. */
  id: string
  /** This refund's own amount in cents (Stripe's Refund.amount is already incremental, not cumulative). */
  amountCents: number
}

/**
 * Builds the payment row for a payment_intent.succeeded event. Pure - no DB
 * access, no "already paid" branching. `stripePaymentId` (the payment_intent
 * id) is the row's idempotency key: the DB's unique index on
 * `payments.stripe_payment_id` is what actually prevents a double insert
 * when Stripe redelivers the same event. The invoice is never derived from
 * this single row - always recompute from the full ledger via
 * `recomputeInvoiceFromSum`.
 */
export function buildPaidPaymentInsert(
  invoice: ReconcileInvoiceRow,
  amountCents: number,
  stripePaymentId: string | null,
  today: string
): PaymentInsert {
  return {
    business_id: invoice.business_id,
    client_id: invoice.client_id,
    invoice_id: invoice.id,
    amount: minorUnitsToAmount(amountCents, invoice.currency),
    currency: invoice.currency,
    payment_method: 'stripe',
    stripe_payment_id: stripePaymentId,
    payment_date: today,
    created_via: 'stripe',
  }
}

/**
 * Builds one negative-amount payment row per refund object, each keyed on
 * that refund's own id (not the charge id, so multiple refunds against one
 * charge - and redeliveries of the same refund - are each independently
 * idempotent). Uses each refund's own `amount` (Stripe's Refund.amount is
 * already the incremental amount for that refund, never the charge's
 * cumulative `amount_refunded`), so summing rows always equals the true
 * total refunded even across repeated/partial refund events.
 */
export function buildRefundPaymentInserts(
  invoice: ReconcileInvoiceRow,
  refunds: RefundEventInput[],
  today: string
): PaymentInsert[] {
  return refunds.map((refund) => ({
    business_id: invoice.business_id,
    client_id: invoice.client_id,
    invoice_id: invoice.id,
    amount: -minorUnitsToAmount(refund.amountCents, invoice.currency),
    currency: invoice.currency,
    payment_method: 'stripe',
    stripe_payment_id: refund.id,
    payment_date: today,
    notes: 'Stripe refund',
    created_via: 'stripe',
  }))
}

/**
 * Filters/maps a list of Stripe Refund objects (as returned by
 * `stripe.refunds.list`, the authoritative source - see the orchestration
 * comment on the charge.refunded handler for why we don't trust the
 * webhook payload's embedded `charge.refunds.data`) into the
 * `RefundEventInput` shape `buildRefundPaymentInserts` expects. Pure: takes
 * only the fields actually used, so it's testable with fetched-list-shaped
 * fixtures without a live Stripe call.
 */
export function refundEventInputsFromStripeRefunds(
  refunds: Array<Pick<Stripe.Refund, 'id' | 'status' | 'amount'>>
): RefundEventInput[] {
  return refunds
    .filter((r) => r.status === 'succeeded' && r.amount > 0)
    .map((r) => ({ id: r.id, amountCents: r.amount }))
}

/**
 * Recomputes the invoice's amount_paid/balance_due/status/paid_at from
 * scratch given the SUM of all its payment ledger rows (which nets refunds
 * automatically, since refund rows are negative). This is what makes
 * reconciliation self-healing: replaying the same event, or retrying after
 * a partial failure (payment row inserted but invoice update didn't run),
 * always converges on the correct final state because it is never computed
 * as "previous state + this event's delta" - always "total of everything
 * recorded so far". `computePaymentUpdate` is reused with amount_paid
 * pinned to 0 so its clamping/status logic operates on the absolute sum.
 */
export function recomputeInvoiceFromSum(
  invoice: { total: number },
  sumPaidDecimal: number,
  today: string,
  backfillPaymentIntentId?: string | null
): InvoiceUpdate {
  const update = computePaymentUpdate({ total: invoice.total, amount_paid: 0 }, sumPaidDecimal)
  const result: InvoiceUpdate = {
    ...update,
    paid_at: update.status === 'paid' ? today : null,
  }
  if (backfillPaymentIntentId) {
    result.stripe_payment_intent_id = backfillPaymentIntentId
  }
  return result
}

/**
 * The vocabulary Billr stores in `invoices.stripe_payment_status`: the state
 * of the LAST card attempt, never a ledger fact. A failed attempt moved no
 * money, so it never touches `payments` or the invoice's amount_paid,
 * balance_due or status. `succeeded` is written alongside the ledger row
 * purely so a stale `failed` cannot outlive the retry that went through.
 */
type PaymentAttemptStatus = 'succeeded' | 'failed'

/**
 * Decides whether a payment_intent.payment_failed event is written to the
 * invoice, and is why replaying it is safe. A paid invoice is never
 * downgraded, and the event must describe the attempt the invoice currently
 * points at, because Stripe delivers events out of order. Returns null for
 * "ignore this event".
 */
export function decideFailedAttempt(
  invoice: Pick<ReconcileInvoiceRow, 'status' | 'stripe_payment_intent_id'>,
  paymentIntentId: string | null | undefined,
): { stripe_payment_status: 'failed' } | null {
  if (invoice.status === 'paid') return null
  if (!paymentIntentId) return null
  if (invoice.stripe_payment_intent_id && invoice.stripe_payment_intent_id !== paymentIntentId) return null
  return { stripe_payment_status: 'failed' }
}

// ---------------------------------------------------------------------------
// Orchestration (not pure - talks to Supabase). Kept thin; all branching and
// math above is unit-tested without a database.
// ---------------------------------------------------------------------------

type DbClient = SupabaseClient<Database>

const INVOICE_COLUMNS = 'id, business_id, client_id, currency, total, amount_paid, status, stripe_payment_intent_id'

async function loadInvoiceById(db: DbClient, invoiceId: string): Promise<ReconcileInvoiceRow | null> {
  const { data, error } = await db.from('invoices').select(INVOICE_COLUMNS).eq('id', invoiceId).maybeSingle()
  if (error) throw error
  return (data as ReconcileInvoiceRow | null) ?? null
}

/**
 * Finds the invoice an event describes: by the invoice id Billr stamped on
 * the PaymentIntent, then by the attempt the invoice points at, then by a
 * payment already booked under that PaymentIntent. The last step matters once
 * an invoice has moved on to a newer attempt (its total was raised after a
 * payment), so a refund or dispute of the earlier payment still lands on it.
 * Null means the event is not about any invoice of ours.
 */
async function loadInvoiceForEvent(
  db: DbClient,
  metadataInvoiceId: string | undefined,
  paymentIntentId: string | null | undefined,
): Promise<ReconcileInvoiceRow | null> {
  if (metadataInvoiceId) {
    const invoice = await loadInvoiceById(db, metadataInvoiceId)
    if (invoice) return invoice
  }
  if (!paymentIntentId) return null
  const { data, error } = await db
    .from('invoices')
    .select(INVOICE_COLUMNS)
    .eq('stripe_payment_intent_id', paymentIntentId)
    .maybeSingle()
  if (error) throw error
  if (data) return data as ReconcileInvoiceRow
  const { data: booked, error: ledgerError } = await db
    .from('payments')
    .select('invoice_id')
    .eq('stripe_payment_id', paymentIntentId)
    .maybeSingle()
  if (ledgerError) throw ledgerError
  return booked?.invoice_id ? loadInvoiceById(db, booked.invoice_id) : null
}

/**
 * Records a failed attempt on the invoice: no payment row, no amount, no
 * status. The `neq('status','paid')` filter repeats the in-memory guard at the
 * database, closing the window where a success lands between read and write.
 */
async function recordFailedAttempt(db: DbClient, invoiceId: string): Promise<void> {
  const { error } = await db
    .from('invoices')
    .update({ stripe_payment_status: 'failed' })
    .eq('id', invoiceId)
    .neq('status', 'paid')
  if (error) {
    console.error('stripe reconcile: failed to record the card attempt', error.message)
    throw error
  }
}

/**
 * Clears a lingering `failed` marker once a payment is recorded, so the
 * invoice page and the MCP payment tools never show "last attempt failed" for
 * an invoice that has since been paid. Scoped to the invoice's current
 * intent: a replayed success for an earlier intent must not overwrite the
 * state of the attempt the invoice has moved on to.
 */
async function markAttemptSucceeded(db: DbClient, invoiceId: string, paymentIntentId: string): Promise<void> {
  const status: PaymentAttemptStatus = 'succeeded'
  const { error } = await db
    .from('invoices')
    .update({ stripe_payment_status: status })
    .eq('id', invoiceId)
    .eq('stripe_payment_intent_id', paymentIntentId)
  if (error) {
    console.error('stripe reconcile: failed to clear the card attempt state', error.message)
    throw error
  }
}

/**
 * Records a ledger row through record_stripe_payment, which treats a repeated
 * provider id as already recorded. That unique provider id is the ledger's
 * idempotency key.
 */
async function insertPaymentIdempotent(db: DbClient, row: PaymentInsert): Promise<void> {
  if (!row.stripe_payment_id) throw new Error('Provider payment ID is required')
  const { error } = await db.rpc('record_stripe_payment', {
    p_invoice_id: row.invoice_id,
    p_amount: row.amount,
    p_payment_date: row.payment_date,
    p_provider_id: row.stripe_payment_id,
    p_notes: row.notes,
  })
  if (error) throw error
}

/**
 * Pure extraction of the payment_intent id from a Dispute event object
 * (which carries it directly, so no charge retrieval is needed). Exported for
 * unit testing without a live Stripe call.
 */
export function extractDisputePaymentIntentId(dispute: Pick<Stripe.Dispute, 'payment_intent'>): string | null {
  if (!dispute.payment_intent) return null
  return typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent.id
}

/**
 * An event only touches an invoice when it describes that invoice: the same
 * currency and, when Billr stamped a business on the PaymentIntent, the same
 * business. Throwing makes the webhook answer 500, so a real mismatch shows up
 * in Stripe's delivery log instead of being written.
 */
function assertInvoiceBinding(
  invoice: ReconcileInvoiceRow,
  currency: string | null | undefined,
  metadata: Stripe.Metadata | null | undefined,
): void {
  const businessId = metadata?.business_id
  if (
    currency?.toLowerCase() !== invoice.currency.toLowerCase() ||
    (businessId && businessId !== invoice.business_id)
  )
    throw new Error('Stripe event currency or business does not match invoice')
}

/**
 * Routes a verified, not-yet-processed Stripe event to its handler. Event
 * types outside STRIPE_WEBHOOK_EVENTS are ignored (the caller answers 200).
 */
export async function reconcileEvent(db: DbClient, event: Stripe.Event): Promise<void> {
  // Billr charges this installation's own Stripe account. An event naming a
  // connected account came from an endpoint set up for Connect and describes
  // money that is not this installation's to record.
  if (event.account) {
    console.error('stripe reconcile: ignoring an event from a connected account', event.id)
    return
  }
  const day = todayISO()
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const intent = event.data.object as Stripe.PaymentIntent
      const invoice = await loadInvoiceForEvent(db, intent.metadata?.invoice_id, intent.id)
      // Another app on the same Stripe account: not an invoice of ours.
      if (!invoice) return
      assertInvoiceBinding(invoice, intent.currency, intent.metadata)
      const amountCents = intent.amount_received ?? intent.amount ?? 0
      await insertPaymentIdempotent(db, buildPaidPaymentInsert(invoice, amountCents, intent.id, day))
      await markAttemptSucceeded(db, invoice.id, intent.id)
      return
    }
    case 'payment_intent.payment_failed': {
      const intent = event.data.object as Stripe.PaymentIntent
      const invoice = await loadInvoiceForEvent(db, intent.metadata?.invoice_id, intent.id)
      if (!invoice) return
      assertInvoiceBinding(invoice, intent.currency, intent.metadata)
      if (!decideFailedAttempt(invoice, intent.id)) return
      await recordFailedAttempt(db, invoice.id)
      return
    }
    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge
      const paymentIntentId =
        typeof charge.payment_intent === 'string' ? charge.payment_intent : (charge.payment_intent?.id ?? null)
      const invoice = await loadInvoiceForEvent(db, charge.metadata?.invoice_id, paymentIntentId)
      if (!invoice) return
      assertInvoiceBinding(invoice, charge.currency, charge.metadata)
      // The payload's embedded refunds list can be absent or truncated, so
      // fetch the complete list. A failed fetch throws, so Stripe retries.
      const { stripe } = await import('@/lib/stripe/client')
      let page = await stripe.refunds.list({ charge: charge.id, limit: 100 })
      const all = [...page.data]
      while (page.has_more) {
        page = await stripe.refunds.list({ charge: charge.id, limit: 100, starting_after: all[all.length - 1].id })
        all.push(...page.data)
      }
      const refunds = refundEventInputsFromStripeRefunds(all)
      for (const row of buildRefundPaymentInserts(invoice, refunds, day)) {
        await insertPaymentIdempotent(db, row)
      }
      return
    }
    case 'charge.dispute.created': {
      const dispute = event.data.object as Stripe.Dispute
      const paymentIntentId = extractDisputePaymentIntentId(dispute)
      if (!paymentIntentId) return
      const invoice = await loadInvoiceForEvent(db, undefined, paymentIntentId)
      if (!invoice) return
      assertInvoiceBinding(invoice, dispute.currency, undefined)
      // By invoice id, not by stripe_payment_intent_id: a dispute on an
      // earlier payment must still flag an invoice that has moved on.
      const { error } = await db.from('invoices').update({ disputed: true }).eq('id', invoice.id)
      if (error) {
        console.error('stripe reconcile: failed to flag invoice disputed', error.message)
        throw error
      }
      return
    }
    default:
      return
  }
}
