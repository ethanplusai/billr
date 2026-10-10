'use client'

import { useRouter } from 'next/navigation'
import { PageHeader } from '@/components/shared/page-header'
import { ItemForm, type ItemFormData } from '@/components/items/item-form'
import { useBusiness } from '@/lib/hooks/use-business'

import { toast } from 'sonner'
import { createItemAction } from '@/lib/actions/items'

export default function NewItemPage() {
  const router = useRouter()
  const { currentBusiness } = useBusiness()

  async function handleSubmit(data: ItemFormData) {
    if (!currentBusiness) return

    const result = await createItemAction(currentBusiness.id, {
      name: data.name,
      description: data.description || null,
      rate: data.rate,
      unit: data.unit || null,
    })

    if ('error' in result) {
      toast.error(result.error)
      return
    }
    router.push('/items')
  }

  if (!currentBusiness) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="p-6 lg:p-8">
      <PageHeader
        title="New Item"
        description="Add a new product or service to your catalog"
      />

      <div className="mt-6 max-w-2xl">
        <ItemForm onSubmit={handleSubmit} onCancel={() => router.back()} />
      </div>
    </div>
  )
}

