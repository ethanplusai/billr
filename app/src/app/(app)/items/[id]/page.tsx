'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { PageHeader } from '@/components/shared/page-header'
import { ItemForm, type ItemFormData } from '@/components/items/item-form'
import { EmptyState } from '@/components/shared/empty-state'
import { Package } from 'lucide-react'
import type { Item } from '@/types'

import { toast } from 'sonner'
import { updateItemAction } from '@/lib/actions/items'

export default function EditItemPage() {
  const params = useParams()
  const router = useRouter()
  const itemId = params.id as string
  const [item, setItem] = useState<Item | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    async function fetchItem() {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      
      const { data } = await supabase
        .from('items')
        .select('*')
        .eq('id', itemId)
        .single()

      setItem(data as Item | null)
      setIsLoading(false)
    }

    fetchItem()
  }, [itemId])

  async function handleSubmit(data: ItemFormData) {
    if (!item) return

    const result = await updateItemAction(itemId, {
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

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  if (!item) {
    return (
      <div className="p-6 lg:p-8">
        <EmptyState
          icon={Package}
          title="Item not found"
          description="The item you're looking for doesn't exist."
          action={{ label: 'Back to Items', href: '/items' }}
        />
      </div>
    )
  }

  return (
    <div className="p-6 lg:p-8">
      <PageHeader
        title="Edit Item"
        description={`Update ${item.name}`}
      />

      <div className="mt-6 max-w-2xl">
        <ItemForm
          item={item}
          onSubmit={handleSubmit}
          onCancel={() => router.back()}
        />
      </div>
    </div>
  )
}

