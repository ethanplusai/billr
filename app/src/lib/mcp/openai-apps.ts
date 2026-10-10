import { protectedResourceMetadataUrl } from '@/lib/oauth/metadata'
import { toolPermission } from './permissions'

/**
 * What the ChatGPT and Codex plugin hosts read from Billr's MCP server, kept in
 * one place so the tool files stay free of host-specific metadata.
 *
 * Sources, read 2026-10-01:
 *   https://developers.openai.com/plugins/build/auth.md       securitySchemes,
 *     _meta["mcp/www_authenticate"], get_profile
 *   https://developers.openai.com/plugins/build/chatgpt-ui.md  ui:// resources,
 *     _meta.ui.resourceUri and its "openai/outputTemplate" alias,
 *     structuredContent
 *
 * All of it is additive. A client that ignores `_meta` (Claude, Cursor, the
 * Codex CLI) sees exactly the tools it saw before.
 */

/** Tools that render a Billr card, and the ui:// resource each one uses. */
export const WIDGET_TOOLS = {
  get_invoice: 'ui://billr/invoice-v1.html',
  get_estimate: 'ui://billr/estimate-v1.html',
  revenue_summary: 'ui://billr/revenue-v1.html',
  list_ready_to_bill: 'ui://billr/ready-to-bill-v1.html',
} as const satisfies Record<string, string>

export type WidgetTool = keyof typeof WIDGET_TOOLS

const STATUS_TEXT: Record<WidgetTool, { invoking: string; invoked: string }> = {
  get_invoice: { invoking: 'Opening invoice', invoked: 'Invoice ready' },
  get_estimate: { invoking: 'Opening estimate', invoked: 'Estimate ready' },
  revenue_summary: { invoking: 'Adding up revenue', invoked: 'Revenue summary ready' },
  list_ready_to_bill: { invoking: 'Finding work to bill', invoked: 'Ready-to-bill list ready' },
}

function isWidgetTool(name: string): name is WidgetTool {
  return Object.prototype.hasOwnProperty.call(WIDGET_TOOLS, name)
}

/**
 * OAuth scopes a tool needs. Billr's scopes are its permission names (read,
 * write, send, delete, payments), so the mapping is the permission table.
 */
export function securitySchemesFor(name: string) {
  const permission = toolPermission(name)
  return permission ? [{ type: 'oauth2', scopes: [permission] }] : []
}

/** `_meta` added to a tool's descriptor in tools/list. */
export function toolMetaFor(name: string): Record<string, unknown> {
  const meta: Record<string, unknown> = { securitySchemes: securitySchemesFor(name) }
  if (isWidgetTool(name)) {
    const uri = WIDGET_TOOLS[name]
    meta.ui = { resourceUri: uri }
    meta['openai/outputTemplate'] = uri
    meta['openai/toolInvocation/invoking'] = STATUS_TEXT[name].invoking
    meta['openai/toolInvocation/invoked'] = STATUS_TEXT[name].invoked
  }
  return meta
}

/** Merges host metadata into a registerTool config without dropping its own. */
export function withToolMeta<T>(name: string, config: T): T {
  if (!config || typeof config !== 'object') return config
  const existing = (config as { _meta?: Record<string, unknown> })._meta ?? {}
  return { ...config, _meta: { ...toolMetaFor(name), ...existing } }
}

interface ToolResultLike {
  content?: Array<{ type: string; text?: string }>
  structuredContent?: unknown
  isError?: boolean
}

/**
 * Billr's tools return their data as one JSON text block (jsonResult). A UI
 * host renders `structuredContent`, so for the tools that have a card the same
 * object is mirrored there. The text block stays, for every client without UI.
 */
export function withStructuredContent<T>(name: string, result: T): T {
  if (!isWidgetTool(name)) return result
  const r = result as ToolResultLike
  if (!r || r.isError || r.structuredContent !== undefined) return result
  const text = r.content?.find((c) => c.type === 'text')?.text
  if (!text) return result
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...result, structuredContent: parsed }
    }
  } catch {
    // Not JSON: leave the result alone.
  }
  return result
}

/**
 * A tool error that makes ChatGPT show its "Sign in to Billr" button instead of
 * a dead end. The challenge must carry both `error` and `error_description`.
 */
export function authErrorResult(text: string, error: 'invalid_token' | 'insufficient_scope') {
  const resourceMetadata = protectedResourceMetadataUrl()
  const description = text.replace(/["\\]/g, '')
  return {
    content: [{ type: 'text' as const, text }],
    isError: true as const,
    _meta: {
      'mcp/www_authenticate': [
        `Bearer resource_metadata="${resourceMetadata}", error="${error}", error_description="${description}"`,
      ],
    },
  }
}
