import { describe, it, expect, vi, afterEach } from 'vitest'
import { createScopedDb, ScopeError } from '@/lib/mcp/scoped-db'

const scope1 = { userId: 'u1', businessIds: ['b1'] }
const scope2 = { userId: 'u1', businessIds: ['b1', 'b2'] }
const stub = {} as never // svc unused by resolveBusinessId

describe('resolveBusinessId', () => {
  it('returns the sole business when none specified', () => {
    expect(createScopedDb(scope1, stub).resolveBusinessId()).toBe('b1')
  })
  it('accepts an in-scope business id', () => {
    expect(createScopedDb(scope2, stub).resolveBusinessId('b2')).toBe('b2')
  })
  it('rejects an out-of-scope business id', () => {
    expect(() => createScopedDb(scope1, stub).resolveBusinessId('bX')).toThrow(ScopeError)
  })
  it('requires an explicit id when several businesses are in scope', () => {
    expect(() => createScopedDb(scope2, stub).resolveBusinessId()).toThrow(/business_id/)
  })
})

// Builds a fake SupabaseClient exposing only the .from().select().eq().maybeSingle()
// chain used by assertClientAccess / assertInvoiceAccess.
function mockSvc(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result)
  const eq = vi.fn().mockReturnValue({ maybeSingle })
  const select = vi.fn().mockReturnValue({ eq })
  const from = vi.fn().mockReturnValue({ select })
  return { from } as never
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('assertClientAccess', () => {
  it('throws ScopeError with the generic message when the row is missing', async () => {
    const svc = mockSvc({ data: null, error: null })
    const db = createScopedDb(scope1, svc)
    await expect(db.assertClientAccess('c1')).rejects.toThrow(ScopeError)
    await expect(db.assertClientAccess('c1')).rejects.toThrow('Client not found')
  })

  it('throws ScopeError with the identical message when the row is out of scope', async () => {
    const svc = mockSvc({ data: { id: 'c1', business_id: 'bX' }, error: null })
    const db = createScopedDb(scope1, svc)

    let missingMessage = ''
    const missingSvc = mockSvc({ data: null, error: null })
    try {
      await createScopedDb(scope1, missingSvc).assertClientAccess('c1')
    } catch (e) {
      missingMessage = (e as Error).message
    }

    let outOfScopeMessage = ''
    try {
      await db.assertClientAccess('c1')
    } catch (e) {
      outOfScopeMessage = (e as Error).message
    }

    expect(outOfScopeMessage).toBe(missingMessage)
  })

  it('returns the row when it is present and in scope', async () => {
    const row = { id: 'c1', business_id: 'b1' }
    const svc = mockSvc({ data: row, error: null })
    const db = createScopedDb(scope1, svc)
    await expect(db.assertClientAccess('c1')).resolves.toEqual(row)
  })

  it('logs the DB error and still throws the generic ScopeError', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const svc = mockSvc({ data: null, error: { message: 'boom' } })
    const db = createScopedDb(scope1, svc)
    await expect(db.assertClientAccess('c1')).rejects.toThrow('Client not found')
    expect(spy).toHaveBeenCalled()
  })
})

describe('assertInvoiceAccess', () => {
  it('throws ScopeError with the generic message when the row is missing', async () => {
    const svc = mockSvc({ data: null, error: null })
    const db = createScopedDb(scope1, svc)
    await expect(db.assertInvoiceAccess('i1')).rejects.toThrow('Invoice not found')
  })

  it('throws ScopeError with the identical message when the row is out of scope', async () => {
    const missingSvc = mockSvc({ data: null, error: null })
    let missingMessage = ''
    try {
      await createScopedDb(scope1, missingSvc).assertInvoiceAccess('i1')
    } catch (e) {
      missingMessage = (e as Error).message
    }

    const outOfScopeSvc = mockSvc({ data: { id: 'i1', business_id: 'bX' }, error: null })
    let outOfScopeMessage = ''
    try {
      await createScopedDb(scope1, outOfScopeSvc).assertInvoiceAccess('i1')
    } catch (e) {
      outOfScopeMessage = (e as Error).message
    }

    expect(outOfScopeMessage).toBe(missingMessage)
  })

  it('returns the row when it is present and in scope', async () => {
    const row = { id: 'i1', business_id: 'b1' }
    const svc = mockSvc({ data: row, error: null })
    const db = createScopedDb(scope1, svc)
    await expect(db.assertInvoiceAccess('i1')).resolves.toEqual(row)
  })

  it('logs the DB error and still throws the generic ScopeError', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const svc = mockSvc({ data: null, error: { message: 'boom' } })
    const db = createScopedDb(scope1, svc)
    await expect(db.assertInvoiceAccess('i1')).rejects.toThrow('Invoice not found')
    expect(spy).toHaveBeenCalled()
  })
})
