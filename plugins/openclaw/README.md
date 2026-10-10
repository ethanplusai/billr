# Billr for OpenClaw

OpenClaw has a documented, installable skill format, so this is a real package
rather than a page of instructions. It teaches the agent Billr's workflows; the
MCP server is added separately with one command.

Sources: https://docs.openclaw.ai/clawhub/skill-format and
https://docs.openclaw.ai/cli/mcp/transports.

## What is in the package

```
plugins/openclaw/
  billr/
    SKILL.md                 generated from plugins/shared/skill
    references/tools.md      generated from the registered tool contracts
    references/workflows.md  generated
```

A skill is a folder containing `SKILL.md` plus optional supporting files,
which is exactly this. The frontmatter carries `name`, `description` and
`version`, the three core fields the format documents. There is no
`metadata.openclaw.requires` block on purpose: the skill needs no binaries,
and it must not declare a required environment variable, because the
recommended way in is OAuth with no key at all.

Everything here is generated. Edit `plugins/shared/skill/` and run
`node app/scripts/generate-plugin-tool-reference.mjs`.

## 1. Add the MCP server

```bash
openclaw mcp set billr '{"url":"https://<your-domain>/api/mcp","transport":"streamable-http","auth":"oauth"}'
openclaw mcp login billr
openclaw mcp tools billr
```

`auth: "oauth"` uses the credentials saved by `openclaw mcp login`. Billr is
its own authorization server, so the sign-in opens Billr's consent screen,
where you pick the business and the permissions.

**API key instead.** Create a key under Agents then API Keys and pass it in
the `headers` map. Values in `url` userinfo and in `headers` are redacted in
OpenClaw's logs and status output, but the key is still written to the saved
server configuration, so use a narrowly scoped key and rotate it:

```bash
openclaw mcp set billr '{"url":"https://<your-domain>/api/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer YOUR_KEY"}}'
```

For a local install, use `"url":"http://localhost:3000/api/mcp"`.

`openclaw mcp probe billr` and `openclaw mcp doctor` are the documented checks
if the connection does not come up. The Control UI shows the same list at
`/settings/mcp`.

## 2. Install the skill

Copy `billr/` into your OpenClaw skills directory. The folder name is the
skill.

## Verify

Ask OpenClaw: "List my Billr clients and tell me what is still unbilled." It
reads only, so nothing is created or sent.
