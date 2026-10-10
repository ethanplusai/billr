export const dynamic = 'force-dynamic'
/** Liveness only. Does not disclose credentials or claim database readiness. */
export async function GET() {
  return Response.json(
    { status: 'ok' },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
