# Billr plugins

These plugins connect to **hosted Billr**, at `https://mcp.billr.cc`. Sign in
with your own Billr account and choose the business and permissions. Installing
a plugin does not create an account or include a subscription.

| Platform | Package / connection |
| --- | --- |
| Claude Code | `claude-code/billr`, listed by the root Claude marketplace |
| Codex and ChatGPT | `codex/billr`, with portable and Codex manifests |
| Cursor and Grok Bot | `cursor`, listed by the root Cursor marketplace |
| OpenClaw | `openclaw/billr` skill; configure remote MCP separately |
| Claude web/Desktop | Custom connector using the hosted URL |
| Grok web / xAI API | Remote MCP connection; distinct from Grok Bot |

See the platform README for installation. A package in this repository does
not mean it has been approved or published in a platform directory.

## Authentication and permissions

Use OAuth whenever supported. Supply the hosted URL without a client secret
or embedded credential. On Billr's consent screen choose a single test business
and Read only for the first check. Grant draft/write access only when needed.
Sending, recording payments and deletion require additional permissions and an
explicit user request. The bundled skill follows a draft-first workflow.

API-key clients may use a narrowly scoped key from Billr's Agents page. Use
the client's environment-variable support; never commit a key or paste it into
chat. Each platform receives data returned by tools you authorize.

## Self-hosted installations

The application in this repository still runs independently. To connect to
your own installation, configure `https://<your-domain>/api/mcp` directly in
your agent, or edit a private copy of a plugin's MCP URL before installing it.
For local desktop clients that URL may be `http://localhost:3000/api/mcp`.
Cloud clients need an HTTPS endpoint reachable from their servers. Do not
change the distributed hosted package for an individual installation.

## Verify each host

1. Install from a clean profile and check the skill and MCP connection appear.
2. Sign in with OAuth; approve Read only on a fictional test business.
3. Ask to list its clients and unbilled work. Confirm correct business/currency.
4. Ask for a draft with read-only access: it must refuse without creating data.
5. Reconnect with write access and explicitly request one fictional draft.
6. Verify the draft in Billr; no email or payment should occur.
7. Revoke only the connection created for this test, then verify access fails.
8. Reconnect and repeat the read. In UI-capable hosts, also check card rendering.

Run automated package checks with:

```sh
node app/scripts/generate-plugin-tool-reference.mjs --check
node --test app/scripts/plugin-packages.test.mjs
```

The shared skill and tool reference are generated into each platform layout.
Edit `shared/skill/`, then run `node app/scripts/generate-plugin-tool-reference.mjs`.
