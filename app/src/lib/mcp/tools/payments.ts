import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { McpCtx } from '@/lib/mcp/context'
import { ScopeError } from '@/lib/mcp/scoped-db'
import { stripePaymentsConfigured } from '@/lib/stripe/config'
import { appUrl, errorResult, jsonResult, formatCurrency, publicUrl, isOverdue } from '@/lib/mcp/shared'

const PAYMENT_HISTORY_LIMIT = 100

const DATE_FIELD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

/**
 * The methods a correction may set. "stripe" is deliberately absent: only the
 * verified Stripe webhook flow may write a card entry, and a
 * correction that tried would be refused by the database anyway.
 */
const EDITABLE_PAYMENT_METHODS = ['cash', 'check', 'bank_transfer', 'credit_card', 'paypal', 'other'] as const

/**
 * Maps the RPC's error codes onto sentences a calling agent
 * can act on. Anything unrecognised falls back to the generic message rather
 * than leaking a Postgres error to the user.
 */
function correctionError(error: { message?: string } | null, fallback: string): string {
  const code = error?.message ?? ''
  if (code.includes('stripe_payment_locked')) {
    return 'This payment was collected through Stripe, so it cannot be edited or voided here. Issue a refund in Stripe instead. The refund arrives back in Billr as its own ledger entry.'
  }
  if (code.includes('payment_already_voided')) {
    return 'This payment has already been voided. There is nothing left to change.'
  }
  if (code.includes('amount_exceeds_invoice_total')) {
    return 'That amount would take the invoice past its total once the other payments on it are counted. Lower the amount, or void a duplicate payment first.'
  }
  if (code.includes('request_id_reused')) {
    return 'That request_id was already used for a different correction on this payment. Use a new request_id.'
  }
  if (code.includes('key_cannot_edit_payments')) {
    return 'This API key does not have the payments permission, which is required to correct or void a payment.'
  }
  if (code.includes('void_reason_required')) {
    return 'A reason is required to void a payment.'
  }
  if (code.includes('invalid_amount')) {
    return 'The amount must be greater than zero.'
  }
  if (code.includes('payment_not_found')) {
    return 'Payment not found'
  }
  console.error('payment correction (rpc):', error)
  return fallback
}

interface CorrectionRpcResult {
  payment: {
    id: string
    amount: number
    payment_date: string
    payment_method: string
    reference_number: string | null
    notes: string | null
    currency: string
    source: string
    voided_at: string | null
    void_reason: string | null
  }
  invoice: { invoice_number: string; status: string; amount_paid: number; balance_due: number; currency: string }
  replayed: boolean
}

/** Shared result shape for both corrections, so an agent reads one format. */
function correctionResult(data: unknown, verb: 'Updated' | 'Voided') {
  const result = data as CorrectionRpcResult
  const { payment, invoice } = result
  const amount = formatCurrency(payment.amount, invoice.currency)
  const balance = formatCurrency(invoice.balance_due, invoice.currency)
  const replayNote = result.replayed ? ' This was a replay of an earlier identical request, so nothing changed twice.' : ''
  return {
    summary: `${verb} the ${amount} payment on ${invoice.invoice_number}. The invoice is now ${invoice.status} with ${balance} still due.${replayNote}`,
    payment: {
      payment_id: payment.id,
      amount: payment.amount,
      payment_date: payment.payment_date,
      method: payment.payment_method,
      reference_number: payment.reference_number,
      notes: payment.notes,
      source: payment.source,
      voided_at: payment.voided_at,
      void_reason: payment.void_reason,
    },
    invoice: {
      invoice_number: invoice.invoice_number,
      status: invoice.status,
      amount_paid: invoice.amount_paid,
      balance_due: invoice.balance_due,
    },
    replayed: result.replayed,
  }
}

/**
 * Card money is owned by the Stripe flow. Checked here so the refusal is a
 * sentence rather than an error code; the database refuses it again regardless.
 */
const STRIPE_LOCKED =
  'This payment was collected through Stripe, so it cannot be edited or voided here. Issue a refund in Stripe instead. The refund arrives back in Billr as its own ledger entry.'

export interface PaymentLedgerRow {
  id: string
  amount: number
  payment_date: string
  payment_method: string
  reference_number: string | null
  notes: string | null
  created_via: string | null
  stripe_payment_id: string | null
  source: string
  voided_at: string | null
  void_reason: string | null
}

export interface PaymentReconciliation {
  ledger_total: number
  recorded_amount_paid: number
  /**
   * True when the invoice's stored amount_paid does not match the sum of its
   * payments ledger. Surfaced rather than silently preferring one number, so a
   * caller reporting "you have been paid X" is never confidently wrong.
   */
  mismatch: boolean
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Pure reconciliation between the payments ledger and the invoice's stored
 * amount_paid. Extracted so it can be unit-tested without a database.
 */
export function reconcilePayments(payments: Pick<PaymentLedgerRow, 'amount'>[], amountPaid: number): PaymentReconciliation {
  const ledgerTotal = round2(payments.reduce((sum, payment) => sum + payment.amount, 0))
  const recorded = round2(amountPaid)
  return {
    ledger_total: ledgerTotal,
    recorded_amount_paid: recorded,
    mismatch: ledgerTotal !== recorded,
  }
}

/**
 * Registers get_payment_status, scoped to the businesses in ctx.db.scope.
 *
 * LEDGER SOURCE: money lives in the `payments` table only.
 */
export function registerPaymentTools(server: McpServer, ctx: McpCtx) {
  server.registerTool(
    'get_payment_status',
    {
      title: 'Get Payment Status',
      description:
        'Report where one invoice stands on money: amount due, amount paid, each recorded payment with its payment_id, whether online card payment is switched on, and the link a client can pay from. Use it to answer "has X paid yet" or "what do they still owe". Voided payments are left out of the list and every total unless include_voided is true. Read-only: use record_payment to log a payment that came in outside Stripe, update_payment to correct one, and void_payment to undo one.',
      inputSchema: z.object({
        invoice_id: z
          .string()
          .uuid()
          .describe('Id of the invoice to check, from list_invoices, create_invoice, or get_invoice.'),
        include_voided: z
          .boolean()
          .optional()
          .describe('Include voided payments in the returned list. Defaults to false. Voided payments never count towards any total either way.'),
      }),
    },
    async ({ invoice_id, include_voided }) => {
      let invoice
      try {
        invoice = await ctx.db.assertInvoiceAccess(invoice_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access invoice.')
      }

      const { data: payments, error: paymentsError } = await ctx.db.svc
        .from('payments')
        .select('id, amount, payment_date, payment_method, reference_number, notes, created_via, stripe_payment_id, source, voided_at, void_reason')
        .eq('invoice_id', invoice_id)
        .eq('business_id', invoice.business_id)
        .order('payment_date', { ascending: true })
        .limit(PAYMENT_HISTORY_LIMIT)

      if (paymentsError) {
        console.error('get_payment_status (payments):', paymentsError)
        return errorResult('Could not load the payment history for this invoice.')
      }

      const allPayments = (payments ?? []) as PaymentLedgerRow[]
      // A voided payment is not money. It never counts towards a total, and it
      // stays out of the list unless the caller asks to see it.
      const live = allPayments.filter((payment) => payment.voided_at === null)
      const listed = include_voided ? allPayments : live
      const history = listed.map((payment) => ({
        /** Stable id. Pass it to update_payment or void_payment. */
        payment_id: payment.id,
        amount: payment.amount,
        payment_date: payment.payment_date,
        method: payment.payment_method,
        reference_number: payment.reference_number,
        notes: payment.notes,
        /** "stripe" means it arrived through the online pay link, so it cannot be edited or voided. */
        source: payment.source,
        voided_at: payment.voided_at,
        void_reason: payment.void_reason,
      }))

      const reconciliation = reconcilePayments(live, invoice.amount_paid)
      const overdue = isOverdue(invoice.status, invoice.due_date)
      const onlinePaymentsEnabled = stripePaymentsConfigured()

      const paidLabel = formatCurrency(invoice.amount_paid, invoice.currency)
      const dueLabel = formatCurrency(invoice.balance_due, invoice.currency)
      const overdueNote = overdue ? `, overdue since ${invoice.due_date}` : ''
      const mismatchNote = reconciliation.mismatch
        ? ` Warning: the recorded payments add up to ${formatCurrency(reconciliation.ledger_total, invoice.currency)}, which does not match the invoice's stored paid amount of ${paidLabel}. Check the invoice in the app before quoting a figure.`
        : ''

      return jsonResult({
        summary: `${invoice.invoice_number} is ${invoice.status}${overdueNote}: ${paidLabel} paid, ${dueLabel} still due.${mismatchNote}`,
        invoice: {
          id: invoice.id,
          invoice_number: invoice.invoice_number,
          status: invoice.status,
          is_overdue: overdue,
          currency: invoice.currency,
          total: invoice.total,
          amount_paid: invoice.amount_paid,
          balance_due: invoice.balance_due,
          due_date: invoice.due_date,
          paid_at: invoice.paid_at,
        },
        payments: history,
        payments_count: history.length,
        voided_count: allPayments.length - live.length,
        payments_truncated: allPayments.length === PAYMENT_HISTORY_LIMIT,
        reconciliation,
        online_payments_enabled: onlinePaymentsEnabled,
        pay_url: onlinePaymentsEnabled ? publicUrl(invoice.public_id) : null,
        public_url: publicUrl(invoice.public_id),
        app_url: `${appUrl()}/invoices/${invoice.id}`,
      })
    }
  )
  // -------------------------------------------------------------------------
  // Corrections
  // -------------------------------------------------------------------------
  // Both go through SECURITY DEFINER RPCs. The RPC,
  // not this file, owns the rules: it verifies the key's authority over the
  // payment's business, refuses Stripe-collected money, refuses an already
  // voided row, is idempotent on (payment_id, request_id), writes the audit
  // row with the before and after payment, and recomputes the invoice's
  // amount_paid, balance_due and status from the surviving live payments.
  //
  // The actor reaches the database exactly the way record_payment's does: the
  // call runs on ScopedDb's service client and carries ctx.keyId, and the RPC
  // resolves that key to its owner and checks the "payments" permission again
  // in SQL. Scope is still established here first, through
  // ctx.db.assertPaymentAccess, so an out-of-scope payment id never reaches
  // the RPC at all.
  server.registerTool(
    'update_payment',
    {
      title: 'Update Payment',
      description:
        'Correct a recorded payment: the date it landed, the method, the reference number, the notes, or the amount if a figure was keyed wrong. The invoice is recomputed from its live payments, so a smaller amount reopens a balance and moves a paid invoice back to partial. Use this to fix a payment whose date was recorded wrong, which otherwise puts the money in the wrong month of every revenue report. Payments collected through Stripe cannot be edited: a card payment is changed by issuing a refund in Stripe, which arrives back here as its own ledger entry. Fields left out are kept as they are.',
      inputSchema: z.object({
        request_id: z
          .string()
          .min(1)
          .max(200)
          .describe('Stable correction ID. Reuse on retries with identical input and the same answer comes back without applying the change twice.'),
        payment_id: z
          .string()
          .uuid()
          .describe('Id of the payment to correct, from the payments list in get_payment_status.'),
        payment_date: DATE_FIELD.optional().describe('Corrected date the payment was received, YYYY-MM-DD.'),
        method: z.enum(EDITABLE_PAYMENT_METHODS).optional().describe('Corrected payment method. "stripe" is not accepted here because only the verified Stripe flow may write card entries.'),
        notes: z.string().max(2000).optional().describe('Corrected notes about the payment.'),
        reference_number: z.string().max(100).optional().describe('Corrected reference, check or transaction number.'),
        amount: z
          .number()
          .positive()
          .optional()
          .describe('Corrected amount. Must be greater than zero and must not push the invoice past its total once the other live payments are counted.'),
      }),
    },
    async ({ request_id, payment_id, payment_date, method, notes, reference_number, amount }) => {
      let payment
      try {
        payment = await ctx.db.assertPaymentAccess(payment_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access payment.')
      }

      if (payment.source === 'stripe') {
        return errorResult(STRIPE_LOCKED)
      }

      if (
        payment_date === undefined &&
        method === undefined &&
        notes === undefined &&
        reference_number === undefined &&
        amount === undefined
      ) {
        return errorResult('Pass at least one field to change.')
      }

      const { data, error } = await ctx.db.svc.rpc('update_payment', {
        p_payment_id: payment_id,
        p_request_id: request_id,
        p_payment_date: payment_date,
        p_method: method,
        p_notes: notes,
        p_reference_number: reference_number,
        p_amount: amount,
        p_actor_key_id: ctx.keyId,
      })

      if (error || !data) {
        return errorResult(correctionError(error, 'Could not update that payment.'))
      }

      return jsonResult(correctionResult(data, 'Updated'))
    }
  )

  server.registerTool(
    'void_payment',
    {
      title: 'Void Payment',
      description:
        'Void a payment that should never have been recorded, with a reason. The row is kept and stays visible, struck through with its reason, but it stops counting as money: the invoice reopens for that amount and every total, report and list leaves it out. Use this for a payment entered twice, entered against the wrong invoice, or entered for money that never arrived. Payments collected through Stripe cannot be voided: refund the charge in Stripe instead, and the refund arrives back here as its own ledger entry.',
      inputSchema: z.object({
        request_id: z
          .string()
          .min(1)
          .max(200)
          .describe('Stable void ID. Reuse on retries with the same reason and the same answer comes back without voiding twice.'),
        payment_id: z
          .string()
          .uuid()
          .describe('Id of the payment to void, from the payments list in get_payment_status.'),
        reason: z
          .string()
          .min(1)
          .max(2000)
          .describe('Why this payment is being voided. Kept on the payment and in the audit trail, and shown in the app.'),
      }),
    },
    async ({ request_id, payment_id, reason }) => {
      let payment
      try {
        payment = await ctx.db.assertPaymentAccess(payment_id)
      } catch (err) {
        return errorResult(err instanceof ScopeError ? err.message : 'Could not access payment.')
      }
      if (payment.source === 'stripe') {
        return errorResult(STRIPE_LOCKED)
      }

      const { data, error } = await ctx.db.svc.rpc('void_payment', {
        p_payment_id: payment_id,
        p_request_id: request_id,
        p_reason: reason,
        p_actor_key_id: ctx.keyId,
      })

      if (error || !data) {
        return errorResult(correctionError(error, 'Could not void that payment.'))
      }

      return jsonResult(correctionResult(data, 'Voided'))
    }
  )
}
