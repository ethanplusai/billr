import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/deployment', () => ({
  appOrigin: () => 'https://invoices.example.org',
  mcpUrl: () => 'https://invoices.example.org/api/mcp',
}))

import {
  WIDGET_TOOLS,
  authErrorResult,
  securitySchemesFor,
  toolMetaFor,
  withStructuredContent,
  withToolMeta,
} from './openai-apps'
import { guardedServer } from './guarded-server'
import { registerBillrWidgets, widgetHtml, WIDGET_MIME_TYPE } from './widgets'
import type { McpCtx } from './context'

describe('tool metadata for the ChatGPT and Codex hosts', () => {
  it('declares the OAuth scope each tool needs, which is its permission', () => {
    expect(securitySchemesFor('get_invoice')).toEqual([{ type: 'oauth2', scopes: ['read'] }])
    expect(securitySchemesFor('send_invoice')).toEqual([{ type: 'oauth2', scopes: ['send'] }])
    expect(securitySchemesFor('record_payment')).toEqual([{ type: 'oauth2', scopes: ['payments'] }])
    expect(securitySchemesFor('not_a_tool')).toEqual([])
  })

  it('points card tools at their ui:// resource under both names', () => {
    const meta = toolMetaFor('get_invoice') as Record<string, unknown>
    expect(meta.ui).toEqual({ resourceUri: 'ui://billr/invoice-v1.html' })
    expect(meta['openai/outputTemplate']).toBe('ui://billr/invoice-v1.html')
  })

  it('gives other tools no card', () => {
    const meta = toolMetaFor('create_invoice') as Record<string, unknown>
    expect(meta.ui).toBeUndefined()
    expect(meta['openai/outputTemplate']).toBeUndefined()
  })

  it("keeps a tool's own _meta when merging", () => {
    const config = withToolMeta('get_profile', { title: 'x', _meta: { 'openai/profile': true } })
    expect(config._meta).toMatchObject({
      'openai/profile': true,
      securitySchemes: [{ type: 'oauth2', scopes: ['read'] }],
    })
    expect(config.title).toBe('x')
  })
})

describe('withStructuredContent', () => {
  const ok = { content: [{ type: 'text', text: JSON.stringify({ summary: 's', invoice: { id: 'i' } }) }] }

  it('mirrors the JSON text into structuredContent for card tools', () => {
    expect(withStructuredContent('get_invoice', ok)).toEqual({
      ...ok,
      structuredContent: { summary: 's', invoice: { id: 'i' } },
    })
  })

  it('leaves other tools, errors and non-JSON alone', () => {
    expect(withStructuredContent('list_invoices', ok)).toBe(ok)
    const error = { ...ok, isError: true }
    expect(withStructuredContent('get_invoice', error)).toBe(error)
    const text = { content: [{ type: 'text', text: 'not json' }] }
    expect(withStructuredContent('get_invoice', text)).toBe(text)
  })
})

describe('authErrorResult', () => {
  it('carries a challenge with error and error_description, which ChatGPT needs to offer sign-in', () => {
    const result = authErrorResult('Sign in to "Billr" again.', 'invalid_token')
    expect(result.isError).toBe(true)
    const [challenge] = result._meta['mcp/www_authenticate']
    expect(challenge).toContain('resource_metadata="https://invoices.example.org/.well-known/oauth-protected-resource/api/mcp"')
    expect(challenge).toContain('error="invalid_token"')
    expect(challenge).toContain('error_description="Sign in to Billr again."')
  })
})

describe('guardedServer', () => {
  function setup(key: Record<string, unknown>) {
    const registered = new Map<string, { config: { _meta?: Record<string, unknown> }; cb: (...a: unknown[]) => Promise<unknown> }>()
    const server = {
      registerTool(name: string, config: { _meta?: Record<string, unknown> }, cb: (...a: unknown[]) => Promise<unknown>) {
        registered.set(name, { config, cb })
      },
    }
    const ctx = {
      keyId: 'k1',
      userId: 'u1',
      businessIds: ['b1'],
      permissions: ['read', 'write'],
      db: {
        svc: {
          from(table: string) {
            if (table === 'api_keys') {
              return { select: () => ({ eq: () => ({ single: async () => ({ data: key, error: null }) }) }) }
            }
            return {
              insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'c1' }, error: null }) }) }),
              update: () => ({ eq: async () => ({ error: null }) }),
            }
          },
        },
      },
    } as unknown as McpCtx
    const guarded = guardedServer(server as never, ctx)
    return { guarded, registered }
  }

  const invoiceJson = { content: [{ type: 'text' as const, text: '{"summary":"s","invoice":{"id":"i"}}' }] }

  it('adds host metadata to every registered tool', () => {
    const { guarded, registered } = setup({ revoked_at: null, expires_at: null, permissions: ['read'] })
    guarded.registerTool('get_invoice', { title: 'Get Invoice' }, async () => invoiceJson)
    expect(registered.get('get_invoice')!.config._meta).toMatchObject({
      'openai/outputTemplate': WIDGET_TOOLS.get_invoice,
      securitySchemes: [{ type: 'oauth2', scopes: ['read'] }],
    })
  })

  it('returns structuredContent from card tools', async () => {
    const { guarded, registered } = setup({ revoked_at: null, expires_at: null, permissions: ['read'] })
    guarded.registerTool('get_invoice', {}, async () => invoiceJson)
    const result = (await registered.get('get_invoice')!.cb({})) as Record<string, unknown>
    expect(result.structuredContent).toEqual({ summary: 's', invoice: { id: 'i' } })
  })

  it('answers a revoked connection with a sign-in challenge', async () => {
    const { guarded, registered } = setup({ revoked_at: '2026-01-01', expires_at: null, permissions: ['read'] })
    guarded.registerTool('get_invoice', {}, async () => invoiceJson)
    const result = (await registered.get('get_invoice')!.cb({})) as { _meta?: Record<string, string[]> }
    expect(result._meta?.['mcp/www_authenticate']?.[0]).toContain('error="invalid_token"')
  })

  it('answers a permission removed since connecting with insufficient_scope', async () => {
    const { guarded, registered } = setup({ revoked_at: null, expires_at: null, permissions: ['write'] })
    guarded.registerTool('get_invoice', {}, async () => invoiceJson)
    const result = (await registered.get('get_invoice')!.cb({})) as { _meta?: Record<string, string[]> }
    expect(result._meta?.['mcp/www_authenticate']?.[0]).toContain('error="insufficient_scope"')
  })
})

describe('Billr cards', () => {
  it('registers one MCP Apps resource per card tool', async () => {
    const resources: { uri: string; read: () => Promise<{ contents: { mimeType: string; text: string }[] }> }[] = []
    registerBillrWidgets({
      registerResource(_n: string, uri: string, _c: unknown, read: () => Promise<never>) {
        resources.push({ uri, read })
      },
    } as never)
    expect(resources.map((r) => r.uri).sort()).toEqual(Object.values(WIDGET_TOOLS).sort())
    const { contents } = await resources[0].read()
    expect(contents[0].mimeType).toBe(WIDGET_MIME_TYPE)
  })

  it('loads nothing from the network', () => {
    for (const tool of Object.keys(WIDGET_TOOLS) as (keyof typeof WIDGET_TOOLS)[]) {
      const html = widgetHtml(tool)
      expect(html).not.toMatch(/<script[^>]+src=/i)
      expect(html).not.toMatch(/<link[^>]+href=/i)
      expect(html).not.toMatch(/fetch\(|XMLHttpRequest/)
    }
  })
})
