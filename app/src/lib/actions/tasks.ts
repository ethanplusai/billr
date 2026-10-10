'use server'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

const policySchema = z.object({
  business_id: z.string().uuid(),
  client_id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  currency: z.string().regex(/^[A-Z]{3}$/),
  hourly_rate: z.coerce.number().finite().min(0).max(999999),
  usage_multiplier: z.coerce.number().finite().min(0).max(100),
  budget: z.coerce.number().finite().positive().max(99999999),
})
export async function approvePricingPolicy(
  input: z.input<typeof policySchema>
) {
  const policy = policySchema.parse(input)
  const db = await createClient()
  const { data, error } = await db
    .from('billing_policies')
    .insert(policy)
    .select()
    .single()
  if (error) throw new Error(error.message)
  revalidatePath('/tasks')
  return data
}
export async function reviewTaskInvoice(
  businessId: string,
  taskId: string,
  requestId: string
) {
  const db = await createClient()
  const { data, error } = await db.rpc('task_operation', {
    p_business_id: z.uuid().parse(businessId),
    p_request_id: z.uuid().parse(requestId),
    p_action: 'invoice',
    p_input: { task_id: z.uuid().parse(taskId) },
  })
  if (error) throw new Error(error.message)
  revalidatePath('/tasks')
  revalidatePath('/invoices')
  return data as { task: { invoice_id: string } }
}
