'use server'

import { appOrigin } from '@/lib/deployment'
import { stripeSetup, type StripeSetup } from '@/lib/stripe/config'
import { createClient } from '@/lib/supabase/server'

export type StripeSetupView = StripeSetup & { webhookUrl: string }

/** What Agents, Payments shows. Signed-in users only; never returns a key value. */
export async function getStripeSetupAction(): Promise<StripeSetupView | null> {
  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  if (!data.user) return null
  return { ...stripeSetup(), webhookUrl: `${appOrigin()}/api/stripe/webhook` }
}
