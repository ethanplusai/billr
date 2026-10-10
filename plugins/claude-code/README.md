# Billr for Claude Code

A Claude Code plugin that bundles the Billr MCP server with the Billr skill, so
one install gives Claude Code both the tools and the instructions for using
them well.

Sources: https://code.claude.com/docs/en/plugins,
https://code.claude.com/docs/en/plugins-reference and
https://code.claude.com/docs/en/plugin-marketplaces.

## What is in the package

```
plugins/claude-code/
  .claude-plugin/marketplace.json     the marketplace, for the local path form
  billr/
    .claude-plugin/plugin.json        the plugin manifest
    .mcp.json                         billr as an HTTP MCP server, OAuth, no header
    commands/billr-status.md          the read-only summary command
    skills/billr/SKILL.md             generated from plugins/shared/skill
    skills/billr/references/tools.md  generated from the registered tool contracts
    skills/billr/references/workflows.md
```

Everything under `skills/` is generated. Edit `plugins/shared/skill/` and run
`node app/scripts/generate-plugin-tool-reference.mjs`.

## Install

The public repository root carries its own copy of the marketplace file, so
the GitHub form works once the repository is public:

```bash
claude plugin marketplace add ethanplusai/billr
claude plugin install billr@billr
```

From a local checkout, point at this directory instead:

```bash
claude plugin marketplace add ./plugins/claude-code
claude plugin install billr@billr
```

To try it without installing anything:

```bash
claude --plugin-dir ./plugins/claude-code/billr
```

Then connect: run `/mcp` in Claude Code, pick `billr`, and authenticate.
Claude Code opens Billr in a browser, where you pick the business and the
permissions and approve. Nothing is stored in the plugin.

## Two auth paths

**OAuth, the default.** `.mcp.json` carries the URL and nothing else. Billr is
its own OAuth 2.1 authorization server, so Claude Code discovers the sign-in
page from the URL, registers itself, and runs the consent flow. There is no
client ID, no secret and no header to fill in.

**API key.** For a setup that cannot do a browser sign-in, create a key under
Agents then API Keys and send it as a bearer token. Do not edit the bundled
`.mcp.json` to hold a key: it is a committed file. Add the server separately
instead:

```bash
claude mcp add --transport http billr https://<your-domain>/api/mcp \
  --header "Authorization: Bearer YOUR_KEY"
```

Type the key in literally rather than letting the shell expand a variable, so
a resolved secret is not written into the client configuration by the shell.

## Pointing the plugin at your install

The plugin's `.mcp.json` points at `http://localhost:3000/api/mcp`, a local
install. For a deployed Billr, two ways to change it:

1. Copy `billr/` and change the one `url` in `.mcp.json`:

   ```json
   {
     "mcpServers": {
       "billr": {
         "type": "http",
         "url": "https://<your-domain>/api/mcp"
       }
     }
   }
   ```

2. Leave the plugin alone and add your own server alongside it, which is
   simpler if you want both:

   ```bash
   claude mcp add --transport http billr-prod \
     https://<your-domain>/api/mcp
   ```

   With a key instead of OAuth:

   ```bash
   claude mcp add --transport http billr-prod \
     https://<your-domain>/api/mcp \
     --header "Authorization: Bearer YOUR_KEY"
   ```

The skill is the same either way; only the URL changes.

## Using it

- The skill loads itself when a request looks like billing work. It is
  namespaced as `/billr:billr` if you want to invoke it by hand.
- `/billr:billr-status` runs the read-only summary: unbilled work, what is
  ready to bill, outstanding invoices, and the current period's revenue. It
  writes nothing.

Plugin components are namespaced by the plugin name, so the command file
`commands/billr-status.md` is invoked as `/billr:billr-status`. Claude Code's
own guidance is to prefer `skills/` for new plugins; the status prompt sits in
`commands/` on purpose, with `disable-model-invocation: true`, so it only ever
runs when a person types it.

## Validate

```bash
claude plugin validate ./plugins/claude-code/billr
claude plugin validate ./plugins/claude-code
```

Add `--strict` to treat warnings as errors.
