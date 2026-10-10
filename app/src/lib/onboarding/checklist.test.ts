import { describe, it, expect } from 'vitest'
import { deriveChecklist, checklistProgress, type ChecklistFacts } from '@/lib/onboarding/checklist'

const empty: ChecklistFacts = {
  businessName: null, businessEmail: null, businessPhone: null, businessAddress1: null,
  logoUrl: null, primaryColor: '#2563eb', stripeConfigured: false,
  clientCount: 0, invoiceCount: 0, sentInvoiceCount: 0, apiKeyCount: 0, usedApiKeyCount: 0,
}
const byId = (facts: ChecklistFacts) =>
  Object.fromEntries(deriveChecklist(facts).map((s) => [s.id, s]))

describe('deriveChecklist', () => {
  it('marks nothing done for a brand new business', () => {
    expect(deriveChecklist(empty).every((s) => !s.done)).toBe(true)
  })
  it('business needs a name plus one contact field', () => {
    expect(byId({ ...empty, businessName: 'Acme' }).business.done).toBe(false)
    expect(byId({ ...empty, businessName: 'Acme', businessPhone: '555' }).business.done).toBe(true)
  })
  it('branding is done by logo or a non-default color', () => {
    expect(byId({ ...empty, logoUrl: 'https://x/logo.png' }).branding.done).toBe(true)
    expect(byId({ ...empty, primaryColor: '#ff0000' }).branding.done).toBe(true)
    expect(byId({ ...empty, primaryColor: '#2563eb' }).branding.done).toBe(false)
  })
  it('agent step needs a USED key, and hints when a key exists but is unused', () => {
    const created = byId({ ...empty, apiKeyCount: 1, usedApiKeyCount: 0 }).agent
    expect(created.done).toBe(false)
    expect(created.hint).toBeTruthy()
    expect(byId({ ...empty, apiKeyCount: 1, usedApiKeyCount: 1 }).agent.done).toBe(true)
  })
  it('asks for Stripe keys and is done once card payments are configured', () => {
    expect(byId(empty).stripe).toMatchObject({
      label: 'Add your Stripe keys',
      href: '/agents?tab=payments',
      done: false,
    })
    expect(byId({ ...empty, stripeConfigured: true }).stripe.done).toBe(true)
  })
  it('counts drive the client, invoice, and send steps', () => {
    const facts = { ...empty, clientCount: 1, invoiceCount: 2, sentInvoiceCount: 1 }
    const s = byId(facts)
    expect([s.client.done, s.invoice.done, s.send.done]).toEqual([true, true, true])
  })
})

describe('checklistProgress', () => {
  it('reports done, total, and percent', () => {
    const steps = deriveChecklist({ ...empty, clientCount: 1 })
    expect(checklistProgress(steps)).toEqual({ done: 1, total: 7, percent: 14 })
  })
})
