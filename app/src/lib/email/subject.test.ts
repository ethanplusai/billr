import { describe, expect, it } from 'vitest'
import { MAX_SUBJECT_LENGTH, safeSubject } from './subject'

const FALLBACK = 'Invoice INV-0001 from Fieldstone Digital'

describe('safeSubject', () => {
  it('keeps an ordinary subject as written', () => {
    expect(safeSubject('Your March invoice', FALLBACK)).toBe('Your March invoice')
  })

  it('strips CR and LF so a subject cannot start a second header line', () => {
    const injected = 'Invoice 1\r\nBcc: attacker@evil.example'
    const result = safeSubject(injected, FALLBACK)
    expect(result).not.toContain('\r')
    expect(result).not.toContain('\n')
    expect(result).toBe('Invoice 1 Bcc: attacker@evil.example')
  })

  it('strips other control characters', () => {
    expect(safeSubject('Invoice\u00001\u0007 due\u007f', FALLBACK)).toBe('Invoice 1 due')
  })

  it('caps the length', () => {
    const result = safeSubject('x'.repeat(5000), FALLBACK)
    expect(result).toHaveLength(MAX_SUBJECT_LENGTH)
  })

  it('falls back when the caller sends nothing usable', () => {
    expect(safeSubject(undefined, FALLBACK)).toBe(FALLBACK)
    expect(safeSubject('   ', FALLBACK)).toBe(FALLBACK)
    expect(safeSubject('\r\n\t', FALLBACK)).toBe(FALLBACK)
  })

  it('cleans the fallback too, because it interpolates a business name', () => {
    const result = safeSubject('', 'Invoice 1 from Evil\r\nBcc: attacker@evil.example')
    expect(result).toBe('Invoice 1 from Evil Bcc: attacker@evil.example')
  })

  it('never returns an empty subject', () => {
    expect(safeSubject('', '\r\n')).toBe('Billr')
  })
})
