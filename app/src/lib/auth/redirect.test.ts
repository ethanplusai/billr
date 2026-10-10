import { describe, expect, it } from 'vitest'
import { safeAuthRedirect } from './redirect'

describe('authentication return paths', () => {
  it.each(['/invoices/new', '/agents?tab=keys', '/reset-password'])(
    'preserves local destination %s',
    (path) => {
      expect(safeAuthRedirect(path)).toBe(path)
    },
  )
  it.each([
    null,
    '',
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/%5cevil.example',
    '/%2fexample.com',
    '/%0a/evil.example',
    'javascript:alert(1)',
    '/%zz',
  ])('rejects unsafe destination %s', (path) => {
    expect(safeAuthRedirect(path)).toBe('/dashboard')
  })
})
