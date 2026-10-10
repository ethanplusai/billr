import type { McpServer } from '@modelcontextprotocol/server'
import type { McpCtx } from './context'
import { canUseTool } from './permissions'
import { errorResult } from './shared'
import { authErrorResult, withStructuredContent, withToolMeta } from './openai-apps'

/** The registered surface and execution gate use the same explicit allowlist. */
export function guardedServer(server: McpServer, ctx: McpCtx): McpServer {
  return new Proxy(server, {
    get(target, property) {
      if (property !== 'registerTool') {
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return (
        name: string,
        config: unknown,
        callback: (...args: unknown[]) => Promise<{ isError?: boolean }>
      ) => {
        if (!canUseTool(name, ctx.permissions ?? [])) return
        const wrapped = async (...args: unknown[]) => {
          // Re-check revocation and expiry at execution, including after a slow handshake.
          const { data: key, error: keyError } = await ctx.db.svc
            .from('api_keys')
            .select('revoked_at,expires_at,permissions')
            .eq('id', ctx.keyId)
            .single()
          // The ChatGPT and Codex hosts read the www_authenticate challenge on
          // these and offer to sign in again, rather than leaving a dead end.
          if (
            keyError ||
            !key ||
            key.revoked_at ||
            (key.expires_at && Date.parse(key.expires_at) <= Date.now())
          )
            return authErrorResult(
              'Your Billr connection has expired or been revoked. Sign in to Billr again.',
              'invalid_token'
            )
          if (!canUseTool(name, key.permissions))
            return authErrorResult(
              'This Billr connection does not have permission for this tool. Reconnect Billr and grant it.',
              'insufficient_scope'
            )
          const { data: call, error } = await ctx.db.svc
            .from('agent_tool_calls')
            .insert({ key_id: ctx.keyId, user_id: ctx.userId, tool_name: name })
            .select('id')
            .single()
          if (error || !call)
            return errorResult(
              'Could not record the audit entry. No tool operation was started.'
            )
          let result: { isError?: boolean }
          try {
            result = withStructuredContent(name, await callback(...args))
          } catch {
            result = errorResult(
              'Tool operation failed. Check the app before retrying; reuse the original request ID where supported.'
            )
          }
          const { error: finishError } = await ctx.db.svc
            .from('agent_tool_calls')
            .update({
              status: result.isError ? 'failed' : 'succeeded',
              finished_at: new Date().toISOString(),
            })
            .eq('id', call.id)
          // A started audit row is intentionally retained after a crash or unavailable database.
          if (finishError)
            console.error('Could not finish agent audit entry', call.id)
          return result
        }
        return Reflect.apply(target.registerTool, target, [
          name,
          // Auth scopes for every tool, and the card for the few that have one.
          withToolMeta(name, config),
          wrapped,
        ])
      }
    },
  })
}
