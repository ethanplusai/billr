'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { PageHeader } from '@/components/shared/page-header'
import { TimeEntryForm, type TimeEntryFormData } from '@/components/time/time-entry-form'
import { useBusiness } from '@/lib/hooks/use-business'
import type { Client } from '@/types'

import { toast } from 'sonner'
import { toISODate } from '@/lib/dates'
import { createTimeEntryAction } from '@/lib/actions/time'

export default function NewTimeEntryPage() {
  const router = useRouter()
  const { currentBusiness } = useBusiness()
  const [clients, setClients] = useState<Client[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    async function fetchClients() {
      if (!currentBusiness) return

      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      const { data } = await supabase
        .from('clients')
        .select('*')
        .eq('business_id', currentBusiness.id)
        .eq('is_active', true)
        .order('name')

      if (data) {
        setClients(data)
      }
      setIsLoading(false)
    }

    fetchClients()
  }, [currentBusiness])

  const requestId=useRef<string|null>(null)
  async function handleSubmit(data: TimeEntryFormData) {
    if (!currentBusiness) return

    const result = await createTimeEntryAction(
      currentBusiness.id,
      {
        client_id: data.client_id || null,
        description: data.description,
        hours: data.hours,
        rate: data.rate,
        date: toISODate(data.date),
        is_billable: data.is_billable,
        project_name: data.project_name || null,
      },
      (requestId.current ??= crypto.randomUUID()),
    )

    if ('error' in result) {
      toast.error(result.error)
      return
    }
    router.push('/time')
  }

  if (!currentBusiness || isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="p-6 lg:p-8">
      <PageHeader
        title="Log Time"
        description="Record time spent on work"
      />

      <div className="mt-6 max-w-2xl">
        <TimeEntryForm
          currency={currentBusiness?.default_currency}
          clients={clients}
          onSubmit={handleSubmit}
          onCancel={() => router.back()}
        />
      </div>
    </div>
  )
}

