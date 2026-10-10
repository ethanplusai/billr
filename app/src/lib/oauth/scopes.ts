/**
 * OAuth scopes are the API-key permission names, one for one.
 *
 * There is deliberately no second vocabulary: a granted scope becomes the
 * `permissions` array on the api_keys row the token endpoint mints, which is
 * what src/lib/mcp/permissions.ts already checks per tool call. Inventing
 * OAuth-only scope names would mean two lists to keep in sync and one of them
 * would drift.
 */
export const OAUTH_SCOPES = ['read', 'write', 'send', 'delete', 'payments'] as const

export type OauthScope = (typeof OAUTH_SCOPES)[number]

/**
 * Granted by default, matching the "Read and draft (recommended)" profile the
 * API keys panel offers. Drafting is useless without reading, so `read` is the
 * floor of every grant.
 */
export const DEFAULT_PERMISSIONS: readonly OauthScope[] = ['read', 'write']

/**
 * The consent screen's checkboxes, in the order they are shown. Each carries
 * the one-line consequence a person needs to decide, phrased the way the API
 * keys panel phrases the same authority ("draft, send and record payments",
 * "delete unbilled work").
 */
export interface ConsentChoice {
  permission: OauthScope
  label: string
  consequence: string
  /** Rendered but not toggleable: reading is the floor of any grant. */
  fixed?: boolean
}

export const CONSENT_CHOICES: readonly ConsentChoice[] = [
  {
    permission: 'read',
    label: 'Read your business data',
    consequence: 'Sees clients, invoices, estimates, time, expenses and revenue totals.',
    fixed: true,
  },
  {
    permission: 'write',
    label: 'Draft and edit',
    consequence: 'Creates and edits drafts, clients, items, time and expenses. Nothing is sent.',
  },
  {
    permission: 'send',
    label: 'Send invoices and estimates',
    consequence: 'Emails invoices and estimates to your clients on your behalf.',
  },
  {
    permission: 'payments',
    label: 'Record payments',
    consequence: 'Records payments against invoices and marks them paid.',
  },
  {
    permission: 'delete',
    label: 'Delete unbilled work',
    consequence: 'Permanently deletes time entries and expenses that have not been billed.',
  },
]

/** Always shown alongside the choices; the MCP tools enforce it. */
export const CONSENT_FOOTNOTE =
  'Task pricing and billing approval always require a human. Access expires in 30 days unless the agent refreshes it.'

function isOauthScope(value: string): value is OauthScope {
  return (OAUTH_SCOPES as readonly string[]).includes(value)
}

/** Parses a space-delimited `scope` parameter, dropping anything unknown. */
export function parseScope(scope: string | null | undefined): OauthScope[] {
  if (!scope) return []
  const seen = new Set<OauthScope>()
  for (const token of scope.split(/\s+/)) {
    if (isOauthScope(token)) seen.add(token)
  }
  return OAUTH_SCOPES.filter((s) => seen.has(s))
}

/**
 * What the consent screen should start with.
 *
 * No scope at all means the recommended profile. A scope that asks for more
 * pre-ticks those boxes; the person can still untick them, which is the point
 * of showing them. `read` is forced on because every other permission implies
 * looking at the data it acts on.
 */
export function requestedPermissions(scope: string | null | undefined): OauthScope[] {
  const asked = parseScope(scope)
  if (asked.length === 0) return [...DEFAULT_PERMISSIONS]
  const withRead = new Set<OauthScope>([...asked, 'read'])
  return OAUTH_SCOPES.filter((s) => withRead.has(s))
}

/**
 * Normalises whatever the consent form (or a refresh request) asked for down to
 * a grant we are willing to store: known scopes only, `read` always present,
 * never wider than `allowed` when a ceiling is supplied.
 */
export function narrowPermissions(
  requested: readonly string[],
  allowed?: readonly string[]
): OauthScope[] {
  const ceiling = allowed ? new Set(allowed) : null
  const granted = new Set<OauthScope>()
  for (const value of requested) {
    if (!isOauthScope(value)) continue
    if (ceiling && !ceiling.has(value)) continue
    granted.add(value)
  }
  if (!ceiling || ceiling.has('read')) granted.add('read')
  return OAUTH_SCOPES.filter((s) => granted.has(s))
}

/** True when every requested scope is inside the granted set. */
export function isSubsetOf(requested: readonly string[], granted: readonly string[]): boolean {
  return requested.every((value) => granted.includes(value))
}

export function formatScope(permissions: readonly string[]): string {
  return permissions.join(' ')
}
