/**
 * The one place an outbound invoice or estimate subject line is built.
 *
 * A subject lands in a mail header. Resend is a JSON HTTPS API, so a CR or LF
 * in this field does not become a second header the way it would through a raw
 * SMTP client, but the guarantee belongs to the function that builds the header
 * rather than to the transport that happens to be in front of it today. The
 * subject is sanitised here, in one place, before it reaches the transport.
 *
 * Three rules, in order:
 *   1. CR, LF and every other C0/C7f control character become a space, so no
 *      caller can start a new header line or hide text from a log;
 *   2. runs of whitespace collapse and the result is trimmed;
 *   3. the result is capped. RFC 5322 recommends unfolded header lines stay
 *      under 998 octets; 200 characters is well inside that and is already
 *      longer than any subject the product generates.
 */
export const MAX_SUBJECT_LENGTH = 200

export function safeSubject(value: string | null | undefined, fallback: string): string {
  const cleaned = (value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SUBJECT_LENGTH)
  if (cleaned) return cleaned
  // The fallback is built by this codebase, but it interpolates a business
  // name, so it goes through exactly the same cleaning rather than around it.
  const safeFallback = fallback
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SUBJECT_LENGTH)
  return safeFallback || 'Billr'
}
