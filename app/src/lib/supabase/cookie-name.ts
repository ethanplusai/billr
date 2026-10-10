/** Keep the browser/server cookie identity equal when Docker uses an internal API URL. */
export function authCookieName(publicUrl: string): string {
  // Matches supabase-js's default cookie name, so existing sessions stay valid.
  return `sb-${new URL(publicUrl).hostname.split('.')[0]}-auth-token`
}
