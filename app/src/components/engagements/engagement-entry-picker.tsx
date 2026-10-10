'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Handshake } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { todayISO } from '@/lib/dates'
import type { LineItemFormData } from '@/lib/validations/invoice'

/**
 * "From engagements": the schedule entries this client has agreed and that are
 * ready to bill right now, offered as checkboxes on the new invoice page.
 *
 * Ticking one writes a PREVIEW line into the form so the person sees the
 * description and the total they are about to send. That preview is not what
 * gets billed: on submit the page strips these lines back out and passes the
 * entry ids to create_invoice instead, and the database rebuilds the lines
 * from each entry's own agreed amount inside the same transaction that marks
 * the entry invoiced. A number typed over in the browser
 * therefore cannot change what the client is charged, and an entry cannot end
 * up on two invoices.
 */

/** Marks a line item as standing in for an engagement entry, not typed by hand. */
const ENGAGEMENT_LINE_PREFIX = 'engagement:'

function engagementLineId(entryId: string): string {
  return `${ENGAGEMENT_LINE_PREFIX}${entryId}`
}

/** The entry ids behind the preview lines currently in the form. */
export function engagementEntryIdsOf(lineItems: LineItemFormData[]): string[] {
  return lineItems
    .filter((item) => item.id.startsWith(ENGAGEMENT_LINE_PREFIX))
    .map((item) => item.id.slice(ENGAGEMENT_LINE_PREFIX.length))
}

/** The lines a person actually typed, which are the only ones sent as lines. */
export function typedLineItemsOf(lineItems: LineItemFormData[]): LineItemFormData[] {
  return lineItems.filter((item) => !item.id.startsWith(ENGAGEMENT_LINE_PREFIX))
}

export interface ReadyEntry {
  id: string
  label: string
  amount: number
  due_rule: string
  due_on: string | null
  engagement_id: string
  engagement_name: string
  engagement_currency: string
}

interface Props {
  businessId: string
  /** The client the invoice is for. No client picked means nothing to offer. */
  clientId: string
  /** The invoice currency. An engagement in another one cannot be billed here. */
  currency: string
  lineItems: LineItemFormData[]
  setLineItems: (items: LineItemFormData[]) => void
  /** Entry ids to tick on first load, from the ?engagement_entries= query. */
  preselected?: string[]
}

export function EngagementEntryPicker({
  businessId,
  clientId,
  currency,
  lineItems,
  setLineItems,
  preselected = [],
}: Props) {
  const [entries, setEntries] = useState<ReadyEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [applied, setApplied] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!businessId || !clientId) {
        setEntries([])
        setIsLoading(false)
        return
      }

      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()

      // Same read path sweep the engagement pages run: an entry whose date has
      // passed becomes billable when somebody looks, not on a cron.
      await supabase.rpc('promote_due_entries', { p_business_id: businessId })

      const { data } = await supabase
        .from('engagement_entries')
        .select(
          'id, label, amount, due_rule, due_on, engagement_id, engagement:engagements(name, currency, client_id, status)',
        )
        .eq('business_id', businessId)
        .eq('status', 'ready_to_bill')
        .order('due_on', { ascending: true })

      if (cancelled) return

      type Row = Omit<ReadyEntry, 'engagement_name' | 'engagement_currency'> & {
        engagement: { name: string; currency: string; client_id: string; status: string } | null
      }

      setEntries(
        ((data ?? []) as unknown as Row[])
          // A draft or cancelled engagement is not billable, and the database
          // refuses it anyway; not offering it is just honesty up front.
          .filter(
            (row) =>
              row.engagement &&
              row.engagement.client_id === clientId &&
              row.engagement.status !== 'draft' &&
              row.engagement.status !== 'cancelled',
          )
          .map((row) => ({
            id: row.id,
            label: row.label,
            amount: row.amount,
            due_rule: row.due_rule,
            due_on: row.due_on,
            engagement_id: row.engagement_id,
            engagement_name: row.engagement?.name ?? '',
            engagement_currency: row.engagement?.currency ?? currency,
          })),
      )
      setIsLoading(false)
    }

    setIsLoading(true)
    load()
    return () => {
      cancelled = true
    }
    // currency is read inside but must not re-fetch: it only affects display.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, clientId])

  const selected = useMemo(() => new Set(engagementEntryIdsOf(lineItems)), [lineItems])

  const toggle = useCallback(
    (entry: ReadyEntry, next: boolean) => {
      const withoutEntry = lineItems.filter((item) => item.id !== engagementLineId(entry.id))
      if (!next) {
        setLineItems(withoutEntry.length > 0 ? withoutEntry : lineItems)
        return
      }

      const line: LineItemFormData = {
        id: engagementLineId(entry.id),
        // Spelled exactly the way the invoicing RPC spells it, so the preview
        // and the invoice that gets written read the same.
        description: `${entry.engagement_name}: ${entry.label}`,
        quantity: 1,
        rate: entry.amount,
        amount: entry.amount,
        tax_rate: 0,
        tax_amount: 0,
        discount_percent: 0,
        discount_amount: 0,
      }

      // Drop the blank line the form starts with, so billing only an
      // engagement does not leave an empty row failing validation.
      const kept = withoutEntry.filter(
        (item) => item.description.trim().length > 0 || item.rate > 0,
      )
      setLineItems([...kept, line])
    },
    [lineItems, setLineItems],
  )

  // Anything handed in through the query string is ticked once, after the
  // entries are known. Re-running it would fight the person unticking a box.
  useEffect(() => {
    if (applied || isLoading || entries.length === 0 || preselected.length === 0) return
    setApplied(true)
    const wanted = new Set(preselected)
    let next = lineItems
    for (const entry of entries) {
      if (!wanted.has(entry.id) || next.some((item) => item.id === engagementLineId(entry.id))) {
        continue
      }
      if (entry.engagement_currency !== currency) continue
      next = [
        ...next.filter((item) => item.description.trim().length > 0 || item.rate > 0),
        {
          id: engagementLineId(entry.id),
          description: `${entry.engagement_name}: ${entry.label}`,
          quantity: 1,
          rate: entry.amount,
          amount: entry.amount,
          tax_rate: 0,
          tax_amount: 0,
          discount_percent: 0,
          discount_amount: 0,
        },
      ]
    }
    if (next !== lineItems) setLineItems(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied, isLoading, entries, preselected, currency])

  if (!clientId || (!isLoading && entries.length === 0)) return null

  const money = (amount: number, code: string) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: code || 'USD' }).format(amount)

  const today = todayISO()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Handshake className="h-4 w-4" />
          From engagements
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-muted-foreground">
          Agreed work for this client that is ready to bill. Ticking one adds it as a line and
          marks that part of the schedule invoiced when you save, so it cannot be billed twice.
        </p>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <div className="space-y-2">
            {entries.map((entry) => {
              const wrongCurrency = entry.engagement_currency !== currency
              const overdue =
                entry.due_rule === 'on_date' && !!entry.due_on && entry.due_on <= today
              return (
                <label
                  key={entry.id}
                  className="flex items-start gap-3 rounded-lg border border-border/60 p-3"
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={selected.has(entry.id)}
                    disabled={wrongCurrency}
                    onCheckedChange={(value) => toggle(entry, value === true)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{entry.label}</span>
                      <Link
                        href={`/engagements/${entry.engagement_id}`}
                        className="text-sm text-muted-foreground hover:text-primary"
                      >
                        {entry.engagement_name}
                      </Link>
                      {overdue && (
                        <Badge className="bg-amber-100 text-amber-700">
                          Due {entry.due_on}
                        </Badge>
                      )}
                    </span>
                    {wrongCurrency && (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Agreed in {entry.engagement_currency}. Set the invoice to that currency to
                        bill it; Billr never converts money on its own.
                      </span>
                    )}
                  </span>
                  <span className="whitespace-nowrap font-medium">
                    {money(entry.amount, entry.engagement_currency)}
                  </span>
                </label>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
