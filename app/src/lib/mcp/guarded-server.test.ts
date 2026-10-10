import { describe, expect, it, vi } from 'vitest'

/**
 * The MCP tool wrapper: once the key checks out and the audit row is written,
 * read and write tools both run.
 */

vi.mock('@/lib/deployment', () => ({
  appOrigin: () => 'https://invoices.example.org',
  mcpUrl: () => 'https://invoices.example.org/api/mcp',
}))

import { guardedServer } from './guarded-server'
import type { McpCtx } from './context'

const KEY = { revoked_at: null, expires_at: null, permissions: ['read', 'write'] }

/** The two tables the wrapper touches, in the order it touches them. */
function fakeDb({ auditFails = false } = {}) {
  return {
    svc: {
      from(table: string) {
        if (table === 'api_keys') {
          return {
            select: () => ({
              eq: () => ({ single: async () => ({ data: KEY, error: null }) }),
            }),
          }
        }
        // agent_tool_calls
        return {
          insert: () => ({
            select: () => ({
              single: async () =>
                auditFails
                  ? { data: null, error: { message: 'insert failed' } }
                  : { data: { id: 'call-1' }, error: null },
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        }
      },
    },
  }
}

function setup({ auditFails = false, onCall = () => {} } = {}) {
  const registered = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const server = {
    registerTool(
      name: string,
      _config: unknown,
      callback: (...args: unknown[]) => Promise<unknown>,
    ) {
      registered.set(name, callback)
    },
  }
  const ctx = {
    userId: 'user-1',
    keyId: 'key-1',
    businessIds: ['b1'],
    permissions: ['read', 'write'],
    db: fakeDb({ auditFails }),
  } as unknown as McpCtx

  const guarded = guardedServer(server as never, ctx)
  guarded.registerTool(
    'list_invoices',
    {},
    async () => {
      onCall()
      return { content: [{ type: 'text', text: 'read ok' }] }
    },
  )
  guarded.registerTool(
    'create_invoice',
    {},
    async () => ({ content: [{ type: 'text', text: 'write ok' }] }),
  )
  return registered
}

describe('guardedServer', () => {
  it('runs read tools', async () => {
    const result = (await setup().get('list_invoices')!({})) as {
      isError?: boolean
      content: { text: string }[]
    }

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe('read ok')
  })

  it('runs write tools', async () => {
    const result = (await setup().get('create_invoice')!({ business_id: 'b1' })) as {
      content: { text: string }[]
    }

    expect(result.content[0].text).toBe('write ok')
  })

  it('refuses to run a tool when the audit entry cannot be written', async () => {
    const onCall = vi.fn()
    const result = (await setup({ auditFails: true, onCall }).get('list_invoices')!({})) as {
      isError?: boolean
      content: { text: string }[]
    }

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Could not record the audit entry')
    expect(onCall).not.toHaveBeenCalled()
  })
})
