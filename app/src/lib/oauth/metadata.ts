import { DOCS_URL, appOrigin, mcpUrl } from '@/lib/deployment'
import { OAUTH_SCOPES } from './scopes'

/**
 * Discovery documents for the MCP authorization spec (2025-06-18).
 *
 * The resource is https://<origin>/api/mcp, so RFC 9728's path-suffix form
 * applies: https://<origin>/.well-known/oauth-protected-resource/api/mcp
 *
 * The authorization server is the app origin: consent needs the signed-in
 * session, and the session cookie lives on the app origin.
 */

const OAUTH_ENDPOINT_PATHS = {
  authorize: '/oauth/authorize',
  token: '/api/oauth/token',
  register: '/api/oauth/register',
  protectedResource: '/.well-known/oauth-protected-resource',
  authorizationServer: '/.well-known/oauth-authorization-server',
} as const

export interface ProtectedResourceMetadata {
  resource: string
  authorization_servers: string[]
  scopes_supported: string[]
  bearer_methods_supported: string[]
  resource_documentation?: string
}

export interface AuthorizationServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint: string
  response_types_supported: string[]
  response_modes_supported: string[]
  grant_types_supported: string[]
  token_endpoint_auth_methods_supported: string[]
  code_challenge_methods_supported: string[]
  scopes_supported: string[]
  authorization_response_iss_parameter_supported: boolean
  /** RFC 8707: the token endpoint accepts and checks `resource`. */
  resource_indicators_supported: boolean
  service_documentation?: string
}

export function protectedResourceMetadata(): ProtectedResourceMetadata {
  return {
    resource: mcpUrl(),
    authorization_servers: [appOrigin()],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_documentation: DOCS_URL,
  }
}

export function authorizationServerMetadata(): AuthorizationServerMetadata {
  const origin = appOrigin()
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${OAUTH_ENDPOINT_PATHS.authorize}`,
    token_endpoint: `${origin}${OAUTH_ENDPOINT_PATHS.token}`,
    registration_endpoint: `${origin}${OAUTH_ENDPOINT_PATHS.register}`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // Public clients only. There is no place to keep a secret in a desktop
    // agent or a CLI, so PKCE is the proof instead.
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [...OAUTH_SCOPES],
    authorization_response_iss_parameter_supported: true,
    resource_indicators_supported: true,
    service_documentation: DOCS_URL,
  }
}

/**
 * The path portion of the MCP resource, without a trailing slash. "" when the
 * resource is a bare origin.
 */
export function mcpResourcePath(): string {
  const path = new URL(mcpUrl()).pathname.replace(/\/+$/, '')
  return path === '/' ? '' : path
}

/**
 * Absolute URL of this installation's protected-resource metadata, as sent in
 * WWW-Authenticate: the RFC 9728 path-suffix form on the app origin.
 */
export function protectedResourceMetadataUrl(): string {
  const resource = new URL(mcpUrl())
  const path = mcpResourcePath()
  return `${resource.origin}${OAUTH_ENDPOINT_PATHS.protectedResource}${path}`
}

/**
 * True when `suffix` (the catch-all segments after
 * /.well-known/oauth-protected-resource) addresses this installation's MCP
 * server. A mismatch must 404 rather than hand back metadata for a resource
 * this server does not protect.
 */
export function matchesResourceSuffix(segments: string[] | undefined): boolean {
  const requested = `/${(segments ?? []).join('/')}`.replace(/\/+$/, '')
  return (requested === '' ? '' : requested) === mcpResourcePath()
}

/** Response helper: discovery documents are public, cacheable, and CORS-open. */
export function metadataResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Public, non-secret documents. Clients fetch them on every connect.
      'Cache-Control': 'public, max-age=300',
      // Browser-based MCP clients read these cross-origin before any token
      // exists; there is nothing here to protect.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
  })
}
