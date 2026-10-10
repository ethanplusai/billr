import { authorizationServerMetadata, metadataResponse } from '@/lib/oauth/metadata'

/**
 * RFC 8414 authorization-server metadata, served on the app origin because that
 * is the issuer: consent needs the signed-in session, and the session cookie
 * lives here, not on the MCP host.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return metadataResponse(authorizationServerMetadata())
}

export async function OPTIONS(): Promise<Response> {
  return metadataResponse(authorizationServerMetadata())
}
