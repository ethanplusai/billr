import { describe, it, expect } from 'vitest'
import {
  generateAccessToken,
  generateApiKey,
  hashApiKey,
  isValidKeyFormat,
} from '@/lib/api-keys/crypto'

describe('api key crypto', () => {
  it('generates billr_sk_ + 48 hex chars', () => {
    const { secret } = generateApiKey()
    expect(secret).toMatch(/^billr_sk_[0-9a-f]{48}$/)
  })

  it('generates unique secrets', () => {
    expect(generateApiKey().secret).not.toBe(generateApiKey().secret)
  })

  it('hash is deterministic sha256 hex of the secret', () => {
    const { secret, hash } = generateApiKey()
    expect(hash).toBe(hashApiKey(secret))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('prefix is the first 12 chars of the secret', () => {
    const { secret, prefix } = generateApiKey()
    expect(prefix).toBe(secret.slice(0, 12))
    expect(prefix).toMatch(/^billr_sk_[0-9a-f]{3}$/)
  })

  it('matches the golden-vector hash for a known input', () => {
    expect(hashApiKey('billr_sk_' + 'a'.repeat(48))).toBe(
      'a1dde26e4b0f73d5b4a8f12fe23b19310b9def53437dd11ae97c898c65e04313'
    )
  })

  it('validates key format', () => {
    expect(isValidKeyFormat('billr_sk_' + 'a'.repeat(48))).toBe(true)
    expect(isValidKeyFormat('billr_sk_short')).toBe(false)
    expect(isValidKeyFormat('sk_' + 'a'.repeat(48))).toBe(false)
  })

  it('mints OAuth access tokens in the same shape under a billr_at_ prefix', () => {
    const { secret, hash, prefix } = generateAccessToken()
    expect(secret).toMatch(/^billr_at_[0-9a-f]{48}$/)
    expect(hash).toBe(hashApiKey(secret))
    expect(prefix).toBe(secret.slice(0, 12))
    // resolveApiKey gates on this, so an OAuth token must pass it.
    expect(isValidKeyFormat(secret)).toBe(true)
  })

  it('still rejects anything that is neither prefix', () => {
    expect(isValidKeyFormat('billr_rt_' + 'a'.repeat(48))).toBe(false)
    expect(isValidKeyFormat('billr_at_' + 'A'.repeat(48))).toBe(false)
  })
})
