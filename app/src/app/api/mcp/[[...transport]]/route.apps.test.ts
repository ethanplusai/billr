import { describe, expect, it, vi } from 'vitest'

/**
 * The MCP route as a ChatGPT or Codex plugin host sees it: tools/list carries
 * the card and auth metadata, and the ui:// cards can be listed and read.
 * Driven through the real SDK handler with a stub request context, so a change
 * in how the SDK serialises `_meta` or resources would show up here.
 */

vi.mock('@/lib/deployment', () => ({
  appOrigin: () => 'https://invoices.example.org',
  mcpUrl: () => 'https://invoices.example.org/api/mcp',
}))

vi.mock('@/lib/mcp/context', () => ({
  getMcpContext: async () => ({
    keyId: 'k1',
    userId: 'u1',
    businessIds: ['b1'],
    permissions: ['read'],
    db: { scope: { userId: 'u1', businessIds: ['b1'] }, svc: {} },
  }),
}))

import { POST } from './route'

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const response = await POST(
    new Request('https://invoices.example.org/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  )
  const text = await response.text()
  // Streamable HTTP may answer as an SSE frame; take the JSON out of it.
  const json = text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:'))!.slice(5)
  return JSON.parse(json) as { result?: Record<string, unknown>; error?: unknown }
}

describe('MCP route, plugin host view', () => {
  it('lists card and auth metadata on tools', async () => {
    const { result, error } = await rpc('tools/list')
    expect(error).toBeUndefined()
    const tools = result!.tools as { name: string; _meta?: Record<string, unknown> }[]
    const invoice = tools.find((t) => t.name === 'get_invoice')!
    expect(invoice._meta).toMatchObject({
      ui: { resourceUri: 'ui://billr/invoice-v1.html' },
      'openai/outputTemplate': 'ui://billr/invoice-v1.html',
      securitySchemes: [{ type: 'oauth2', scopes: ['read'] }],
    })
    const profile = tools.find((t) => t.name === 'get_profile')!
    expect(profile._meta).toMatchObject({ 'openai/profile': true })
    // A read-only connection still never sees write tools.
    expect(tools.some((t) => t.name === 'create_invoice')).toBe(false)
  })

  it('lists and serves the cards as MCP Apps resources', async () => {
    const listed = await rpc('resources/list')
    const uris = (listed.result!.resources as { uri: string }[]).map((r) => r.uri)
    expect(uris).toContain('ui://billr/invoice-v1.html')

    const read = await rpc('resources/read', { uri: 'ui://billr/ready-to-bill-v1.html' })
    const [content] = read.result!.contents as { mimeType: string; text: string; _meta: Record<string, unknown> }[]
    expect(content.mimeType).toBe('text/html;profile=mcp-app')
    expect(content.text).toContain('data-view="ready"')
    expect(content._meta).toMatchObject({ ui: { csp: { connectDomains: [] } } })
  })
})
