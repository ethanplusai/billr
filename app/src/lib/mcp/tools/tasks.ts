import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { McpCtx } from '@/lib/mcp/context'
import { appUrl, errorResult, jsonResult } from '@/lib/mcp/shared'

const common = {
  business_id: z.uuid().optional(),
  request_id: z
    .uuid()
    .describe(
      'Stable ID for this operation. Reuse on retries with identical input.'
    ),
}
const task = { ...common, task_id: z.uuid() }
export function registerTaskTools(server: McpServer, ctx: McpCtx) {
  server.registerTool(
    'list_billing_policies',
    {
      title: 'List Approved Pricing',
      description:
        'Read human-approved task rates, usage multipliers, currencies and budgets. Agents cannot approve pricing.',
      inputSchema: z.object({ business_id: z.uuid().optional() }),
    },
    async ({ business_id }) => {
      try {
        const id = ctx.db.resolveBusinessId(business_id)
        const { data, error } = await ctx.db.svc
          .from('billing_policies')
          .select('*')
          .eq('business_id', id)
          .order('created_at', { ascending: false })
          .limit(100)
        if (error) throw error
        return jsonResult({
          policies: data,
          limit: 100,
          review_url: `${appUrl()}/tasks`,
        })
      } catch (e) {
        return errorResult(
          e instanceof Error ? e.message : 'Could not load pricing'
        )
      }
    }
  )
  const definitions = [
    {
      name: 'create_task',
      action: 'create',
      description:
        'Create a paused task using a human-approved pricing policy. A task has its own budget. Then start_task when active work begins.',
      schema: z.object({
        ...common,
        policy_id: z.uuid(),
        title: z.string().trim().min(1).max(500),
      }),
    },
    {
      name: 'start_task',
      action: 'start',
      description:
        'Start or resume active work. Send heartbeat_task every 30 to 60 seconds. Only the first 120 seconds after a heartbeat count; waiting for a user should be paused.',
      schema: z.object(task),
    },
    {
      name: 'heartbeat_task',
      action: 'heartbeat',
      description:
        'Record active elapsed time using server timestamps, capped at 120 seconds since the previous heartbeat. Retry with the same request ID to avoid counting twice.',
      schema: z.object(task),
    },
    {
      name: 'pause_task',
      action: 'pause',
      description:
        'Stop charging time while waiting or idle. Records up to 120 seconds since the last heartbeat.',
      schema: z.object(task),
    },
    {
      name: 'complete_task',
      action: 'complete',
      description:
        'Finish a task after logging all usage. Stops time and freezes work for human billing review. This cannot be undone.',
      schema: z.object(task),
    },
    {
      name: 'record_task_usage',
      action: 'usage',
      description:
        'Record a known provider cost in the policy currency, with a unique provider request reference and evidence source. This is reported cost, not independently verified by Billr. Do not invent prices or submit estimates. Log before completing the task.',
      schema: z.object({
        ...task,
        provider: z.string().min(1).max(200),
        model: z.string().max(200).optional(),
        provider_request_id: z.string().min(1).max(200),
        cost: z.number().finite().min(0).max(99999999),
        currency: z.string().regex(/^[A-Z]{3}$/),
        input_tokens: z.number().int().nonnegative().optional(),
        output_tokens: z.number().int().nonnegative().optional(),
        source: z.string().min(1).max(1000),
      }),
    },
  ] as const
  for (const def of definitions) {
    server.registerTool(
      def.name,
      {
        title: def.name.replaceAll('_', ' '),
        description: def.description,
        inputSchema: def.schema,
      },
      async (input: z.infer<typeof def.schema>) => {
        try {
          const { business_id, request_id, ...payload } = input
          const business = ctx.db.resolveBusinessId(business_id)
          const { data, error } = await ctx.db.svc.rpc('task_operation', {
            p_business_id: business,
            p_request_id: request_id,
            p_action: def.action,
            p_input: payload,
            p_key_id: ctx.keyId,
          })
          if (error) return errorResult(error.message)
          return jsonResult({ result: data, review_url: `${appUrl()}/tasks` })
        } catch (e) {
          return errorResult(
            e instanceof Error ? e.message : 'Could not record task operation'
          )
        }
      }
    )
  }
  server.registerTool(
    'get_task_billing_preview',
    {
      title: 'Task Billing Preview',
      description:
        'Read recorded active seconds and reported usage. Time excludes unrecorded running intervals. Completion and human approval are required before invoicing. Amounts are rounded per component.',
      inputSchema: z.object({
        business_id: z.uuid().optional(),
        task_id: z.uuid(),
      }),
    },
    async ({ business_id, task_id }) => {
      try {
        const business = ctx.db.resolveBusinessId(business_id)
        const { data: t, error } = await ctx.db.svc
          .from('work_tasks')
          .select('*, pricing:billing_policies(*)')
          .eq('business_id', business)
          .eq('id', task_id)
          .single()
        if (error || !t) return errorResult('Task not found')
        const p = t.pricing
        const time =
          Math.round(((t.active_seconds * p.hourly_rate) / 3600) * 100) / 100
        const usage = Math.round(t.usage_cost * p.usage_multiplier * 100) / 100
        return jsonResult({
          task: t,
          time_amount: time,
          usage_amount: usage,
          total: Math.round((time + usage) * 100) / 100,
          currency: p.currency,
          requires_human_review: t.status !== 'invoiced',
          review_url: `${appUrl()}/tasks`,
        })
      } catch (e) {
        return errorResult(
          e instanceof Error ? e.message : 'Could not load task'
        )
      }
    }
  )
}
