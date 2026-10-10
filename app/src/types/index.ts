// Application Types
// These extend the database types with additional properties

export interface Profile {
  id: string
  full_name: string | null
  avatar_url: string | null
  created_at: string
  updated_at: string
}

export interface Business {
  id: string
  name: string
  legal_name: string | null
  email: string | null
  phone: string | null
  website: string | null
  address_line1: string | null
  address_line2: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  country: string | null
  tax_id: string | null
  logo_url: string | null
  primary_color: string | null
  default_currency: string
  default_payment_terms: number
  invoice_prefix: string
  estimate_prefix: string
  next_invoice_number: number
  next_estimate_number: number
  invoice_notes: string | null
  invoice_footer: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface Client {
  id: string
  business_id: string
  name: string
  email: string | null
  phone: string | null
  website: string | null
  address_line1: string | null
  address_line2: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  country: string | null
  tax_id: string | null
  currency: string
  payment_terms: number
  notes: string | null
  // Per-client money (invoiced, paid, outstanding) comes from the
  // client_financials view, not from this row.
  is_active: boolean
  created_at: string
  updated_at: string
}

export type InvoiceStatus =
  | 'draft'
  | 'sent'
  | 'viewed'
  | 'paid'
  | 'partial'
  | 'overdue'
  | 'cancelled'

export type EstimateStatus =
  | 'draft'
  | 'sent'
  | 'viewed'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'converted'

export interface Invoice {
  id: string
  public_id: string
  business_id: string
  client_id: string
  invoice_number: string
  status: InvoiceStatus
  issue_date: string
  due_date: string
  currency: string
  subtotal: number
  discount_type: 'percentage' | 'fixed'
  discount_value: number
  discount_amount: number
  tax_rate: number
  tax_amount: number
  shipping_amount: number
  total: number
  amount_paid: number
  balance_due: number
  notes: string | null
  terms: string | null
  footer: string | null
  payment_instructions: string | null
  po_number: string | null
  is_recurring: boolean
  recurring_interval: string | null
  recurring_end_date: string | null
  last_sent_at: string | null
  last_viewed_at: string | null
  paid_at: string | null
  payment_method: string | null
  stripe_payment_intent_id: string | null
  stripe_payment_status: string | null
  client_snapshot: Client | Record<string, unknown> | null
  business_snapshot: Business | Record<string, unknown> | null
  from_estimate_id: string | null
  created_at: string
  updated_at: string
}

export interface InvoiceLineItem {
  id: string
  invoice_id: string
  description: string
  quantity: number
  rate: number
  amount: number
  tax_rate: number
  tax_amount: number
  discount_percent: number
  discount_amount: number
  sort_order: number
  created_at: string
}

export interface Estimate {
  id: string
  public_id: string
  business_id: string
  client_id: string
  estimate_number: string
  status: EstimateStatus
  issue_date: string
  expiry_date: string | null
  currency: string
  subtotal: number
  discount_type: 'percentage' | 'fixed'
  discount_value: number
  discount_amount: number
  tax_rate: number
  tax_amount: number
  shipping_amount: number
  total: number
  notes: string | null
  terms: string | null
  converted_invoice_id: string | null
  client_snapshot: Client | Record<string, unknown> | null
  business_snapshot: Business | Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface EstimateLineItem {
  id: string
  estimate_id: string
  description: string
  quantity: number
  rate: number
  amount: number
  tax_rate: number
  tax_amount: number
  discount_percent: number
  discount_amount: number
  sort_order: number
  created_at: string
}

export interface Item {
  id: string
  business_id: string
  name: string
  description: string | null
  type: 'product' | 'service'
  rate: number
  unit: string | null
  tax_rate: number
  is_active: boolean
  created_at: string
  updated_at: string
}

type ExpenseCategory =
  | 'office'
  | 'travel'
  | 'meals'
  | 'supplies'
  | 'utilities'
  | 'software'
  | 'marketing'
  | 'professional'
  | 'insurance'
  | 'mileage'
  | 'other'

export interface Expense {
  id: string
  business_id: string
  client_id: string | null
  invoice_id: string | null
  category: ExpenseCategory
  description: string | null
  amount: number
  currency: string
  date: string
  is_billable: boolean
  is_billed: boolean
  receipt_url: string | null
  vendor: string | null
  mileage_distance: number | null
  mileage_rate: number | null
  notes: string | null
  created_at: string
  updated_at: string
}

type PaymentMethod =
  | 'cash'
  | 'check'
  | 'bank_transfer'
  | 'credit_card'
  | 'stripe'
  | 'paypal'
  | 'other'

export interface Payment {
  id: string
  business_id: string
  invoice_id: string
  client_id: string
  amount: number
  currency: string
  payment_date: string
  payment_method: PaymentMethod
  reference_number: string | null
  notes: string | null
  stripe_payment_id: string | null
  created_at: string
  /**
   * Where the money came from. "stripe" money is owned by the
   * verified Stripe flow and cannot be edited or voided in the app; the path
   * for card money is a refund.
   */
  source?: 'manual' | 'agent' | 'stripe'
  /** Set once voided. A voided payment stays visible but stops being money. */
  voided_at?: string | null
  void_reason?: string | null
  updated_at?: string | null
}

export interface TimeEntry {
  currency?: string
  id: string
  business_id: string
  client_id: string | null
  invoice_id: string | null
  project_name: string | null
  description: string | null
  date: string
  start_time: string | null
  end_time: string | null
  duration_seconds?: number
  duration_minutes: number | null
  hourly_rate: number | null
  amount: number | null
  is_billable: boolean
  is_billed: boolean
  is_running: boolean
  created_at: string
  updated_at: string
}

// Status color mappings for badges
export const invoiceStatusColors: Record<InvoiceStatus, string> = {
  draft: 'bg-gray-100 text-gray-700',
  sent: 'bg-blue-100 text-blue-700',
  viewed: 'bg-purple-100 text-purple-700',
  paid: 'bg-green-100 text-green-700',
  partial: 'bg-yellow-100 text-yellow-700',
  overdue: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-100 text-gray-500',
}

export const estimateStatusColors: Record<EstimateStatus, string> = {
  draft: 'bg-gray-100 text-gray-700',
  sent: 'bg-blue-100 text-blue-700',
  viewed: 'bg-purple-100 text-purple-700',
  accepted: 'bg-green-100 text-green-700',
  declined: 'bg-red-100 text-red-700',
  expired: 'bg-gray-100 text-gray-500',
  converted: 'bg-indigo-100 text-indigo-700',
}
