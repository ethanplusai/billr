type StepId = 'business' | 'branding' | 'stripe' | 'client' | 'invoice' | 'send' | 'agent'

export interface ChecklistFacts {
  businessName: string | null
  businessEmail: string | null
  businessPhone: string | null
  businessAddress1: string | null
  logoUrl: string | null
  primaryColor: string | null
  stripeConfigured: boolean
  clientCount: number
  invoiceCount: number
  sentInvoiceCount: number
  apiKeyCount: number
  usedApiKeyCount: number
}

export interface ChecklistStep {
  id: StepId
  label: string
  href: string
  done: boolean
  hint?: string
}

const DEFAULT_PRIMARY_COLOR = '#2563eb'

function isNonEmpty(value: string | null): boolean {
  return value !== null && value.trim().length > 0
}

export function deriveChecklist(facts: ChecklistFacts): ChecklistStep[] {
  const businessDone =
    isNonEmpty(facts.businessName) &&
    (isNonEmpty(facts.businessEmail) || isNonEmpty(facts.businessPhone) || isNonEmpty(facts.businessAddress1))

  const brandingDone =
    facts.logoUrl !== null ||
    (isNonEmpty(facts.primaryColor) && facts.primaryColor !== DEFAULT_PRIMARY_COLOR)

  const stripeDone = facts.stripeConfigured === true

  const clientDone = facts.clientCount > 0

  const invoiceDone = facts.invoiceCount > 0

  const sendDone = facts.sentInvoiceCount > 0

  const agentDone = facts.usedApiKeyCount > 0
  const agentHint =
    !agentDone && facts.apiKeyCount > 0 && facts.usedApiKeyCount === 0
      ? 'Key created. Connect your agent to finish.'
      : undefined

  const steps: ChecklistStep[] = [
    { id: 'business', label: 'Add your business details', href: '/settings/business', done: businessDone },
    { id: 'branding', label: 'Add your logo and color', href: '/settings/branding', done: brandingDone },
    { id: 'stripe', label: 'Add your Stripe keys', href: '/agents?tab=payments', done: stripeDone },
    { id: 'client', label: 'Add your first client', href: '/clients/new', done: clientDone },
    { id: 'invoice', label: 'Create your first invoice', href: '/invoices/new', done: invoiceDone },
    { id: 'send', label: 'Send an invoice', href: '/invoices', done: sendDone },
    { id: 'agent', label: 'Connect your agent', href: '/agents?tab=connect', done: agentDone, ...(agentHint ? { hint: agentHint } : {}) },
  ]

  return steps
}

export function checklistProgress(steps: ChecklistStep[]): { done: number; total: number; percent: number } {
  const total = steps.length
  const done = steps.filter((s) => s.done).length
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  return { done, total, percent }
}
