'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { failure, type WriteResult } from './result'
import {
  LOGO_URL_MESSAGE,
  MAX_LOGO_URL_LENGTH,
  isAllowedLogoUrl,
} from '@/lib/branding/logo-url'

/**
 * Business settings writes: profile, invoice defaults, branding.
 *
 * Three narrow actions rather than one patch action on purpose: a generic
 * `update(businesses, patch)` behind a server action would hand the browser a
 * column picker. Each action names the columns it may write.
 */

const profileInput = z.object({
  name: z.string().trim().min(1).max(200),
  legal_name: z.string().trim().max(200).nullish(),
  email: z.string().trim().max(320).nullish(),
  phone: z.string().trim().max(50).nullish(),
  website: z.string().trim().max(500).nullish(),
  address_line1: z.string().trim().max(200).nullish(),
  address_line2: z.string().trim().max(200).nullish(),
  city: z.string().trim().max(100).nullish(),
  state: z.string().trim().max(100).nullish(),
  postal_code: z.string().trim().max(30).nullish(),
  country: z.string().trim().max(100).nullish(),
  tax_id: z.string().trim().max(100).nullish(),
})

const invoiceDefaultsInput = z.object({
  default_currency: z.string().trim().regex(/^[A-Za-z]{3}$/),
  default_payment_terms: z.number().int().min(0).max(365),
  invoice_prefix: z.string().trim().min(1).max(20),
  estimate_prefix: z.string().trim().min(1).max(20),
  invoice_notes: z.string().max(5000).nullish(),
  invoice_footer: z.string().max(5000).nullish(),
})

// logo_url is NOT `z.string().url()`. In zod 4 that accepts javascript:,
// data:, file: and vbscript:, and the value is later fetched server-side by the
// unauthenticated public PDF route. It is either an object on this
// installation's own Supabase storage, or empty to clear the logo. See
// src/lib/branding/logo-url.ts.
const brandingInput = z.object({
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logo_url: z
    .string()
    .max(MAX_LOGO_URL_LENGTH)
    .refine((value) => value === '' || isAllowedLogoUrl(value), LOGO_URL_MESSAGE)
    .optional(),
})

export type BusinessProfileInput = z.input<typeof profileInput>
export type InvoiceDefaultsInput = z.input<typeof invoiceDefaultsInput>
export type BrandingInput = z.input<typeof brandingInput>

async function patchBusiness(
  businessId: string,
  patch: Record<string, unknown>,
): Promise<WriteResult> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('businesses')
    .update(patch)
    .eq('id', z.string().uuid().parse(businessId))
    .select('id')

  if (error) return { error: error.message }
  // RLS answers an update on someone else's business with zero rows, not an
  // error, so an empty result is a refusal rather than a success.
  if (!data?.length) return { error: 'You cannot change that business.' }

  revalidatePath('/settings')
  return { ok: true }
}

export async function updateBusinessProfileAction(
  businessId: string,
  input: BusinessProfileInput,
): Promise<WriteResult> {
  try {
    const data = profileInput.parse(input)
    return await patchBusiness(businessId, {
      ...data,
      email: data.email || null,
      website: data.website || null,
    })
  } catch (error) {
    return failure(error, 'Could not save those settings.')
  }
}

export async function updateInvoiceDefaultsAction(
  businessId: string,
  input: InvoiceDefaultsInput,
): Promise<WriteResult> {
  try {
    const data = invoiceDefaultsInput.parse(input)
    return await patchBusiness(businessId, {
      ...data,
      default_currency: data.default_currency.toUpperCase(),
      invoice_notes: data.invoice_notes || null,
      invoice_footer: data.invoice_footer || null,
    })
  } catch (error) {
    return failure(error, 'Could not save those settings.')
  }
}

export async function updateBrandingAction(
  businessId: string,
  input: BrandingInput,
): Promise<WriteResult> {
  try {
    const data = brandingInput.parse(input)
    if (data.primary_color === undefined && data.logo_url === undefined) {
      return { error: 'Nothing to update.' }
    }
    // An empty logo clears the column rather than storing '', so every reader
    // sees the same "no logo" value the schema default uses.
    return await patchBusiness(businessId, {
      ...data,
      ...(data.logo_url === '' ? { logo_url: null } : {}),
    })
  } catch (error) {
    return failure(error, 'Could not save your branding.')
  }
}
