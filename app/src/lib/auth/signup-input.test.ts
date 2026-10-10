import { describe, expect, it } from 'vitest'
import { parseSignUpInput } from './signup-input'

const VALID = {
  email: 'person@example.com',
  password: 'correct-horse-battery',
  fullName: 'Harper Lane',
}

describe('parseSignUpInput', () => {
  it('accepts a complete request', () => {
    const result = parseSignUpInput(VALID)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.fullName).toBe('Harper Lane')
  })

  it('still validates the rest of the form', () => {
    expect(parseSignUpInput({ ...VALID, email: 'nope' }).success).toBe(false)
    expect(parseSignUpInput({ ...VALID, password: 'short' }).success).toBe(false)
    expect(parseSignUpInput({ ...VALID, fullName: ' ' }).success).toBe(false)
  })
})
