import { createHash, randomBytes } from 'crypto'

/**
 * Two prefixes, one table.
 *
 *   billr_sk_  a key a person created in the Agents panel and pasted somewhere
 *   billr_at_  an access token minted by the OAuth consent flow
 *
 * Both are api_keys rows, both are SHA-256 hashed at rest, and resolveApiKey
 * treats them identically. The prefix exists so a leaked string can be traced
 * to how it was issued (and so an OAuth token is visibly not something a user
 * should be pasting into a config file by hand).
 */
const KEY_RE = /^billr_(?:sk|at)_[0-9a-f]{48}$/

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

function mint(prefix: 'sk' | 'at'): { secret: string; hash: string; prefix: string } {
  const secret = `billr_${prefix}_${randomBytes(24).toString('hex')}`
  return { secret, hash: hashApiKey(secret), prefix: secret.slice(0, 12) }
}

export function generateApiKey(): { secret: string; hash: string; prefix: string } {
  return mint('sk')
}

/** OAuth access token. Same shape and storage as a manual key. */
export function generateAccessToken(): { secret: string; hash: string; prefix: string } {
  return mint('at')
}

export function isValidKeyFormat(secret: string): boolean {
  return KEY_RE.test(secret)
}
