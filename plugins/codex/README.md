# Billr for Codex and ChatGPT

One plugin serves both. Codex runs inside the ChatGPT desktop app, and
ChatGPT and Codex share one plugin format, one plugin directory and one sign-in
contract. Sources: https://developers.openai.com/plugins/build/plugins.md,
https://developers.openai.com/plugins/build/auth.md and
https://developers.openai.com/plugins/build/chatgpt-ui.md.

## What is in the package

```
plugins/codex/
  .claude-plugin/marketplace.json    marketplace Codex reads (its legacy-compatible
                                     path)
  billr/
    .codex-plugin/plugin.json        Codex manifest: listing details, MCP, skills
    .mcp.json                        Billr as a remote MCP server (OAuth)
    plugin.json, mcp.json            the same, in the portable Agent Plugins format
    assets/logo.png, icon.png        listing logo and composer icon
    skills/billr/                    generated from plugins/shared/skill
  codex-config.toml                  the [mcp_servers.billr] table, for manual setup
  AGENTS.billr.md                    the short form, to paste into your AGENTS.md
```

Everything under `skills/` is generated. Edit `plugins/shared/skill/` and run
`node app/scripts/generate-plugin-tool-reference.mjs`.

## Install the plugin

From a checkout of this repository:

```bash
codex plugin marketplace add ./plugins/codex
codex plugin add billr@billr
codex mcp login billr        # opens Billr in the browser: pick business and permissions
```

The plugin then shows under Plugins, Installed in the Codex CLI (`/plugins`)
and in the Codex tab of the ChatGPT desktop app, which reads the same
`~/.codex` home. From GitHub instead of a checkout:
`codex plugin marketplace add ethanplusai/billr --sparse plugins/codex`.

## Cards

`get_invoice`, `get_estimate`, `revenue_summary` and `list_ready_to_bill`
render a Billr card (MCP Apps, `ui://billr/*`) in hosts that support UI. Each
tool still returns its full JSON as text, so the Codex CLI and every other MCP
client work exactly as before. Card buttons send a user message ("Send invoice
INV-0042 to Harbor & Lane.") rather than calling a tool, so the model and the
host's confirmation stay in the loop. OpenAI documents UI for ChatGPT; whether
the Codex tab renders it is not documented, so check it there by hand.

## 1. Connect the MCP server

The quickest path, from the Billr connect docs:

```bash
codex mcp add billr --url https://<your-domain>/api/mcp
codex mcp login billr
codex mcp list
```

`codex mcp login` opens Billr in a browser. Pick the business and the
permissions, then approve. `/mcp` inside the Codex TUI shows the same list.

To configure it by hand instead, copy the table from `codex-config.toml` into
`~/.codex/config.toml`, or into a trusted project's `.codex/config.toml`:

```toml
[mcp_servers.billr]
url = "https://<your-domain>/api/mcp"
```

**API key instead of OAuth.** Create a key under Agents then API Keys, export
it in the shell that starts Codex, and let Codex read it from the environment.
The key never goes in the file:

```toml
[mcp_servers.billr]
url = "https://<your-domain>/api/mcp"
bearer_token_env_var = "BILLR_API_KEY"
```

For a local install, use `url = "http://localhost:3000/api/mcp"` instead.

## 2. Give Codex the instructions

Pick one:

- **As a skill.** Copy `billr/skills/billr/` into your Codex skills directory.
  A skill is a directory with `SKILL.md` carrying `name` and `description` in
  its frontmatter, plus `references/`; this one is exactly that. In the Codex
  CLI or IDE extension, `/skills` lists it and `$` mentions it. In ChatGPT,
  `@` selects it.
- **As AGENTS.md.** Paste the section from `AGENTS.billr.md` into the
  `AGENTS.md` you already keep, either the global one in your Codex home
  directory or a repository one. Do not copy the file under that name: a file
  called `AGENTS.md` would override the project's own instructions.

- **As a plugin.** See "Install the plugin" above. Plugins are not available
  in the IDE extension, so IDE users take one of the two options above.

## ChatGPT developer mode

ChatGPT connects to Billr by URL alone; there is nothing to package. Source:
https://developers.openai.com/api/docs/mcp.

1. Settings, then "Security and login", then turn on Developer mode.
2. Go to ChatGPT Plugins and select the plus button.
3. Paste `https://<your-domain>/api/mcp` and connect the server in developer mode.
4. Sign in to Billr, choose the business and the permissions, approve.

OAuth is the only way in here: there is no API key field. Use the skill above
if you want ChatGPT to follow Billr's workflows as well as call its tools.

## Verify

Ask Codex: "List my Billr clients and tell me what is still unbilled." It
reads only, so nothing is created or sent.
