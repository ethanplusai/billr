# Billr and Grok (xAI)

**There is nothing to package here.** This directory is documentation, not a
plugin.

xAI's documentation describes two ways for Grok to reach an MCP server. Both
take a URL and neither has an installable package format. (OpenClaw, a
different agent, does have one; its skill package lives in `plugins/openclaw/`.)

Sources:

- https://docs.x.ai/grok/connectors
- https://docs.x.ai/developers/tools/remote-mcp
- https://docs.x.ai/ (documentation index)

The index lists the Code, Responses, Voice and Imagine APIs, function calling,
web search, structured outputs, the batch API, the REST reference, community
integrations and release notes. There is no skill format and no plugin
directory for Grok. Nothing here is inferred from anywhere else.

## 1. Grok consumer and business: a custom MCP connector

Quoting the connectors page:

1. Go to grok.com/connectors.
2. Click **New Connector**, then select **Custom**.
3. "Enter the MCP server URL and complete any required authentication."

The URL is `https://<your-domain>/api/mcp`, or `http://localhost:3000/api/mcp`
on a local install.

Two caveats, both from the vendor page:

- The page does not say which authentication methods a custom connector
  accepts. Billr supports OAuth 2.1 discovery from the URL alone, and also
  accepts a `billr_sk_` key as an `Authorization: Bearer` header. If the
  connector offers a browser sign-in, use it; if it offers a header field,
  use a narrowly scoped key.
- The server must be reachable over the public internet. A local install needs
  a tunnel; `http://localhost:3000/api/mcp` will not work.

On Grok Business and Enterprise a team admin provisions the connector in the
cloud console before members can use it.

Grok has no skill or rules format, so the instructions in
`plugins/shared/skill/SKILL.md` cannot be installed. Paste what you need into
a custom instruction or a project, or rely on the tool descriptions, which the
MCP server carries itself.

## 2. xAI API: a remote MCP tool

For developers calling the xAI API, Billr is a remote MCP tool in the `tools`
array. The developer supplies the key per request; there is nothing to install
and nothing to list anywhere.

Fields, quoted from the remote MCP page: `type: "mcp"`, required `server_url`
(HTTPS, "Only Streaming HTTP and SSE transports are supported") and
`server_label`; optional `server_description`, `allowed_tools`,
`authorization` (which sets the Authorization header) and `headers`.
`require_approval` and `connector_id` from the OpenAI Responses API are not
supported. The xAI native SDK names the last two `allowed_tool_names` and
`extra_headers`.

Read-only shape, with the key read from the environment and never written into
source:

```json
{
  "type": "mcp",
  "server_url": "https://<your-domain>/api/mcp",
  "server_label": "billr",
  "server_description": "Invoicing and billing: clients, invoices, estimates, time, expenses, payments, engagements.",
  "allowed_tools": [
    "list_businesses",
    "list_clients",
    "list_invoices",
    "get_invoice",
    "list_unbilled",
    "get_payment_status",
    "revenue_summary"
  ],
  "authorization": "Bearer BILLR_API_KEY_FROM_ENVIRONMENT"
}
```

Notes that matter more than the shape:

- Use `allowed_tools` to hold the surface down to what the call actually
  needs. A read-only list like the one above cannot draft, send or record
  anything even if the key could.
- Back that up with a key that is scoped the same way. Create a Read only key
  for read-only work rather than sending a Billr key with send and payments
  permissions and trusting `allowed_tools` alone.
- Anything you pass in `authorization` goes to xAI's servers along with every
  tool result. Use a dedicated key for this integration so it can be revoked
  on its own, and remember that Billr data in tool results passes through xAI.
- The full tool list, with the permission each tool needs, is in
  `plugins/shared/skill/references/tools.md`.

## Verify

1. grok.com/connectors, New Connector, Custom, paste the Billr MCP URL, and
   complete the authentication step it offers.
2. If it offered a browser sign-in, confirm the Billr consent screen appeared
   and that the connection shows up under Agents then API Keys, revocable.
3. Ask Grok to list Billr clients and report unbilled work. Read-only.
4. For the API path, run one request with the read-only tool list above and
   confirm the tool call returns and that no write tool is reachable.
