import { stripePaymentsConfigured } from '@/lib/stripe/config'

export const dynamic = 'force-dynamic'

/** Whether card payment is available on this installation. Never exposes key values. */
export async function GET() {
  return Response.json(
    { available: stripePaymentsConfigured() },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
