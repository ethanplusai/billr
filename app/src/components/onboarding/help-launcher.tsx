'use client'

import { useState } from 'react'
import { HelpCircle, RotateCcw, ListChecks, BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DOCS_URL } from '@/lib/deployment'
import type { UseOnboardingResult } from '@/lib/onboarding/use-onboarding'

interface HelpLauncherProps {
  onboarding: UseOnboardingResult
}

/**
 * Fixed bottom-right help button. Gives users a way back into the
 * first-run tour and the setup checklist after they have dismissed them,
 * plus a link to the documentation.
 */
export function HelpLauncher({ onboarding }: HelpLauncherProps) {
  const [open, setOpen] = useState(false)

  const handleRestartTour = () => {
    setOpen(false)
    onboarding.resetTour().catch((error) => console.error('HelpLauncher: failed to reset tour', error))
  }

  const handleShowChecklist = () => {
    setOpen(false)
    onboarding.restore().catch((error) => console.error('HelpLauncher: failed to restore checklist', error))
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="icon-lg"
            aria-label="Help"
            className="no-print fixed bottom-6 right-6 z-40 rounded-full shadow-lg"
          >
            <HelpCircle className="h-5 w-5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" side="top" className="w-64 p-1">
          <div className="flex flex-col">
            <button
              type="button"
              onClick={handleRestartTour}
              className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
            >
              <RotateCcw className="h-4 w-4 text-muted-foreground" />
              Restart the walkthrough
            </button>
            <button
              type="button"
              onClick={handleShowChecklist}
              className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
            >
              <ListChecks className="h-4 w-4 text-muted-foreground" />
              Show setup checklist
            </button>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
            >
              <BookOpen className="h-4 w-4 text-muted-foreground" />
              Docs
            </a>
          </div>
        </PopoverContent>
      </Popover>
    </>
  )
}
