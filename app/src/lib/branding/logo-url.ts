/**
 * Where a business logo may live.
 *
 * `businesses.logo_url` is written by the branding settings action and then
 * read back in three places that are not all equally forgiving: an `<img src>`
 * on the invoice page and both public document pages, and a server-side
 * `fetch` in the PDF renderer that is reachable UNAUTHENTICATED through
 * `/api/public/invoices/[publicId]/pdf`.
 *
 * The application audit recorded two findings against that (Low-2 and Low-3):
 * `z.string().url()` accepts `javascript:`, `data:` and `file:` in zod 4, and
 * the PDF route will fetch any public `https` host an owner names, which makes
 * it a request amplifier and puts an attacker-chosen origin inside a document
 * the business sends to its own clients.
 *
 * Both are closed the same way: a logo is only ever the installation's own
 * Supabase storage origin, which is also the only origin the branding page can
 * upload to. Everything is derived from `NEXT_PUBLIC_SUPABASE_URL`, so a
 * install validates against its own database.
 */

/** Public objects are served from this path prefix by Supabase Storage. */
const PUBLIC_OBJECT_PREFIX = '/storage/v1/object/public/'

/** The one bucket a logo is uploaded to. */
const LOGO_BUCKET = 'logos'

export const MAX_LOGO_URL_LENGTH = 2000

/** The configured Supabase origin, or null when nothing usable is configured. */
export function supabaseStorageOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * True when `value` is a logo this installation is willing to render or fetch.
 *
 * https is required, with one deliberate exception: the Supabase CLI's local
 * stack is served over plain http on loopback, and refusing that would make the
 * branding page unusable in development for no security gain (the origin still
 * has to match, so nothing else becomes reachable). An installation
 * configured with an https Supabase URL can never take http here,
 * because the origin comparison already fails on the scheme.
 */
export function isAllowedLogoUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > MAX_LOGO_URL_LENGTH) return false
  const origin = supabaseStorageOrigin()
  if (!origin) return false
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  // Origin carries the scheme, the host and the port, so this single
  // comparison is what refuses javascript:, data:, file: and every other host.
  if (parsed.origin !== origin) return false
  if (parsed.username || parsed.password) return false
  return parsed.pathname.startsWith(`${PUBLIC_OBJECT_PREFIX}${LOGO_BUCKET}/`)
}

/** Message shown to a person, and recorded in the branding action's tests. */
export const LOGO_URL_MESSAGE =
  'A logo must be uploaded to this installation and served from its own storage.'
