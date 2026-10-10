'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useBusiness } from '@/lib/hooks/use-business'
import type { UseOnboardingResult } from '@/lib/onboarding/use-onboarding'

interface TourStepDef {
  id: string
  selector: string
  title: string
  body: string
  placement: 'right' | 'bottom'
}

const TOUR_STEPS: TourStepDef[] = [
  {
    id: 'nav',
    selector: '[data-tour="nav"]',
    title: 'Your workspace',
    body: 'Everything you need to run your business lives in this sidebar.',
    placement: 'right',
  },
  {
    id: 'dashboard',
    selector: '[data-tour="dashboard"]',
    title: 'Daily snapshot',
    body: 'Your dashboard opens on what needs attention today: money owed to you, invoices going overdue, and what you have earned this month.',
    placement: 'right',
  },
  {
    id: 'clients',
    selector: '[data-tour="clients"]',
    title: 'Your clients',
    body: 'Keep contact details, billing addresses, and payment terms in one place. Everything you bill starts by picking a client here.',
    placement: 'right',
  },
  {
    id: 'invoices',
    selector: '[data-tour="invoices"]',
    title: 'Invoices',
    body: 'Build an invoice, send it as a payable link, and let automatic reminders chase the late ones so you do not have to.',
    placement: 'right',
  },
  {
    id: 'estimates',
    selector: '[data-tour="estimates"]',
    title: 'Estimates and quotes',
    body: 'Send a quote before the work starts and get it approved in writing. Once a client accepts, convert it to an invoice in one click.',
    placement: 'right',
  },
  {
    id: 'items',
    selector: '[data-tour="items"]',
    title: 'Saved items',
    body: 'Store the services and products you bill again and again, with rates and tax already set, so new invoices take seconds to fill in.',
    placement: 'right',
  },
  {
    id: 'time',
    selector: '[data-tour="time"]',
    title: 'Time tracking',
    body: 'Log billable hours against a client or project as you work. Unbilled time drops straight onto your next invoice.',
    placement: 'right',
  },
  {
    id: 'expenses',
    selector: '[data-tour="expenses"]',
    title: 'Expenses',
    body: 'Record costs and their vendors. Mark an expense billable to rebill it to the client, and keep the rest for your books at tax time.',
    placement: 'right',
  },
  {
    id: 'payments',
    selector: '[data-tour="payments"]',
    title: 'Getting paid',
    body: 'Clients pay by card or bank transfer and the money lands in your own Stripe account. Billr takes 0% on top of what you collect.',
    placement: 'right',
  },
  {
    id: 'reports',
    selector: '[data-tour="reports"]',
    title: 'Reports',
    body: 'See revenue over time, who your best clients are, and what is still outstanding. Export the numbers when your accountant asks.',
    placement: 'right',
  },
  {
    id: 'agents',
    selector: '[data-tour="agents"]',
    title: 'Your agents',
    body: 'Connect an AI assistant and it can add clients, draft and send invoices, log time and expenses, and record payments for you. This is the busywork you stop doing.',
    placement: 'right',
  },
  {
    id: 'settings',
    selector: '[data-tour="settings"]',
    title: 'Settings',
    body: 'Set your business details, logo, tax rates, and payment options here. Do this once and every document you send looks right.',
    placement: 'right',
  },
  {
    id: 'setup',
    selector: '[data-tour="setup"]',
    title: 'Track your setup',
    body: 'This bar shows what is left before your account is fully set up.',
    placement: 'bottom',
  },
]

const GAP = 12
const POPOVER_WIDTH = 288
// Bodies run to a couple of sentences and the popover now carries a step
// counter and progress bar, so the estimate used for placement is taller
// than the original single-line layout.
const POPOVER_EST_HEIGHT = 210
const SPOTLIGHT_PADDING = 6

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(
    (notify) => { const mq=window.matchMedia('(prefers-reduced-motion: reduce)'); mq.addEventListener('change',notify); return ()=>mq.removeEventListener('change',notify) },
    ()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    ()=>false
  )
}

interface PopoverPosition {
  top: number
  left: number
}

/**
 * Places the popover adjacent to the anchor's bounding rect, preferring the
 * given side, clamped to the viewport, and flipping to whichever side
 * actually has room so the popover never covers the anchor and never runs
 * off-screen.
 */
function computePosition(rect: DOMRect, preferred: 'right' | 'bottom'): PopoverPosition {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight

  // Center on the visible portion of the anchor, not its full (possibly
  // off-screen) extent, so tall anchors like the sidebar nav don't push the
  // popover toward the very top of the page.
  const visibleTop = Math.max(rect.top, 0)
  const visibleBottom = Math.min(rect.bottom, viewportHeight)
  const anchorCenterY = (visibleTop + visibleBottom) / 2
  const anchorCenterX = rect.left + rect.width / 2

  const candidates: Record<'right' | 'left' | 'bottom' | 'top', { top: number; left: number; fits: boolean }> = {
    right: {
      left: rect.right + GAP,
      top: clamp(anchorCenterY - POPOVER_EST_HEIGHT / 2, GAP, viewportHeight - POPOVER_EST_HEIGHT - GAP),
      fits: rect.right + GAP + POPOVER_WIDTH <= viewportWidth - GAP,
    },
    left: {
      left: rect.left - GAP - POPOVER_WIDTH,
      top: clamp(anchorCenterY - POPOVER_EST_HEIGHT / 2, GAP, viewportHeight - POPOVER_EST_HEIGHT - GAP),
      fits: rect.left - GAP - POPOVER_WIDTH >= GAP,
    },
    bottom: {
      top: rect.bottom + GAP,
      left: clamp(anchorCenterX - POPOVER_WIDTH / 2, GAP, viewportWidth - POPOVER_WIDTH - GAP),
      fits: rect.bottom + GAP + POPOVER_EST_HEIGHT <= viewportHeight - GAP,
    },
    top: {
      top: rect.top - GAP - POPOVER_EST_HEIGHT,
      left: clamp(anchorCenterX - POPOVER_WIDTH / 2, GAP, viewportWidth - POPOVER_WIDTH - GAP),
      fits: rect.top - GAP - POPOVER_EST_HEIGHT >= GAP,
    },
  }

  const order: Array<'right' | 'left' | 'bottom' | 'top'> =
    preferred === 'right' ? ['right', 'bottom', 'left', 'top'] : ['bottom', 'right', 'left', 'top']

  const chosen = order.find((side) => candidates[side].fits) ?? preferred
  const { top, left } = candidates[chosen]

  return {
    top: clamp(top, GAP, viewportHeight - POPOVER_EST_HEIGHT - GAP),
    left: clamp(left, GAP, viewportWidth - POPOVER_WIDTH - GAP),
  }
}

interface TourProps {
  onboarding: UseOnboardingResult
}

/**
 * Hand-rolled, anchored first-run tour. Positions a small popover next to
 * real UI elements (found via data-tour attributes) rather than a scripted
 * modal overlay, with a dimmed spotlight around the anchor so the popover
 * reads as attached to it. Auto-opens once per account and never reopens on
 * its own after the user finishes or skips it.
 */
export function Tour({ onboarding }: TourProps) {
  const { currentBusiness } = useBusiness()
  const { isLoading, tourCompleted, completeTour } = onboarding
  const [open, setOpen] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)
  const [availableSteps, setAvailableSteps] = useState<TourStepDef[]>([])
  const [rect, setRect] = useState<DOMRect | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const reducedMotion = usePrefersReducedMotion()

  const finish = useCallback(() => {
    setOpen(false)
    completeTour().catch((error) => console.error('Tour: failed to persist completion', error))
  }, [completeTour])

  // Decide whether to auto-open once loading settles. Only steps whose
  // anchor actually exists in the DOM are included; if none exist, skip.
  useEffect(() => {
    if (isLoading || !currentBusiness || tourCompleted) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Synchronize tour visibility with mounted DOM anchors.
      setOpen(false)
      return
    }
    if (typeof document === 'undefined') return
    // An anchor inside the hidden desktop sidebar exists but has no box on mobile.
    const found = TOUR_STEPS.filter(
      (step) =>
        (document.querySelector(step.selector)?.getClientRects().length ?? 0) > 0,
    )
    if (found.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Synchronize tour visibility with mounted DOM anchors.
      setOpen(false)
      return
    }
    setAvailableSteps(found)
    setStepIndex(0)
    setOpen(true)
  }, [isLoading, currentBusiness, tourCompleted])

  const currentStep = availableSteps[stepIndex]

  const measure = useCallback(() => {
    if (!currentStep) {
      setRect(null)
      return
    }
    const el = document.querySelector(currentStep.selector)
    if (!el) {
      setRect(null)
      return
    }
    setRect(el.getBoundingClientRect())
  }, [currentStep])

  // The sidebar nav scrolls, so anchors near the bottom of a long list can
  // sit outside the visible area. Bring the anchor into view before measuring
  // it; the scroll listener below re-measures once the scroll settles.
  useEffect(() => {
    if (!open || !currentStep) return
    const el = document.querySelector(currentStep.selector)
    if (!el) return
    el.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' })
  }, [open, currentStep, reducedMotion])

  useLayoutEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Layout measurement must run after DOM commit.
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, measure])

  // If the current step's anchor disappears mid-tour, skip forward
  // instead of crashing or getting stuck.
  useEffect(() => {
    if (!open || !currentStep) return
    if (!document.querySelector(currentStep.selector)) {
      if (stepIndex < availableSteps.length - 1) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- Skip an anchor removed from the DOM.
        setStepIndex((i) => i + 1)
      } else {
        finish()
      }
    }
  }, [open, currentStep, stepIndex, availableSteps.length, finish])

  // Focus trap: move focus into the popover and cycle Tab within it.
  // Escape closes the tour, which counts as a skip.
  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    const container = containerRef.current
    const focusables = container
      ? Array.from(
          container.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        )
      : []
    // Focus the dialog container itself rather than the first control
    // (the close button) so opening the tour doesn't paint a stray-looking
    // focus ring on it; Tab still cycles through the real controls below.
    container?.focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        finish()
        return
      }
      if (e.key === 'Tab' && focusables.length > 0) {
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus?.()
    }
  }, [open, stepIndex, finish])

  if (!open || !currentStep || !rect || typeof document === 'undefined') return null

  const isFirst = stepIndex === 0
  const isLast = stepIndex === availableSteps.length - 1
  const { top, left } = computePosition(rect, currentStep.placement)

  return createPortal(
    <>
      {/* Spotlight: dims the rest of the page while leaving the anchor
          rect itself untouched, via a single transparent box whose
          box-shadow doubles as a highlight ring plus the dimmed backdrop. */}
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none fixed z-30 rounded-lg',
          !reducedMotion && 'transition-all duration-200 ease-out motion-reduce:transition-none'
        )}
        style={{
          top: rect.top - SPOTLIGHT_PADDING,
          left: rect.left - SPOTLIGHT_PADDING,
          width: rect.width + SPOTLIGHT_PADDING * 2,
          height: rect.height + SPOTLIGHT_PADDING * 2,
          boxShadow: '0 0 0 2px var(--ring), 0 0 0 9999px rgba(15, 23, 42, 0.45)',
        }}
      />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-step-title"
        aria-describedby="tour-step-body"
        tabIndex={-1}
        className="fixed z-40 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg outline-none"
        style={{ top, left, width: POPOVER_WIDTH }}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {stepIndex + 1} of {availableSteps.length}
            </p>
            <h2 id="tour-step-title" className="mt-0.5 text-sm font-semibold">
              {currentStep.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={finish}
            aria-label="Close tour"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p id="tour-step-body" className="mt-1.5 text-sm text-muted-foreground">
          {currentStep.body}
        </p>
        <div
          role="progressbar"
          aria-label="Tour progress"
          aria-valuemin={1}
          aria-valuemax={availableSteps.length}
          aria-valuenow={stepIndex + 1}
          className="mt-3 h-1 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              'h-full rounded-full bg-primary',
              !reducedMotion && 'transition-[width] duration-200 ease-out motion-reduce:transition-none'
            )}
            style={{ width: `${((stepIndex + 1) / availableSteps.length) * 100}%` }}
          />
        </div>
        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            onClick={finish}
            className="text-xs font-medium text-muted-foreground underline-offset-2 hover:underline"
          >
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            {!isFirst && (
              <Button type="button" variant="outline" size="sm" onClick={() => setStepIndex((i) => i - 1)}>
                Back
              </Button>
            )}
            <Button type="button" size="sm" onClick={() => (isLast ? finish() : setStepIndex((i) => i + 1))}>
              {isLast ? 'Finish' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </>,
    document.body
  )
}
