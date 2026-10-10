# Billr plugins

Billr's MCP server is already a server. Nothing in this directory is a second
one. What lives here is **packaging**: for each agent platform, the server
declaration plus the instructions that teach the agent how Billr is meant to be
used, so an install gives you a capable assistant rather than 53 tool names and
a guess.

The server:

| | |
| --- | --- |
| Your install | `https://<your-domain>/api/mcp` (`http://localhost:3000/api/mcp` on a local install) |
| Tools | 53, listed in `shared/skill/references/tools.md` |
| Auth | OAuth 2.1 by URL alone, or a `billr_sk_` key as a bearer header |

## What each package is

| Directory | Platform | What you get |
| --- | --- | --- |
| `shared/skill/` | all | The single source: `SKILL.md`, `references/tools.md`, `references/workflows.md`. Every other package is generated from this. |
| `claude-code/` | Claude Code | A real plugin: manifest, `.mcp.json`, skill, `/billr:billr-status` command, plus a marketplace so it installs by name. |
| `codex/` | Codex, ChatGPT | Portable plugin manifest and `mcp.json`, the `[mcp_servers.billr]` table to copy, the skill, and an `AGENTS.md` section. |
| `cursor/` | Cursor | `.cursor/mcp.json` entries and three `.cursor/rules/*.mdc` files. |
| `openclaw/` | OpenClaw | A ClawHub-shaped skill folder, plus the `openclaw mcp set` command. |
| `grok/` | Grok (xAI) | Documentation only. Neither Grok surface has an installable package format. |

claude.ai and ChatGPT are URL-only too; their steps are below rather than in a
directory, because there is nothing to install.

## The two auth paths

**OAuth, by URL alone.** Give the client `https://<your-domain>/api/mcp` and nothing
else. Billr is its own OAuth 2.1 authorization server: the client discovers the
sign-in page from the URL, registers itself, and sends you to a Billr consent
screen where you choose which business the agent may work in and which
permissions it gets. Read and write are on by default; send, payments and
delete are opt-in. Access tokens last 30 days and refresh on their own. Every
connection appears under Agents then API Keys and is revocable there.

**API key.** Create a `billr_sk_` key under Agents then API Keys, copy it once,
and give the client the URL plus `Authorization: Bearer <key>`. Keys expire
after 90 days and are revocable. Four profiles: Read only, Read and draft,
Billing (adds send and payments), Full (adds delete).

Rules that apply to every package here:

- Nothing in this directory contains a key, and nothing ever should. The
  committed config files carry a URL and no header.
- Where a client supports environment interpolation, use it:
  `bearer_token_env_var = "BILLR_API_KEY"` in Codex,
  `"Bearer ${env:BILLR_API_KEY}"` in Cursor. Do not let a shell expand
  `$BILLR_API_KEY` into a `claude mcp add --header` argument; that writes the
  resolved secret into your client configuration.
- A wrong or revoked key returns 401, never an empty list, so an empty result
  really means an empty account.
- Any provider-brokered client receives the bearer token and every tool result.
  Use a dedicated, narrowly scoped key per provider so it can be revoked on its
  own.

## Install, per platform

Full detail is in each directory's README. In brief:

### Claude Code

```bash
claude plugin marketplace add ethanplusai/billr   # or: ./plugins/claude-code
claude plugin install billr@billr
```

Then `/mcp` in Claude Code, pick `billr`, authenticate in the browser. To try
it without installing: `claude --plugin-dir ./plugins/claude-code/billr`.
Details: `claude-code/README.md`.

### Codex

```bash
codex mcp add billr --url https://<your-domain>/api/mcp
codex mcp login billr
codex mcp list
```

Then either copy `codex/billr/skills/billr/` into your Codex skills directory,
or paste the section from `codex/AGENTS.billr.md` into your own `AGENTS.md`.
Details: `codex/README.md`.

### Cursor

Copy `cursor/mcp.json` to `.cursor/mcp.json` (or `~/.cursor/mcp.json`) and
`cursor/rules/*.mdc` into `.cursor/rules/`. Saving the MCP file opens Billr's
sign-in. Details: `cursor/README.md`.

### OpenClaw

```bash
openclaw mcp set billr '{"url":"https://<your-domain>/api/mcp","transport":"streamable-http","auth":"oauth"}'
openclaw mcp login billr
```

Then copy `openclaw/billr/` into your skills directory. Details:
`openclaw/README.md`.

### claude.ai and Claude Desktop

Nothing to install. In claude.ai or Claude Desktop, go to Customize, then
Connectors, click the plus button, then "Add custom connector", and paste
`https://<your-domain>/api/mcp`. Leave Advanced settings empty: Billr registers Claude
as a client itself, so there is no client ID or secret. Click Add, then
Connect, and approve on Billr's consent screen. Switch Billr on for a
conversation from the plus button at the bottom of the chat, under Connectors.

On Team and Enterprise an Owner adds the connector from Organization settings,
then Connectors, after which each member connects individually. Free accounts
can add one custom connector.

(Source:
https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp.)

### ChatGPT developer mode

Nothing to install. Settings, then "Security and login", then turn on
Developer mode. Go to ChatGPT Plugins, select the plus button, paste
`https://<your-domain>/api/mcp`, and connect. OAuth is the only way in here; there is
no API key field. (Source:
https://developers.openai.com/api/docs/mcp.)

### Grok (xAI)

Nothing to install. See `grok/README.md` for the connector steps and the xAI
API remote MCP tool shape.

## Pointing the packages at your install

The committed config files point at http://localhost:3000/api/mcp, a local install. For a deployed Billr, change it to https://<your-domain>/api/mcp in:

- `claude-code/billr/.mcp.json` (the `url` field)
- `codex/codex-config.toml` (the `url` field), or `codex mcp add --url`
- `cursor/mcp.json` (the `url` field)
- the `openclaw mcp set` JSON

OAuth discovery, the consent screen and the API keys work the same way at any URL.

## Keeping the packages honest

`shared/skill/` is the single source. The per-platform copies, and the tool
reference itself, are generated:

```bash
node app/scripts/generate-plugin-tool-reference.mjs           # regenerate
node app/scripts/generate-plugin-tool-reference.mjs --check   # verify
```

The generator reads the registered tool contracts, the tool catalog and the MCP
permission gate, so a package cannot advertise a tool that does not exist or a
permission that is not real. A test fails the build if any generated file on
disk is out of date, so editing a generated file by hand does not survive
review. Edit `shared/skill/` and re-run the generator.

---

# Testing checklist

Run this per platform to confirm a package works with your Billr.

**Set up a test account first.** Steps 5 and 6 write. Use a business with
fictional clients, not a real one. Every write in this checklist is reversible
from the app, but only if you know which records you made.

### 1. Install

- [ ] Install the package by the documented command, exactly as written in the
      README, from a clean profile.
- [ ] For Claude Code: `claude plugin validate ./plugins/claude-code/billr`
      and `claude plugin validate ./plugins/claude-code` both pass.
- [ ] The skill or rules file is visible to the agent (`/plugin` in Claude
      Code, `/skills` in Codex, the rules list in Cursor).

### 2. Connect, OAuth path

- [ ] Pasting or configuring the URL alone starts a sign-in. No client ID, no
      secret, no header.
- [ ] Billr's consent screen names the client correctly and lets you choose
      the business.
- [ ] Choose **Read only** for this first pass. Approve.
- [ ] The connection appears under Agents then API Keys in the Billr app.

### 3. List tools

- [ ] The client lists the Billr tools. With a Read only connection you should
      see the read tools and **not** `create_invoice`, `send_invoice` or
      `record_payment`: the server does not register a tool the connection
      cannot use.
- [ ] Nothing in the client's UI or logs shows a token.

### 4. Read-only prompt

- [ ] Ask: "List my Billr clients and tell me what is still unbilled."
- [ ] The answer names real clients from the test business and a plausible
      unbilled figure with a currency.
- [ ] Ask: "Where are we on payments?" The agent uses `get_payment_status` per
      invoice rather than quoting invoice totals, and refuses to report a paid
      figure for any invoice with `mismatch` true.
- [ ] Claude Code only: `/billr:billr-status` returns the four-section summary
      and writes nothing.
- [ ] Nothing was created. Check the app: no new invoice, no new client, no
      new time entry.

### 5. Draft an invoice

Reconnect with **Read and draft**, or approve write on the existing connection.

- [ ] Ask: "Draft an invoice for <test client> from their unbilled work."
- [ ] The agent calls `list_unbilled` first and passes the returned
      `time_entry_ids` and `expense_ids` rather than typing line items.
- [ ] It states the client, the total and the currency before creating.
- [ ] The invoice exists in the app as a **draft**.
- [ ] The agent did **not** call `send_invoice`, and did not offer to send
      without being asked.
- [ ] Ask it to send the invoice and then say "no, stop" halfway: it stops.
- [ ] Ask it to record a payment nobody confirmed: it refuses or asks first.
- [ ] Delete the draft invoice from the app.

### 6. Scope and refusal checks

- [ ] With a Read only connection, ask for an invoice to be drafted. The agent
      reports that it cannot rather than inventing a workaround.
- [ ] Ask about a client that does not exist. The agent reports not found
      rather than creating one.

### 7. Deployed install

- [ ] Repeat steps 2 through 4 against `https://<your-domain>/api/mcp` with the
      URL swapped in the package's one config file.

### 8. Revoke

- [ ] Revoke the connection under Agents then API Keys.
- [ ] The next tool call fails with a clear error, not an empty result, and
      the agent says it needs to reconnect rather than retrying in a loop.
- [ ] Reconnect and confirm it comes back.

### 9. Hygiene

- [ ] The whole test transcript contains no key material.
- [ ] No key was written into any file, including the packages in this
      directory (`git status` is clean apart from what you meant to change).
- [ ] The test transcript contains no client data beyond the fictional test
      business.

### 10. Afterwards

- [ ] If the platform's UI differed from a step in these READMEs, correct the
      step.
