'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { PageHeader } from '@/components/shared/page-header'
import { ExpenseForm, type ExpenseFormData } from '@/components/expenses/expense-form'
import { useBusiness } from '@/lib/hooks/use-business'
import type { Client } from '@/types'

import { toast } from 'sonner'
import { toISODate } from '@/lib/dates'
import { createExpenseAction } from '@/lib/actions/expenses'

export default function NewExpensePage() {
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
  async function handleSubmit(data: ExpenseFormData) {
    if (!currentBusiness) return

    const result = await createExpenseAction(
      currentBusiness.id,
      {
        client_id: data.client_id || null,
        category: data.category,
        description: data.description || null,
        amount: data.amount,
        date: toISODate(data.date),
        vendor: data.vendor || null,
        is_billable: data.is_billable,
      },
      (requestId.current ??= crypto.randomUUID()),
    )

    if ('error' in result) {
      toast.error(result.error)
      return
    }
    router.push('/expenses')
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
        title="Add Expense"
        description="Record a business expense"
      />

      <div className="mt-6 max-w-2xl">
        <ExpenseForm
          currency={currentBusiness?.default_currency}
          clients={clients}
          onSubmit={handleSubmit}
          onCancel={() => router.back()}
        />
      </div>
    </div>
  )
}

