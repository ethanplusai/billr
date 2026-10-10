import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from '@/lib/mcp/fake-supabase'
import { _setRateLimitStore } from '@/lib/rate-limit'
import { prepareDelivery, finishDelivery } from './delivery'
const request = '10000000-0000-4000-8000-000000000001'
function setup() {
  let row: Record<string, unknown> | null = null
  const db = createFakeSupabase({
    'email_deliveries.select': () => ({ data: row, error: null }),
    'email_deliveries.insert': (q) => {
      row = {
        ...(q.payload as object),
        created_at: new Date().toISOString(),
        sent_at: null,
      }
      return { data: row, error: null }
    },
    'email_deliveries.update': (q) => {
      row = { ...row, ...(q.payload as object) }
      return { data: row, error: null }
    },
  })
  return {
    db: db as never,
    age: () => {
      row!.created_at = new Date(Date.now() - 24 * 3600000).toISOString()
    },
  }
}
describe('durable email delivery', () => {
  it('reuses the original payload even when PDF generation changes on a retry', async () => {
    const { db } = setup()
    const a = await prepareDelivery(
      db,
      'b',
      'i',
      'invoice',
      request,
      { to: 'client@example.test' },
      { attachment: 'original' }
    )
    const b = await prepareDelivery(
      db,
      'b',
      'i',
      'invoice',
      request,
      { to: 'client@example.test' },
      { attachment: 'regenerated' }
    )
    expect(a.key).toBe(b.key)
    expect(b.payload.attachment).toBe('original')
  })
  it('returns confirmed delivery without sending again', async () => {
    const { db } = setup()
    await prepareDelivery(db, 'b', 'i', 'invoice', request, {}, {})
    await finishDelivery(db, 'b', request)
    expect(
      (await prepareDelivery(db, 'b', 'i', 'invoice', request, {}, {}))
        .alreadySent
    ).toBe(true)
  })
  it('rejects reuse with different recipients', async () => {
    const { db } = setup()
    await prepareDelivery(
      db,
      'b',
      'i',
      'invoice',
      request,
      { to: 'a@example.test' },
      {}
    )
    await expect(
      prepareDelivery(
        db,
        'b',
        'i',
        'invoice',
        request,
        { to: 'b@example.test' },
        {}
      )
    ).rejects.toThrow('different email content')
  })
  it('requires review after the provider idempotency window', async () => {
    const { db, age } = setup()
    await prepareDelivery(db, 'b', 'i', 'invoice', request, {}, {})
    age()
    await expect(
      prepareDelivery(db, 'b', 'i', 'invoice', request, {}, {})
    ).rejects.toThrow('needs review')
  })
})

/**
 * The daily send quota is enforced inside prepareDelivery so the web server
 * actions and the MCP send tools are both covered by one check. What matters
 * here is WHERE in the function it sits: one charge per new request id, none
 * for a retry of a send already in flight, and nothing written down when the
 * allowance is gone.
 */
describe('daily email quota inside the delivery path', () => {
  const ORIGINAL = process.env.BILLR_EMAIL_DAILY_LIMIT
  afterEach(() => {
    _setRateLimitStore(null)
    if (ORIGINAL === undefined) delete process.env.BILLR_EMAIL_DAILY_LIMIT
    else process.env.BILLR_EMAIL_DAILY_LIMIT = ORIGINAL
  })
  function limiter(allowed: boolean) {
    const spends: unknown[] = []
    _setRateLimitStore(() => ({
      rpc: async (_fn: string, args: Record<string, unknown>) => {
        spends.push(args)
        return { data: [{ allowed, remaining: 0, retry_after_seconds: 3600 }], error: null }
      },
    }))
    return spends
  }

  it('charges one send per new request id and nothing for a retry', async () => {
    process.env.BILLR_EMAIL_DAILY_LIMIT = '200'
    const spends = limiter(true)
    const { db } = setup()
    await prepareDelivery(db, 'b', 'i', 'invoice', request, {}, {})
    await prepareDelivery(db, 'b', 'i', 'invoice', request, {}, {})
    expect(spends).toHaveLength(1)
  })

  it('refuses the send without recording a delivery when the allowance is gone', async () => {
    process.env.BILLR_EMAIL_DAILY_LIMIT = '200'
    limiter(false)
    const { db } = setup()
    const fake = db as unknown as ReturnType<typeof createFakeSupabase>
    await expect(
      prepareDelivery(db, 'b', 'i', 'invoice', request, {}, {})
    ).rejects.toThrow('Daily email limit reached for this business')
    expect(fake.calls.some((c) => c.op === 'insert')).toBe(false)
  })

  it('does not consult the limiter when no cap applies', async () => {
    delete process.env.BILLR_EMAIL_DAILY_LIMIT
    const spends = limiter(true)
    const { db } = setup()
    await prepareDelivery(db, 'b', 'i', 'invoice', request, {}, {})
    expect(spends).toEqual([])
  })
})
