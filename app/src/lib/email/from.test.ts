import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatFromAddress, invoiceFromEmail } from './from'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('invoiceFromEmail', () => {
  it('uses RESEND_INVOICE_FROM', () => {
    vi.stubEnv('RESEND_INVOICE_FROM', ' invoices@fieldstone.example ')
    expect(invoiceFromEmail()).toBe('invoices@fieldstone.example')
  })

  it('refuses to guess a sender when none is configured', () => {
    vi.stubEnv('RESEND_INVOICE_FROM', '')
    expect(() => invoiceFromEmail()).toThrow('RESEND_INVOICE_FROM')
  })
})

describe('formatFromAddress', () => {
  it('wraps the address in a display name', () => {
    expect(formatFromAddress('Fieldstone Digital', 'invoices@fieldstone.example')).toBe(
      'Fieldstone Digital <invoices@fieldstone.example>',
    )
  })

  it('strips characters that could inject headers', () => {
    expect(formatFromAddress('Evil\r\nBcc: x', 'a@b.example')).toBe('EvilBcc: x <a@b.example>')
  })
})
