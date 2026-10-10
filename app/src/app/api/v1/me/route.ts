import { NextRequest, NextResponse } from 'next/server'
import { resolveApiKey } from '@/lib/api-keys/resolver'
import { createScopedDb } from '@/lib/mcp/scoped-db'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  const secret = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const resolved = await resolveApiKey(secret)

  if ('error' in resolved) {
    if (resolved.error === 'rate_limited') {
      return NextResponse.json(
        { error: 'Rate limit exceeded' },
        { status: 429, headers: { 'Retry-After': '60' } }
      )
    }
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 })
  }

  // Read-only lookup of the businesses this key is scoped to, through the
  // scoped data layer rather than a raw service client.
  const db = createScopedDb({ userId: resolved.userId, businessIds: resolved.businessIds })
  const { data: businesses, error } = await db.svc
    .from('businesses')
    .select('id, name')
    .in('id', db.scope.businessIds)

  if (error) {
    console.error('api/v1/me businesses lookup:', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  return NextResponse.json({ user_id: resolved.userId, businesses: businesses ?? [] })
}
