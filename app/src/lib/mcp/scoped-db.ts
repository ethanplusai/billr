import { createServiceClient } from '@/lib/supabase/service'
import type { Database } from '@/types/database'
import type { SupabaseClient } from '@supabase/supabase-js'

type ClientRow = Database['public']['Tables']['clients']['Row']
type InvoiceRow = Database['public']['Tables']['invoices']['Row']
type EstimateRow = Database['public']['Tables']['estimates']['Row']
type TimeEntryRow = Database['public']['Tables']['time_entries']['Row']
type ExpenseRow = Database['public']['Tables']['expenses']['Row']
type PaymentRow = Database['public']['Tables']['payments']['Row']

export interface Scope {
  userId: string
  businessIds: string[]
}

export class ScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScopeError'
  }
}

export interface ScopedDb {
  scope: Scope
  svc: SupabaseClient<Database>
  resolveBusinessId(input?: string): string
  assertClientAccess(clientId: string): Promise<ClientRow>
  assertInvoiceAccess(invoiceId: string): Promise<InvoiceRow>
  assertEstimateAccess(estimateId: string): Promise<EstimateRow>
  assertTimeEntryAccess(timeEntryId: string): Promise<TimeEntryRow>
  assertExpenseAccess(expenseId: string): Promise<ExpenseRow>
  assertPaymentAccess(paymentId: string): Promise<PaymentRow>
}

export function createScopedDb(
  scope: Scope,
  svc: SupabaseClient<Database> = createServiceClient()
): ScopedDb {
  function resolveBusinessId(input?: string): string {
    if (input !== undefined) {
      if (!scope.businessIds.includes(input)) {
        throw new ScopeError(
          `You do not have access to business ${input}. Available: ${scope.businessIds.join(', ')}`
        )
      }
      return input
    }
    if (scope.businessIds.length === 1) {
      return scope.businessIds[0]
    }
    throw new ScopeError(
      `Multiple businesses in scope (${scope.businessIds.join(', ')}); pass business_id to specify which one.`
    )
  }

  /**
   * Single implementation behind every assert*Access helper: fetch the row by
   * id, then refuse it unless its business_id is inside the key's scope.
   *
   * "Missing" and "out of scope" deliberately produce the IDENTICAL message,
   * so a caller cannot probe for the existence of another tenant's rows by
   * diffing error text. scoped-db.test.ts asserts that equivalence.
   */
  async function assertRowAccess<T extends { business_id: string }>(
    table: 'clients' | 'invoices' | 'estimates' | 'time_entries' | 'expenses' | 'payments',
    label: string,
    id: string
  ): Promise<T> {
    const { data, error } = await svc.from(table).select('*').eq('id', id).maybeSingle()
    if (error) {
      console.error(`scoped-db assert${label}Access:`, error)
    }
    const row = data as T | null
    if (error || !row || !scope.businessIds.includes(row.business_id)) {
      throw new ScopeError(`${label} not found`)
    }
    return row
  }

  const assertClientAccess = (clientId: string) => assertRowAccess<ClientRow>('clients', 'Client', clientId)
  const assertInvoiceAccess = (invoiceId: string) => assertRowAccess<InvoiceRow>('invoices', 'Invoice', invoiceId)
  const assertEstimateAccess = (estimateId: string) =>
    assertRowAccess<EstimateRow>('estimates', 'Estimate', estimateId)
  const assertTimeEntryAccess = (timeEntryId: string) =>
    assertRowAccess<TimeEntryRow>('time_entries', 'Time entry', timeEntryId)
  const assertExpenseAccess = (expenseId: string) => assertRowAccess<ExpenseRow>('expenses', 'Expense', expenseId)
  const assertPaymentAccess = (paymentId: string) => assertRowAccess<PaymentRow>('payments', 'Payment', paymentId)

  return {
    scope,
    svc,
    resolveBusinessId,
    assertClientAccess,
    assertInvoiceAccess,
    assertEstimateAccess,
    assertTimeEntryAccess,
    assertExpenseAccess,
    assertPaymentAccess,
  }
}
