import { describe, expect, it } from 'vitest'
import {
  CONSENT_CHOICES,
  DEFAULT_PERMISSIONS,
  OAUTH_SCOPES,
  formatScope,
  isSubsetOf,
  narrowPermissions,
  parseScope,
  requestedPermissions,
} from './scopes'

describe('scope parsing', () => {
  it('reads a space-delimited scope and drops anything unknown', () => {
    expect(parseScope('read write send')).toEqual(['read', 'write', 'send'])
    expect(parseScope('read  payments')).toEqual(['read', 'payments'])
    expect(parseScope('admin root')).toEqual([])
    expect(parseScope(undefined)).toEqual([])
  })

  it('returns scopes in a stable order regardless of request order', () => {
    expect(parseScope('payments read')).toEqual(['read', 'payments'])
  })
})

describe('what the consent screen starts with', () => {
  it('defaults to read and draft when no scope is requested', () => {
    expect(requestedPermissions(null)).toEqual([...DEFAULT_PERMISSIONS])
  })

  it('pre-selects the requested scopes and always includes read', () => {
    expect(requestedPermissions('write send')).toEqual(['read', 'write', 'send'])
    expect(requestedPermissions('delete')).toEqual(['read', 'delete'])
  })

  it('honours a request narrower than the default', () => {
    expect(requestedPermissions('read')).toEqual(['read'])
  })

  it('falls back to the default when the scope names nothing we know', () => {
    expect(requestedPermissions('openid profile')).toEqual([...DEFAULT_PERMISSIONS])
  })
})

describe('narrowing', () => {
  it('keeps only known scopes', () => {
    expect(narrowPermissions(['read', 'write', 'root'])).toEqual(['read', 'write'])
  })

  it('never grants above the ceiling, which is how a refresh cannot widen', () => {
    expect(narrowPermissions(['read', 'write', 'send'], ['read', 'write'])).toEqual([
      'read',
      'write',
    ])
  })

  it('lets a person narrow what the client asked for', () => {
    const asked = requestedPermissions('write send payments delete')
    expect(asked).toEqual(['read', 'write', 'send', 'delete', 'payments'])
    // The consent screen unticked send, payments and delete.
    expect(narrowPermissions(['read', 'write'], asked)).toEqual(['read', 'write'])
  })

  it('always leaves read in a grant', () => {
    expect(narrowPermissions([])).toEqual(['read'])
    expect(narrowPermissions(['write'])).toEqual(['read', 'write'])
  })

  it('checks subsets for the refresh grant', () => {
    expect(isSubsetOf(['read'], ['read', 'write'])).toBe(true)
    expect(isSubsetOf(['read', 'send'], ['read', 'write'])).toBe(false)
  })

  it('formats a scope string back for the token response', () => {
    expect(formatScope(['read', 'write'])).toBe('read write')
  })
})

describe('consent copy', () => {
  it('offers exactly one line per permission, with read fixed', () => {
    // Order is the screen's (riskiest last), not the scope list's.
    expect([...CONSENT_CHOICES.map((c) => c.permission)].sort()).toEqual([...OAUTH_SCOPES].sort())
    expect(CONSENT_CHOICES.filter((c) => c.fixed).map((c) => c.permission)).toEqual(['read'])
    for (const choice of CONSENT_CHOICES) {
      expect(choice.consequence.length).toBeGreaterThan(20)
    }
  })
})
