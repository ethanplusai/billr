'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { failure, type WriteResult } from './result'

/**
 * Catalog writes, including the delete on /items, run server-side as actions
 * that validate their input before anything is written.
 */

const itemInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
  rate: z.number().finite().min(0).max(99999999),
  unit: z.string().trim().max(50).nullish(),
})

export type ItemInput = z.input<typeof itemInput>

export async function createItemAction(
  businessId: string,
  input: ItemInput,
): Promise<WriteResult> {
  try {
    const data = itemInput.parse(input)
    const supabase = await createClient()

    const { error } = await supabase.from('items').insert({
      business_id: z.string().uuid().parse(businessId),
      name: data.name,
      description: data.description || null,
      rate: data.rate,
      unit: data.unit || null,
    })
    if (error) return { error: error.message }

    revalidatePath('/items')
    return { ok: true }
  } catch (error) {
    return failure(error, 'Could not save that item.')
  }
}

export async function updateItemAction(
  itemId: string,
  input: ItemInput,
): Promise<WriteResult> {
  try {
    const data = itemInput.parse(input)
    const supabase = await createClient()

    const { data: saved, error } = await supabase
      .from('items')
      .update({
        name: data.name,
        description: data.description || null,
        rate: data.rate,
        unit: data.unit || null,
      })
      .eq('id', itemId)
      .select('id')

    if (error) return { error: error.message }
    if (!saved?.length) return { error: 'Item not found.' }

    revalidatePath('/items')
    revalidatePath(`/items/${itemId}`)
    return { ok: true }
  } catch (error) {
    return failure(error, 'Could not save that item.')
  }
}

export async function deleteItemAction(itemId: string): Promise<WriteResult> {
  try {
    const supabase = await createClient()

    const { error } = await supabase.from('items').delete().eq('id', itemId)
    if (error) return { error: error.message }

    revalidatePath('/items')
    return { ok: true }
  } catch (error) {
    return failure(error, 'Could not delete that item.')
  }
}
