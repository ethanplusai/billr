# Billr for Cursor and Grok Bot

This is the shared Cursor marketplace package for hosted Billr. It bundles a
Cursor manifest, remote MCP configuration, logo, generated skill and optional
Cursor rules. It connects to `https://mcp.billr.cc` using your Billr account.
No API key is included and no subscription is included with installation.

## Cursor local validation

Copy this directory into `~/.cursor/plugins/local/billr`, keeping
`.cursor-plugin/plugin.json`, `mcp.json`, `skills`, `rules` and `assets` together.
Do not replace an existing Billr installation without reviewing it first.
Reload Cursor and inspect Customize. Local imports may require team-admin
permission. A marketplace install with the same name takes precedence.
Authenticate Billr and choose the intended business and permissions.

For MCP-only setup, merge the `billr` entry from `mcp.json` into your existing
`.cursor/mcp.json`; do not replace unrelated server entries. The API-key
example is optional and uses an environment variable.

## Grok Bot

Grok Bot uses the Cursor plugin catalog. Once this package is approved and
published, open **Connect apps**, search **Billr**, add it, and authenticate.
An unpublished package will not appear in public search.

For a pre-publication connection test, ask Grok Bot to add the custom remote
MCP server `https://mcp.billr.cc`, then complete Billr OAuth. This tests the
remote connection; it does not prove marketplace package installation or
skill loading. Use the same read/draft/permission checks in `../README.md`.

## Publishing

The repository root contains `.cursor-plugin/marketplace.json`, selecting
this directory. Submit the public repository URL at
https://cursor.com/marketplace/publish after clean-profile tests pass.
Do not submit a private repository or claim approval before review completes.

Sources: https://cursor.com/docs/plugins,
https://cursor.com/docs/reference/plugins,
https://cursor.com/help/grok-bot/connect-plugins.
