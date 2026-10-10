# Billr for Cursor

Cursor has no plugin package format for this, so the deliverable is two files
you copy: an MCP server entry and a set of project rules.

Sources: https://cursor.com/docs/context/mcp and
https://cursor.com/docs/context/rules.

## What is in the package

```
plugins/cursor/
  mcp.json                       the OAuth entry, copy to .cursor/mcp.json
  mcp.api-key.json               the API-key variant, same destination
  rules/billr.mdc                generated from plugins/shared/skill
  rules/billr-workflows.mdc      generated
  rules/billr-tools.mdc          generated
```

The rules are generated. Edit `plugins/shared/skill/` and run
`node app/scripts/generate-plugin-tool-reference.mjs`.

## 1. Add the MCP server

Copy `mcp.json` to `.cursor/mcp.json` in a project, or to `~/.cursor/mcp.json`
for every project:

```json
{
  "mcpServers": {
    "billr": {
      "url": "https://<your-domain>/api/mcp"
    }
  }
}
```

A `url` is all Cursor needs. Cursor supports OAuth for servers that require
it, so saving the file makes Billr appear in the MCP list on the Customize
page and opens Billr in your browser. Choose the business and the permissions,
then approve.

**API key instead.** Create a key under Agents then API Keys, set
`BILLR_API_KEY` in the environment Cursor starts from, and use
`mcp.api-key.json`. Cursor reads `${env:NAME}` in header values, so the key
never sits in the file:

```json
{
  "mcpServers": {
    "billr": {
      "url": "https://<your-domain>/api/mcp",
      "headers": {
        "Authorization": "Bearer ${env:BILLR_API_KEY}"
      }
    }
  }
}
```

The committed file points at a local install. For a deployed Billr, use `"url": "https://<your-domain>/api/mcp"`.

## 2. Add the rules

Copy `rules/*.mdc` into `.cursor/rules/` in the project. They are version
controlled, so a team gets them from the repository.

The `.mdc` extension is required; plain `.md` files are ignored unless they
have no frontmatter. All three rules ship with `alwaysApply: false` and a
`description`, which is the "apply intelligently" type: Cursor reads the
description and pulls the rule in when the work looks like billing. You can
also pull one in by hand by @-mentioning it.

- `billr.mdc` is the skill: safe defaults, auth and scopes, the workflows in
  brief, task billing, engagements, payment rules, error handling.
- `billr-workflows.mdc` is the step by step procedures.
- `billr-tools.mdc` is the full tool list with the permission each one needs.

If you want Billr's rule in context for every request in a billing-only
repository, change `alwaysApply: false` to `alwaysApply: true` in
`billr.mdc`. Do not do that in a general code repository; it spends context on
every unrelated turn.

## Verify

Ask Cursor: "List my Billr clients and tell me what is still unbilled." It
reads only, so nothing is created or sent.
