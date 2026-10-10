import { describe, it, expect } from 'vitest'
import { canUseTool, KEY_PROFILES, toolPermission } from './permissions'
import { TOOL_NAMES } from './tool-catalog'
describe('agent capabilities', () => {
  it('explicitly classifies every exposed tool', () => {
    for (const name of TOOL_NAMES)
      expect(toolPermission(name), name).not.toBeNull()
  })
  it('fails closed for unknown tools even with full permissions', () =>
    expect(canUseTool('transfer_money', KEY_PROFILES.full)).toBe(false))
  it('keeps default keys from sending, deleting or recording payments', () => {
    for (const name of [
      'send_invoice',
      'send_estimate',
      'delete_expense',
      'record_payment',
      'update_payment',
      'void_payment',
    ])
      expect(canUseTool(name, KEY_PROFILES.draft)).toBe(false)
  })
  it('puts correcting and voiding a payment behind the same permission as recording one', () => {
    for (const name of ['record_payment', 'update_payment', 'void_payment']) {
      expect(toolPermission(name), name).toBe('payments')
      expect(canUseTool(name, KEY_PROFILES.billing), name).toBe(true)
    }
  })
  it('permits tracking under a draft key, and denies it under a read-only key', () => {
    expect(canUseTool('heartbeat_task', KEY_PROFILES.draft)).toBe(true)
    expect(canUseTool('heartbeat_task', KEY_PROFILES.readonly)).toBe(false)
  })
})
