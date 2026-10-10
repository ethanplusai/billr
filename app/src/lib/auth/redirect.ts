/** Keep authentication return paths on this app, including URL-normalization edge cases. */
export function safeAuthRedirect(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//'))
    return '/dashboard'
  try {
    const decoded = decodeURIComponent(value)
    if (decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded))
      return '/dashboard'
    const url = new URL(value, 'https://billr.invalid')
    return url.origin === 'https://billr.invalid'
      ? `${url.pathname}${url.search}${url.hash}`
      : '/dashboard'
  } catch {
    return '/dashboard'
  }
}
