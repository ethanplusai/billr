# Billr for OpenClaw

The skill connects your agent to hosted Billr. A Billr account is required;
installation does not include a subscription. Configure the MCP server:

```sh
openclaw mcp set billr '{"url":"https://mcp.billr.cc","transport":"streamable-http","auth":"oauth"}'
openclaw mcp login billr
openclaw mcp tools billr
```

Copy `billr/` into your OpenClaw skills directory. Approve only the business
and permissions needed for the task. Use OAuth, not bearer keys in commands
or chat. Ask for unbilled work first; verify no writes occur.

For your own installation, explicitly substitute its HTTPS `/api/mcp` URL.
Cloud clients cannot reach a localhost server on your computer.

## ClawHub publication

The skill is distributed here under Apache-2.0. ClawHub currently requires
MIT-0 for published skills. The owner must approve any necessary licensing
change before submission. Do not automatically relabel this archive. A local
skill installation is separate from being listed on ClawHub.

Sources: https://docs.openclaw.ai/clawhub/skill-format,
https://docs.openclaw.ai/cli/mcp/transports.
