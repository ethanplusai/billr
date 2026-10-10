# Billr agent toolkit

Agent toolkit for Billr. Contains a TypeScript MCP client, the tool catalog, the exported JSON tool schemas and the same time and currency calculations the Billr application uses. It contains no credentials, customer records, database administration tools or deployment configuration.

The package lives in the Billr repository and stays private to prevent accidental npm publication. Supply the MCP URL of your own installation; there is no default connection.

## Connect an agent

```ts
import { connectBillr } from '@billr/agent-kit'

const billr = await connectBillr({
  apiKey: process.env.BILLR_API_KEY!,
  url: process.env.BILLR_MCP_URL!,
})
try {
  const tools = await billr.listTools()
  const pricing = await billr.callTool({
    name: 'list_billing_policies',
    arguments: {},
  })
  // Inspect pricing. Choose the client's human-approved policy.
  const task = await billr.callTool({
    name: 'create_task',
    arguments: {
      request_id: crypto.randomUUID(),
      policy_id: 'HUMAN_APPROVED_POLICY_UUID',
      title: 'Implement the approved change',
    },
  })
} finally {
  await billr.close()
}
```

Use a separate key for each agent, scoped to one business. Default keys can read and draft but cannot send documents, delete entries or record payments. Keys expire in 90 days. Discover the actual permitted surface with `listTools()`; the catalog includes tools that a restricted key may not have.

## Task contract

1. A human approves hourly rate, currency, usage multiplier and budget per task in Billr.
2. Create a task, then start it when work begins.
3. Heartbeat every 30 to 60 seconds. Each interval counts at most 120 seconds. Pause when idle or waiting.
4. Record known provider costs, with a provider request reference and evidence source. These are reported costs, not verified provider invoices. Do not invent prices or convert currencies implicitly.
5. Complete the task, preview its costs, and ask the human to review it in Billr. Human approval creates a draft invoice; sending is separate.

Each mutation in this task workflow requires a new UUID request ID. Reuse the original ID and identical arguments on retries. Persist these IDs with your agent's task state. Manual time/expense and document creation, document sending, and payment recording also use stable request IDs.

Time is rounded to whole seconds. Billable time is `round(seconds × hourly_rate / 3600, 2)`. Usage is `round(sum(provider_cost) × multiplier, 2)`. Separate tasks can overlap; the caller is responsible for avoiding duplicate billing for the same work. This is not an independent measurement of agent productivity.

Task billing is described in the repository README. Try it against a local Billr with `url: 'http://localhost:3000/api/mcp'`.

## Tool schemas and pagination

`TOOL_CONTRACTS` exports the full server's tool definitions and JSON input schemas. These describe the full surface; runtime permissions still determine which tools a key can call. The schemas are written by `app/scripts/local-mcp-acceptance.mjs` in this repository: run with `BILLR_EXPORT_CONTRACTS=1` against a local Billr, it lists the tools the live MCP server registers and saves them to `src/tool-contracts.json`, so they match what the server actually exposes.

Collection tools accept `offset` and return `next_offset` when another page may exist. Continue until it is null. Unbilled-work totals are page totals; sum pages separately by currency.

## Development

```sh
npm ci
npm run build
```

Do not put API keys in source files, prompts, browser bundles or Git history. Configure `BILLR_API_KEY` in your runtime's secret store.
