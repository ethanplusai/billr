import { metadataResponse, protectedResourceMetadata } from '@/lib/oauth/metadata'

/**
 * Root form of the protected-resource document, for clients that only know
 * this spelling. The path-suffix form (RFC 9728) lives in ./[...suffix]/route.ts.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return metadataResponse(protectedResourceMetadata())
}

export async function OPTIONS(): Promise<Response> {
  return metadataResponse(protectedResourceMetadata())
}
