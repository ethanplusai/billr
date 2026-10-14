/** Public installation settings. Never put credentials in this module. */
export function appOrigin(): string {
  const value = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'NEXT_PUBLIC_APP_URL must be an HTTP(S) origin without a path or credentials',
    )
  }
  return url.origin
}

/** The MCP endpoint agents connect to on this installation. */
export function mcpUrl(): string {
  return `${appOrigin()}/api/mcp`
}

/** Public documentation for the in-app help links. */
export const DOCS_URL = 'https://billr.cc/docs'

/** Step-by-step agent connection guide for each client. */
export const AGENT_DOCS_URL =
  'https://billr.cc/docs/connect'
