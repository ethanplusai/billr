/**
 * The sender for invoice and estimate email: RESEND_INVOICE_FROM, an address
 * on a domain you verified in your own Resend account.
 */
export function invoiceFromEmail(): string {
  const value = process.env.RESEND_INVOICE_FROM?.trim()
  if (!value)
    throw new Error(
      'Configure RESEND_INVOICE_FROM, an address on a domain you verified in Resend',
    )
  return value
}

/**
 * Wraps an address in a display name, defensively.
 *
 * A display name lands in the From header, so a CR, LF or angle bracket in it
 * would let the caller append headers of their own. None of the current call
 * sites pass untrusted text, but this is the function that builds the header
 * so this is where the guarantee belongs.
 */
export function formatFromAddress(displayName: string, email: string): string {
  const name = displayName.replace(/[\r\n<>"]/g, '').trim()
  const address = email.replace(/[\r\n<>]/g, '').trim()
  if (!address) throw new Error('An email sender address is required')
  return name ? `${name} <${address}>` : address
}
