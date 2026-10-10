import { matchesResourceSuffix, metadataResponse, protectedResourceMetadata } from '@/lib/oauth/metadata'

/**
 * RFC 9728 path-suffix form: the resource's path is appended to the well-known
 * path, so an MCP server at https://example.org/api/mcp publishes its
 * metadata at https://example.org/.well-known/oauth-protected-resource/api/mcp.
 *
 * A suffix that names some other path is a question about a resource this
 * server does not protect, so it gets a 404 rather than this server's document.
 */
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ suffix?: string[] }> }
): Promise<Response> {
  const { suffix } = await ctx.params
  if (!matchesResourceSuffix(suffix)) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  }
  return metadataResponse(protectedResourceMetadata())
}
