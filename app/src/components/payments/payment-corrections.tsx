'use client'

/**
 * Edit and Void controls for one recorded payment, shared by the Payments page
 * and the invoice page so both offer the same correction with the same rules.
 *
 * Both actions go through the server actions in src/lib/actions/payments.ts,
 * which call the SECURITY DEFINER RPCs
 * update_payment and void_payment. The RPCs own every
 * other rule: membership, the refusal of Stripe-collected money, the refusal of
 * an already voided row, idempotency on (payment_id, request_id), the audit
 * row, and recomputing the invoice's amount_paid, balance_due and status.
 * Nothing here writes to `payments` or `invoices` directly.
 *
 * Stripe-collected payments are disabled rather than hidden, with the reason on
 * hover, so it is obvious that the control exists and why it is unavailable.
 */

import { useRef, useState } from 'react'
import { format } from 'date-fns'
import { toast } from 'sonner'
import { CalendarIcon, Ban, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Calendar } from '@/components/ui/calendar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { paymentMethods } from '@/lib/constants'
import { updatePaymentAction, voidPaymentAction } from '@/lib/actions/payments'
import { STRIPE_LOCKED_MESSAGE } from '@/lib/payments/messages'
import { parseDay, toISODate } from '@/lib/dates'
import type { Payment } from '@/types'

/** Only the verified Stripe flow may write a card entry, so it is not offered. */
const EDITABLE_METHODS = paymentMethods.filter((method) => method.value !== 'stripe')

export function isStripeSourced(payment: Pick<Payment, 'source' | 'stripe_payment_id' | 'payment_method'>): boolean {
  if (payment.source) return payment.source === 'stripe'
  return !!payment.stripe_payment_id || payment.payment_method === 'stripe'
}

interface PaymentCorrectionsProps {
  payment: Payment
  /** Called after a successful correction so the caller can refetch. */
  onChanged: () => void | Promise<void>
}

export function PaymentCorrections({ payment, onChanged }: PaymentCorrectionsProps) {
  const [editOpen, setEditOpen] = useState(false)
  const [voidOpen, setVoidOpen] = useState(false)
  const stripeSourced = isStripeSourced(payment)
  const voided = !!payment.voided_at
  const disabled = stripeSourced || voided
  const reason = stripeSourced
    ? STRIPE_LOCKED_MESSAGE
    : voided
      ? 'This payment is already voided.'
      : undefined

  return (
    <div className="flex items-center justify-end gap-1">
      <span title={reason}>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => setEditOpen(true)}
          aria-label="Edit payment"
        >
          <Pencil className="mr-1 h-3.5 w-3.5" />
          Edit
        </Button>
      </span>
      <span title={reason}>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => setVoidOpen(true)}
          aria-label="Void payment"
        >
          <Ban className="mr-1 h-3.5 w-3.5" />
          Void
        </Button>
      </span>
      <EditPaymentDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        payment={payment}
        onChanged={onChanged}
      />
      <VoidPaymentDialog
        open={voidOpen}
        onOpenChange={setVoidOpen}
        payment={payment}
        onChanged={onChanged}
      />
    </div>
  )
}

interface DialogProps extends PaymentCorrectionsProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function EditPaymentDialog({ open, onOpenChange, payment, onChanged }: DialogProps) {
  const [date, setDate] = useState<Date>(parseDay(payment.payment_date))
  const [method, setMethod] = useState<string>(payment.payment_method)
  const [reference, setReference] = useState(payment.reference_number ?? '')
  const [notes, setNotes] = useState(payment.notes ?? '')
  const [amount, setAmount] = useState(String(payment.amount))
  const [saving, setSaving] = useState(false)
  // One request id per open dialog, so a double submit or a retry after a
  // network blip replays the same correction instead of applying a second one.
  const requestId = useRef<string | null>(null)

  async function save() {
    const parsedAmount = Number(amount)
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      toast.error('The amount must be greater than zero.')
      return
    }

    setSaving(true)
    try {
      const result = await updatePaymentAction(
        payment.id,
        {
          payment_date: toISODate(date),
          method,
          notes: notes.trim() || null,
          reference_number: reference.trim() || null,
          amount: parsedAmount,
        },
        (requestId.current ??= crypto.randomUUID()),
      )

      if ('error' in result) {
        toast.error(result.error)
        return
      }

      toast.success('Payment updated')
      onOpenChange(false)
      await onChanged()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit payment</DialogTitle>
          <DialogDescription>
            Corrects what was recorded. The invoice total paid, balance and status are recalculated from
            the payments that are still live.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Payment date</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full justify-start font-normal">
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {format(date, 'MMMM d, yyyy')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={date} onSelect={(d) => d && setDate(d)} />
              </PopoverContent>
            </Popover>
          </div>

          <div className="space-y-2">
            <Label htmlFor="payment-amount">Amount</Label>
            <Input
              id="payment-amount"
              type="number"
              step="0.01"
              min="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a method" />
              </SelectTrigger>
              <SelectContent>
                {EDITABLE_METHODS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="payment-reference">Reference</Label>
            <Input
              id="payment-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Check or transaction number"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="payment-notes">Notes</Label>
            <Textarea id="payment-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving...' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function VoidPaymentDialog({ open, onOpenChange, payment, onChanged }: DialogProps) {
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)
  const requestId = useRef<string | null>(null)

  async function submit() {
    if (!reason.trim()) {
      toast.error('Enter a reason for voiding this payment.')
      return
    }
    if (!confirmed) {
      setConfirmed(true)
      return
    }

    setSaving(true)
    try {
      const result = await voidPaymentAction(
        payment.id,
        reason.trim(),
        (requestId.current ??= crypto.randomUUID()),
      )

      if ('error' in result) {
        toast.error(result.error)
        return
      }

      toast.success('Payment voided')
      onOpenChange(false)
      await onChanged()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setConfirmed(false)
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Void this payment</DialogTitle>
          <DialogDescription>
            The payment stays on the record, struck through with your reason, but it stops counting as
            money. The invoice reopens for this amount and it leaves every total and report.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="void-reason">Reason</Label>
          <Textarea
            id="void-reason"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value)
              setConfirmed(false)
            }}
            rows={3}
            placeholder="Recorded twice, wrong invoice, money never arrived..."
          />
        </div>

        {confirmed && (
          <p className="text-sm font-medium text-destructive">
            Voiding reopens the balance on this invoice. Press Void payment again to confirm.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} disabled={saving}>
            {saving ? 'Voiding...' : confirmed ? 'Yes, void payment' : 'Void payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
