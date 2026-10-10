'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Building2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { ClientForm } from '@/components/clients/client-form'
import { useBusiness } from '@/lib/hooks/use-business'
import type { Client } from '@/types'
import type { ClientFormData } from '@/lib/validations/client'

export default function EditClientPage() {
  const params = useParams()
  const router = useRouter()
  const clientId = params.id as string
  const { currentBusiness } = useBusiness()
  const [client, setClient] = useState<Client | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    async function fetchClient() {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()

      const { data } = await supabase
        .from('clients')
        .select('*')
        .eq('id', clientId)
        .single()

      if (data) {
        setClient(data)
      }
      setIsLoading(false)
    }

    fetchClient()
  }, [clientId])

  async function handleSubmit(data: ClientFormData) {
    if (!currentBusiness) return

    const { updateClientAction } = await import('@/lib/actions/clients')
    await updateClientAction(clientId, data)
    router.push(`/clients/${clientId}`)
  }

  if (!currentBusiness || isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  if (!client) {
    return (
      <div className="p-6 lg:p-8">
        <EmptyState
          icon={Building2}
          title="Client not found"
          description="The client you're looking for doesn't exist."
          action={{ label: 'Back to Clients', href: '/clients' }}
        />
      </div>
    )
  }

  return (
    <div className="p-6 lg:p-8">
      <PageHeader
        title={`Edit ${client.name}`}
        description="Update this client's information"
      />

      <Card className="mx-auto mt-6 max-w-3xl">
        <CardHeader>
          <CardTitle>Client Information</CardTitle>
        </CardHeader>
        <CardContent>
          <ClientForm
            client={client}
            onSubmit={handleSubmit}
            onCancel={() => router.back()}
          />
        </CardContent>
      </Card>
    </div>
  )
}
