'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import type { ClientFormData } from '@/lib/validations/client'

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Client writes.
 *
 * A server action is a public POST endpoint, so `data` here is whatever the
 * caller sends and never "whatever the form produced". These three used to
 * spread the argument straight into the insert and the update, after
 * `business_id`, which meant a supplied `business_id` won and `id`,
 * `created_at`, `created_via` and `created_by_key_id` were all equally
 * writable, with no length cap anywhere (application audit, Medium-3).
 *
 * Two rules now, the same pair every other action file follows
 * (`business.ts`, `invoices.ts`, `payments.ts`, ...):
 *
 *   1. parse with a server-side schema that is `.strict()`, so an unknown key
 *      is a refusal rather than something the spread carries into the write;
 *   2. name the columns being written, one by one. Nothing is spread. Adding a
 *      column to `clients` therefore cannot silently become writable from the
 *      browser.
 *
 * `clientSchema` in src/lib/validations/client.ts stays as it is: it drives the
 * form's field-level messages and has no `.max()` bounds because a text input
 * does not need them. This schema is the one that decides what is stored.
 */
const clientInput = z
  .object({
    name: z.string().trim().min(1, 'Client name is required').max(200),
    email: z.union([z.literal(''), z.string().trim().email().max(320)]).optional(),
    phone: z.string().trim().max(50).optional(),
    // The client detail page renders this as an <a href>, so the scheme is
    // checked here rather than left to zod's url(), which accepts javascript:.
    website: z
      .union([
        z.literal(''),
        z
          .string()
          .trim()
          .max(500)
          .refine(isHttpUrl, 'A website must be an http:// or https:// address'),
      ])
      .optional(),
    address_line1: z.string().trim().max(200).optional(),
    address_line2: z.string().trim().max(200).optional(),
    city: z.string().trim().max(100).optional(),
    state: z.string().trim().max(100).optional(),
    postal_code: z.string().trim().max(30).optional(),
    country: z.string().trim().max(100).optional(),
    tax_id: z.string().trim().max(100).optional(),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/).default('USD'),
    payment_terms: z.number().int().min(0).max(365).default(30),
    notes: z.string().max(5000).optional(),
  })
  .strict()

type ClientInput = z.infer<typeof clientInput>

/**
 * The exact column list a browser caller may write, built by hand from the
 * parsed value. Empty optional fields become NULL so the column carries "not
 * set" rather than an empty string, matching updateBusinessProfileAction.
 */
function clientColumns(data: ClientInput) {
  const orNull = (value: string | undefined) => (value ? value : null)
  return {
    name: data.name,
    email: orNull(data.email),
    phone: orNull(data.phone),
    website: orNull(data.website),
    address_line1: orNull(data.address_line1),
    address_line2: orNull(data.address_line2),
    city: orNull(data.city),
    state: orNull(data.state),
    postal_code: orNull(data.postal_code),
    country: orNull(data.country),
    tax_id: orNull(data.tax_id),
    currency: data.currency.toUpperCase(),
    payment_terms: data.payment_terms,
    notes: orNull(data.notes),
  }
}

export async function createClientAction(businessId: string, data: ClientFormData) {
  const business = z.string().uuid().parse(businessId)
  const parsed = clientInput.parse(data)
  const supabase = await createClient()

  const { data: client, error } = await supabase
    .from('clients')
    // business_id comes from the argument and is written last, so no parsed
    // field can shadow it. RLS checks it as well; this makes the action agree.
    .insert({ ...clientColumns(parsed), business_id: business })
    .select()
    .single()

  if (error) {
    throw new Error(error.message)
  }

  revalidatePath('/clients')
  return client
}

export async function updateClientAction(clientId: string, data: ClientFormData) {
  const id = z.string().uuid().parse(clientId)
  const parsed = clientInput.parse(data)
  const supabase = await createClient()

  const { data: client, error } = await supabase
    .from('clients')
    // business_id is deliberately absent: an edit never moves a client between
    // businesses, not even between two the caller belongs to.
    .update(clientColumns(parsed))
    .eq('id', id)
    .select()
    .single()

  if (error) {
    throw new Error(error.message)
  }

  revalidatePath('/clients')
  revalidatePath(`/clients/${id}`)
  return client
}

export async function deleteClientAction(clientId: string) {
  const id = z.string().uuid().parse(clientId)
  const supabase = await createClient()

  const { error } = await supabase
    .from('clients')
    .update({ is_active: false })
    .eq('id', id)

  if (error) {
    throw new Error(error.message)
  }

  revalidatePath('/clients')
}
