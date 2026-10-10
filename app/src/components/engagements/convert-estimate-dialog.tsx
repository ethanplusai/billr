'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  DEFAULT_SCHEDULE_TEMPLATES,
  expandTemplate,
  type ScheduleEntry,
  type ScheduleTemplate,
} from '@/lib/engagements/schedule'
import { DUE_RULE_LABELS } from '@/lib/engagements/types'

/**
 * Turning an accepted quote into the agreement it was quoting.
 *
 * All the person picks is the SHAPE of the schedule. The client, the total and
 * the currency are read off the estimate inside the RPC and
 * are not sent from here, so a conversion is never a place a price quietly
 * changes. The preview below is the same expansion the server does, from
 * src/lib/engagements/schedule.ts, so what is shown is what gets written.
 */
interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  estimateId: string
  total: number
  currency: string
}

export function ConvertEstimateToEngagementDialog({
  open,
  onOpenChange,
  estimateId,
  total,
  currency,
}: Props) {
  const router = useRouter()
  const [templateKey, setTemplateKey] = useState(DEFAULT_SCHEDULE_TEMPLATES[0].key)
  const [isBusy, setIsBusy] = useState(false)
  // One request id per dialog, so a double click or a retry after a dropped
  // connection is a replay rather than a second engagement.
  const requestId = useRef<string | null>(null)

  const template =
    DEFAULT_SCHEDULE_TEMPLATES.find((item) => item.key === templateKey) ??
    DEFAULT_SCHEDULE_TEMPLATES[0]

  const preview = useMemo<{ entries: ScheduleEntry[]; error: string | null }>(() => {
    try {
      return { entries: expandTemplate(template, total), error: null }
    } catch (error) {
      return { entries: [], error: error instanceof Error ? error.message : 'Cannot split that total.' }
    }
  }, [template, total])

  const money = (amount: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount)

  async function convert() {
    setIsBusy(true)
    requestId.current ??= crypto.randomUUID()
    const { convertEstimateToEngagementAction } = await import('@/lib/actions/engagements')
    const result = await convertEstimateToEngagementAction(
      estimateId,
      payloadFor(template),
      requestId.current,
    )
    setIsBusy(false)

    if ('error' in result) {
      toast.error(result.error)
      return
    }
    toast.success('Estimate turned into an engagement')
    router.push(`/engagements/${result.engagementId}`)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Turn this estimate into an engagement</DialogTitle>
          <DialogDescription>
            The agreed {money(total)} stays exactly as quoted. Pick how it will be billed, and
            Billr keeps track of what is left. Nothing is invoiced and nothing is sent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {DEFAULT_SCHEDULE_TEMPLATES.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTemplateKey(item.key)}
              className={cn(
                'w-full rounded-lg border p-3 text-left',
                item.key === templateKey ? 'border-primary bg-primary/5' : 'border-border/60',
              )}
            >
              <span className="font-medium">{item.name}</span>
            </button>
          ))}
        </div>

        <div className="rounded-lg border border-border/60 p-3">
          {preview.error ? (
            <p className="text-sm text-destructive">{preview.error}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {preview.entries.map((entry) => (
                <li key={entry.position} className="flex justify-between gap-4">
                  <span className="min-w-0 truncate text-muted-foreground">
                    {entry.label}
                    <span className="ml-2 text-xs">{DUE_RULE_LABELS[entry.due_rule]}</span>
                  </span>
                  <span className="whitespace-nowrap font-medium">{money(entry.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          The engagement is created as a draft. Start it when the work begins, which is what makes
          any deposit ready to bill.
        </p>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isBusy}>
            Cancel
          </Button>
          <Button onClick={convert} disabled={isBusy || !!preview.error}>
            Create engagement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The template as the action wants it: a shape, never an amount or a currency. */
function payloadFor(template: ScheduleTemplate) {
  return {
    billing_mode: template.billing_mode,
    entries: template.entries?.map((entry) => ({
      label: entry.label ?? undefined,
      percent: entry.percent ?? undefined,
      due_rule: entry.due_rule ?? undefined,
    })),
    installments: template.installments,
  }
}
