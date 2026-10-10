import { guardedServer } from '@/lib/mcp/guarded-server'
import { metadataResponse, protectedResourceMetadata } from '@/lib/oauth/metadata'
import { createMcpHandler } from 'mcp-handler'
import { getMcpContext } from '@/lib/mcp/context'
import { serverInfo } from '@/lib/mcp/shared'
import { registerTaskTools } from '@/lib/mcp/tools/tasks'
import { registerClientTools } from '@/lib/mcp/tools/clients'
import { registerInvoiceReadTools } from '@/lib/mcp/tools/invoices-read'
import { registerInvoiceWriteTools } from '@/lib/mcp/tools/invoices-write'
import { registerInvoiceSendTools } from '@/lib/mcp/tools/invoices-send'
import { registerWorkTools } from '@/lib/mcp/tools/work'
import { registerInfoTools } from '@/lib/mcp/tools/info'
import { registerEstimateTools } from '@/lib/mcp/tools/estimates'
import { registerItemTools } from '@/lib/mcp/tools/items'
import { registerTimeTools } from '@/lib/mcp/tools/time'
import { registerExpenseTools } from '@/lib/mcp/tools/expenses'
import { registerPaymentTools } from '@/lib/mcp/tools/payments'
import { registerEngagementTools } from '@/lib/mcp/tools/engagements'
import { registerBillrWidgets } from '@/lib/mcp/widgets'

export const runtime = 'nodejs'

/**
 * MCP server route. Stateless: a fresh McpServer is created per request and
 * closes over the authenticated/scoped ctx resolved for that request, so
 * every tool handler runs with { userId, businessIds, db } already scoped
 * to the caller's API key. See src/lib/mcp/context.ts.
 *
 * The tool registration pattern and the "every handler must scope via
 * ctx.db" contract live as a comment in src/lib/mcp/shared.ts (next to
 * serverInfo) rather than here, so it travels with the shared helpers new
 * tool files import.
 */
/**
 * The protected-resource document must be served before a client has a token,
 * so a probe that appends the well-known path to the resource URL (rather than
 * using RFC 9728's path-suffix form) is answered here instead of with a 401.
 */
function isProtectedResourceProbe(req: Request): boolean {
  const { pathname } = new URL(req.url)
  return pathname.replace(/\/+$/, '').endsWith('/.well-known/oauth-protected-resource')
}

async function handleRequest(req: Request): Promise<Response> {
  if (isProtectedResourceProbe(req)) return metadataResponse(protectedResourceMetadata())

  const ctx = await getMcpContext(req)
  if (ctx instanceof Response) return ctx

  const handler = createMcpHandler(
    (rawServer) => {
      const server = guardedServer(rawServer, ctx)
      registerTaskTools(server, ctx)
      registerClientTools(server, ctx)
      registerInvoiceReadTools(server, ctx)
      registerInvoiceWriteTools(server, ctx)
      registerInvoiceSendTools(server, ctx)
      registerWorkTools(server, ctx)
      registerInfoTools(server, ctx)
      registerEstimateTools(server, ctx)
      registerItemTools(server, ctx)
      registerTimeTools(server, ctx)
      registerExpenseTools(server, ctx)
      registerPaymentTools(server, ctx)
      registerEngagementTools(server, ctx)
      // The cards some tools render in ChatGPT and Codex. Static HTML, no data.
      registerBillrWidgets(server)
    },
    // Billr's MCP server is stateless; refusing resource subscriptions
    // outright keeps per-request state at zero.
    { serverInfo, maxSubscriptions: 0 }
  )

  return handler(req)
}

export { handleRequest as GET, handleRequest as POST }
