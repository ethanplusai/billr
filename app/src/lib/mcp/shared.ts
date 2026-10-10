/**
 * Cross-cutting helpers shared by every MCP tool file, so route.ts stays a
 * thin registrar and each tool file doesn't redefine the same primitives.
 *
 * Tool registration pattern (copy for new tools):
 *   server.registerTool(name, { title, description, inputSchema: z.object({...}) }, async (input) => {...})
 * Every handler must resolve business access via ctx.db (resolveBusinessId /
 * assertClientAccess / assertInvoiceAccess) before querying ctx.db.svc; a
 * bare ctx.db.svc query without one of those scoping calls is not allowed.
 */

import { appOrigin } from '@/lib/deployment'
import { todayISO } from '@/lib/dates'

export const serverInfo = { name: 'billr', version: '1.0.0' }

/**
 * Base URL for both app links (e.g. /invoices/:id) and public/shareable
 * links (e.g. /i/:publicId, /api/public/invoices/:publicId/pdf). Single
 * source so every tool file resolves the same env var with the same
 * fallback rather than each hardcoding its own copy.
 */
export function appUrl(): string {
  return appOrigin()
}

export function publicUrl(publicId: string): string {
  return `${appUrl()}/i/${publicId}`
}

export function pdfUrl(publicId: string): string {
  return `${appUrl()}/api/public/invoices/${publicId}/pdf`
}

/**
 * Escapes PostgREST `ilike` wildcards (% and _) so a literal value containing
 * either character (e.g. "50% Off Co") is matched exactly rather than as a
 * pattern. Single source shared by every ilike call site (client lookup in
 * invoices-write.ts, duplicate-name checks in clients.ts) so escaping can't
 * drift between them.
 */
export function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (m) => `\\${m}`)
}

/**
 * Wraps a value so PostgREST reads it as a literal inside a logic tree.
 *
 * `escapeLike` only neutralises SQL's `%` and `_`. It does nothing about
 * PostgREST's OWN grammar, and `.or()` takes a raw filter expression, so a
 * search term containing a comma or a dot is parsed as more filters:
 *
 *     search = 'a,nosuchcol.eq.1,name.ilike.'
 *     or=(name.ilike.%a,nosuchcol.eq.1,name.ilike.%,email.ilike.%a,...%)
 *     => 42703 column clients.nosuchcol does not exist
 *
 * Double quotes make the whole thing one literal. Inside them PostgREST
 * unescapes `\"` and `\\`, so those two are the only characters that need
 * escaping here; `\%` (what escapeLike emits) survives quoting untouched.
 */
export function quoteFilterValue(value: string): string {
  return `"${value.replace(/["\\]/g, (m) => `\\${m}`)}"`
}

/**
 * A PostgREST `or` expression matching `search` as a substring of any of
 * `columns`. Built here rather than at each call site so the quoting above can
 * never be forgotten by the next one.
 */
export function likeAnyFilter(columns: readonly string[], search: string): string {
  const pattern = quoteFilterValue(`%${escapeLike(search)}%`)
  return columns.map((column) => `${column}.ilike.${pattern}`).join(',')
}

/**
 * Appends a truncation notice to a summary when a query came back exactly at
 * its row cap, so callers know derived totals may be incomplete rather than
 * silently trusting a partial set.
 */
export function truncationNote(cap: number): string {
  return ` (results truncated at ${cap}; totals may be incomplete)`
}

export function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const }
}

export function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}

export function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount)
  } catch {
    // Unknown/invalid currency code: fall back to a labeled plain number
    // rather than letting Intl throw.
    return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
  }
}

export const UNPAID_STATUSES = ['sent', 'viewed', 'partial', 'overdue']
const OVERDUE_ELIGIBLE_STATUSES = [
  'sent',
  'viewed',
  'partial',
  'overdue',
]

export function isOverdue(status: string, dueDate: string): boolean {
  const today = todayISO()
  return OVERDUE_ELIGIBLE_STATUSES.includes(status) && dueDate < today
}
