'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Clock } from 'lucide-react'
import { PageHeader } from '@/components/shared/page-header'
import { TimeEntryForm, type TimeEntryFormData } from '@/components/time/time-entry-form'
import { EmptyState } from '@/components/shared/empty-state'
import { useBusiness } from '@/lib/hooks/use-business'
import type { TimeEntry, Client } from '@/types'

import { toast } from 'sonner'
import { toISODate } from '@/lib/dates'
import { updateTimeEntryAction } from '@/lib/actions/time'

export default function EditTimeEntryPage() {
  const params = useParams()
  const router = useRouter()
  const entryId = params.id as string
  const { currentBusiness } = useBusiness()
  const [entry, setEntry] = useState<TimeEntry | null>(null)
  const [clients, setClients] = useState<Client[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    async function fetchData() {
      if (!currentBusiness) return

      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()

      const [entryRes, clientsRes] = await Promise.all([
        supabase.from('time_entries').select('*').eq('id', entryId).single(),
        supabase
          .from('clients')
          .select('*')
          .eq('business_id', currentBusiness.id)
          .eq('is_active', true)
          .order('name'),
      ])

      if (entryRes.data) setEntry(entryRes.data as TimeEntry)
      if (clientsRes.data) setClients(clientsRes.data)
      setIsLoading(false)
    }

    fetchData()
  }, [entryId, currentBusiness])

  async function handleSubmit(data: TimeEntryFormData) {
    if (!entry) return
    if (entry.invoice_id) {
      toast.error('Invoiced work cannot be edited. Create a correcting entry instead.')
      return
    }

    const result = await updateTimeEntryAction(entryId, {
      client_id: data.client_id || null,
      description: data.description,
      hours: data.hours,
      rate: data.rate,
      date: toISODate(data.date),
      is_billable: data.is_billable,
      project_name: data.project_name || null,
    })

    if ('error' in result) {
      toast.error(result.error)
      return
    }
    router.push('/time')
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  if (!entry) {
    return (
      <div className="p-6 lg:p-8">
        <EmptyState
          icon={Clock}
          title="Time entry not found"
          description="The time entry you're looking for doesn't exist."
          action={{ label: 'Back to Time Tracking', href: '/time' }}
        />
      </div>
    )
  }

  return (
    <div className="p-6 lg:p-8">
      <PageHeader
        title="Edit Time Entry"
        description="Update this time entry"
      />

      <div className="mt-6 max-w-2xl">
        <TimeEntryForm
          currency={currentBusiness?.default_currency}
          entry={entry}
          clients={clients}
          onSubmit={handleSubmit}
          onCancel={() => router.back()}
        />
      </div>
    </div>
  )
}

