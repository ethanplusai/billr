'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, ChevronDown, Circle, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useBusiness } from '@/lib/hooks/use-business'
import { useOnboarding } from '@/lib/onboarding/use-onboarding'
import type { ChecklistStep } from '@/lib/onboarding/checklist'

function ProgressTrack({ percent }: { percent: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}

function StepRow({ step }: { step: ChecklistStep }) {
  return (
    <li>
      <Link
        href={step.href}
        className="group flex items-start gap-3 rounded-md px-2 py-2 -mx-2 transition-colors hover:bg-accent"
      >
        {step.done ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        ) : (
          <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="flex flex-col">
          <span
            className={cn(
              'text-sm font-medium',
              step.done
                ? 'text-muted-foreground line-through'
                : 'text-foreground',
            )}
          >
            {step.label}
          </span>
          {step.hint && !step.done && (
            <span className="text-xs text-muted-foreground">{step.hint}</span>
          )}
        </span>
      </Link>
    </li>
  )
}

/**
 * Slim, self-hiding setup progress bar. Mounted once in the app shell above
 * page content. Hides itself once onboarding is complete, dismissed, or
 * there is no business/loading state to report on.
 */
export function SetupProgress() {
  const { currentBusiness } = useBusiness()
  const { steps, progress, isLoading, dismissed, dismiss } = useOnboarding()
  const [expanded, setExpanded] = useState(false)
  const [phase, setPhase] = useState<
    'active' | 'complete' | 'closing' | 'retired'
  >('active')
  const [everIncomplete, setEverIncomplete] = useState(false)

  const isComplete = progress.total > 0 && progress.done === progress.total

  // These flags derive from loaded progress and are adjusted during render.
  if (!isLoading && !isComplete && !everIncomplete) setEverIncomplete(true)
  if (!isLoading && everIncomplete && isComplete && phase === 'active')
    setPhase('complete')

  useEffect(() => {
    if (phase !== 'complete') return
    const timer = setTimeout(() => setPhase('closing'), 1800)
    return () => clearTimeout(timer)
  }, [phase])

  useEffect(() => {
    if (phase !== 'closing') return
    const timer = setTimeout(() => setPhase('retired'), 300)
    return () => clearTimeout(timer)
  }, [phase])

  if (isLoading || !currentBusiness || dismissed || phase === 'retired') {
    return null
  }

  if (steps.length === 0 || progress.total === 0) {
    return null
  }

  if (isComplete && phase === 'active') {
    return null
  }

  if (phase === 'complete' || phase === 'closing') {
    return (
      <div
        data-tour="setup"
        data-setup-progress
        className={cn(
          'border-b bg-background px-4 py-3 transition-opacity duration-300 motion-reduce:transition-none sm:px-6 lg:px-8',
          phase === 'closing' ? 'opacity-0' : 'opacity-100',
        )}
      >
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <CheckCircle2 className="h-4 w-4 text-success" />
          Setup complete
        </div>
      </div>
    )
  }

  return (
    <div
      className="border-b bg-background px-4 py-3 sm:px-6 lg:px-8"
      data-tour="setup"
      data-setup-progress
    >
      <div className="flex items-center gap-4">
        <div className="flex-1">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-foreground">
              Getting started · {progress.done} of {progress.total} complete
            </span>
          </div>
          <div className="mt-1.5">
            <ProgressTrack percent={progress.percent} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={
              expanded ? 'Collapse setup checklist' : 'Expand setup checklist'
            }
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                'h-4 w-4 transition-transform duration-200 motion-reduce:transition-none',
                expanded && 'rotate-180',
              )}
            />
          </button>
          <button
            type="button"
            onClick={() => {
              dismiss().catch((error) =>
                console.error(
                  'SetupProgress: failed to dismiss checklist',
                  error,
                ),
              )
            }}
            aria-label="Dismiss setup checklist"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {expanded && (
        <ul className="mt-3 space-y-0.5 border-t pt-3 animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ul>
      )}
    </div>
  )
}

