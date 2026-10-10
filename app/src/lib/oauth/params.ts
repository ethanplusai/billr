import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Pure request-parameter rules for the OAuth endpoints. No database, no env, so
 * every rejection below is directly testable and the route handlers stay thin.
 */

/** Longest client-supplied string we will store or echo back. */
const MAX_TEXT = 500
const MAX_CLIENT_NAME = 200
const MAX_REDIRECT_URIS = 10

/** Hosts an http:// redirect may name. `[::1]` is how WHATWG URL spells ::1. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Redirect URI allow list.
 *
 * https:// anywhere, plus http:// on the loopback names so a CLI or desktop
 * client can catch the redirect on an ephemeral port (RFC 8252). Everything
 * else is refused: a custom scheme cannot be verified to belong to the client,
 * and plain http to a remote host would put the authorization code on the wire
 * in clear text. Fragments are refused because the code is delivered in the
 * query and a fragment would be dropped or duplicated by the client's parser.
 *
 * All three loopback spellings are accepted. RFC 8252 section 7.3 asks
 * authorization servers to support the IPv6 literal `[::1]` as well as
 * `127.0.0.1`, because an IPv6-only machine cannot bind the IPv4 address at
 * all; `localhost` resolves to either and is accepted alongside them. WHATWG
 * `URL` keeps the brackets in `hostname` for an IPv6 literal, so the
 * comparison is against `[::1]` and not `::1`.
 */
export function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.hash || url.username || url.password) return false
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return LOOPBACK_HOSTS.has(url.hostname)
}

/**
 * Registered redirect URIs are matched exactly, byte for byte. Any "starts
 * with" or host-only comparison lets a registered client redirect the code to a
 * path it never registered, which is the classic open-redirect route to code
 * theft.
 */
export function matchesRegisteredRedirect(
  candidate: string,
  registered: readonly string[]
): boolean {
  return registered.includes(candidate)
}

export function normaliseClientName(value: unknown): string {
  if (typeof value !== 'string') return 'MCP client'
  // Control characters would let a client name smuggle line breaks into the
  // consent screen or a log line.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (!cleaned) return 'MCP client'
  return cleaned.slice(0, MAX_CLIENT_NAME)
}

export interface RedirectUriCheck {
  ok: boolean
  uris: string[]
  reason?: string
}

export function validateRedirectUris(value: unknown): RedirectUriCheck {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, uris: [], reason: 'redirect_uris must be a non-empty array' }
  }
  if (value.length > MAX_REDIRECT_URIS) {
    return { ok: false, uris: [], reason: `redirect_uris may not exceed ${MAX_REDIRECT_URIS} entries` }
  }
  const uris: string[] = []
  for (const entry of value) {
    if (!isAllowedRedirectUri(entry)) {
      return {
        ok: false,
        uris: [],
        reason:
          'redirect_uris must be https:// URLs, or http:// on localhost, 127.0.0.1 or [::1]',
      }
    }
    if (!uris.includes(entry)) uris.push(entry)
  }
  return { ok: true, uris }
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636). S256 only: "plain" offers no protection against an attacker
// who can see the authorization request.
// ---------------------------------------------------------------------------

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/
const CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/

export function isValidCodeChallenge(value: unknown): value is string {
  return typeof value === 'string' && CHALLENGE_RE.test(value)
}

export function isValidCodeVerifier(value: unknown): value is string {
  return typeof value === 'string' && VERIFIER_RE.test(value)
}

export function challengeFromVerifier(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** Constant-time comparison, so a wrong verifier cannot be found byte by byte. */
export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier)) return false
  const computed = Buffer.from(challengeFromVerifier(verifier))
  const expected = Buffer.from(challenge)
  if (computed.length !== expected.length) return false
  return timingSafeEqual(computed, expected)
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** 32 bytes of randomness, URL safe. Used for codes and refresh tokens. */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function generateClientId(): string {
  return `billr_client_${randomBytes(16).toString('hex')}`
}

// ---------------------------------------------------------------------------
// RFC 8707 resource indicators
// ---------------------------------------------------------------------------

/**
 * A resource indicator, when present, must name this installation's MCP server.
 * Accepting anything else would let a client obtain a token it believes is
 * scoped to a different audience.
 */
export function resourceMatches(candidate: string | null | undefined, resource: string): boolean {
  if (!candidate) return true
  try {
    const a = new URL(candidate)
    const b = new URL(resource)
    return (
      a.origin === b.origin &&
      a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '') &&
      !a.hash
    )
  } catch {
    return false
  }
}

/** Builds the redirect back to the client, preserving `state` verbatim. */
export function buildRedirect(
  redirectUri: string,
  params: Record<string, string | null | undefined>
): string {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, value)
  }
  return url.toString()
}

