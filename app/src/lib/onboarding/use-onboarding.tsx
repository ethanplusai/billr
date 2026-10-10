'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useBusiness } from '@/lib/hooks/use-business'
import { deriveChecklist, checklistProgress, type ChecklistFacts, type ChecklistStep } from '@/lib/onboarding/checklist'

export interface UseOnboardingResult {
  steps: ChecklistStep[]
  progress: { done: number; total: number; percent: number }
  isLoading: boolean
  dismissed: boolean
  dismiss: () => Promise<void>
  restore: () => Promise<void>
  refresh: () => Promise<void>
  tourCompleted: boolean
  completeTour: () => Promise<void>
  resetTour: () => Promise<void>
}

const EMPTY_STEPS: ChecklistStep[] = []

export function useOnboarding(): UseOnboardingResult {
  const { currentBusiness } = useBusiness()
  const [steps, setSteps] = useState<ChecklistStep[]>(EMPTY_STEPS)
  const [isLoading, setIsLoading] = useState(true)
  const [dismissed, setDismissed] = useState(false)
  const [tourCompletedAt, setTourCompletedAt] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!currentBusiness) {
      setSteps(EMPTY_STEPS)
      setDismissed(false)
      setTourCompletedAt(null)
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    const supabase = createClient()
    const businessId = currentBusiness.id

    try {
      const [biz, clients, invoices, sent, keys, usedKeys, state, stripe] = await Promise.all([
        supabase
          .from('businesses')
          .select('name,email,phone,address_line1,logo_url,primary_color')
          .eq('id', businessId)
          .single(),
        supabase.from('clients').select('id', { count: 'exact', head: true }).eq('business_id', businessId),
        supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('business_id', businessId),
        supabase
          .from('invoices')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', businessId)
          .not('last_sent_at', 'is', null),
        supabase
          .from('api_keys')
          .select('id', { count: 'exact', head: true })
          .is('revoked_at', null)
          .or(`business_id.is.null,business_id.eq.${businessId}`),
        supabase
          .from('api_keys')
          .select('id', { count: 'exact', head: true })
          .is('revoked_at', null)
          .not('last_used_at', 'is', null)
          .or(`business_id.is.null,business_id.eq.${businessId}`),
        supabase
          .from('onboarding_state')
          .select('dismissed_at,completed_at,tour_completed_at')
          .eq('business_id', businessId)
          .maybeSingle(),
        fetch('/api/stripe/config')
          .then((response) => (response.ok ? response.json() : { available: false }))
          .catch(() => ({ available: false })),
      ])

      const facts: ChecklistFacts = {
        businessName: biz.data?.name ?? null,
        businessEmail: biz.data?.email ?? null,
        businessPhone: biz.data?.phone ?? null,
        businessAddress1: biz.data?.address_line1 ?? null,
        logoUrl: biz.data?.logo_url ?? null,
        primaryColor: biz.data?.primary_color ?? null,
        stripeConfigured: stripe.available === true,
        clientCount: clients.count ?? 0,
        invoiceCount: invoices.count ?? 0,
        sentInvoiceCount: sent.count ?? 0,
        apiKeyCount: keys.count ?? 0,
        usedApiKeyCount: usedKeys.count ?? 0,
      }

      setSteps(deriveChecklist(facts))
      setDismissed(state.data?.dismissed_at != null)
      setTourCompletedAt(state.data?.tour_completed_at ?? null)
    } catch (error) {
      console.error('useOnboarding: failed to refresh checklist facts', error)
      // Leave previous steps/dismissed state intact on a transient failure.
    } finally {
      setIsLoading(false)
    }
  }, [currentBusiness])

  useEffect(() => {
    refresh()
  }, [refresh])

  const setDismissedAt = useCallback(
    async (value: string | null) => {
      if (!currentBusiness) return
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) return

      await supabase.from('onboarding_state').upsert(
        {
          business_id: currentBusiness.id,
          user_id: user.id,
          dismissed_at: value,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'business_id,user_id' }
      )
      setDismissed(value !== null)
    },
    [currentBusiness]
  )

  const dismiss = useCallback(() => setDismissedAt(new Date().toISOString()), [setDismissedAt])
  const restore = useCallback(() => setDismissedAt(null), [setDismissedAt])

  const setTourCompletedAtRemote = useCallback(
    async (value: string | null) => {
      if (!currentBusiness) return
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) return

      await supabase.from('onboarding_state').upsert(
        {
          business_id: currentBusiness.id,
          user_id: user.id,
          tour_completed_at: value,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'business_id,user_id' }
      )
      setTourCompletedAt(value)
    },
    [currentBusiness]
  )

  const completeTour = useCallback(
    () => setTourCompletedAtRemote(new Date().toISOString()),
    [setTourCompletedAtRemote]
  )
  const resetTour = useCallback(() => setTourCompletedAtRemote(null), [setTourCompletedAtRemote])

  return {
    steps,
    progress: checklistProgress(steps),
    isLoading,
    dismissed,
    dismiss,
    restore,
    refresh,
    tourCompleted: tourCompletedAt != null,
    completeTour,
    resetTour,
  }
}
