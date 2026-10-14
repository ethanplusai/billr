# Billr for Codex and ChatGPT

The `billr/` package connects to hosted Billr at `https://mcp.billr.cc`.
It includes portable Agent Plugins and Codex manifests, OAuth MCP
configuration, listing assets and the generated billing skill. A Billr
account is required; installation does not include a subscription.

## Install in Codex

From a checkout:

```sh
codex plugin marketplace add ./plugins/codex
codex plugin add billr@billr
codex mcp login billr
```

For MCP-only setup:

```sh
codex mcp add billr --url https://mcp.billr.cc
codex mcp login billr
codex mcp list
```

Use one setup path to avoid duplicate servers. Select the business and minimum
permissions in the browser. Never paste credentials into chat. For self-hosting,
replace the URL in your private configuration; see `codex-config.toml`.

## ChatGPT and public distribution

Test the hosted server through the available custom MCP/developer connection
flow in your account. Test read-only access, explicit drafts and cards before
submission. UI availability differs by client; text results remain required.

Public directory publication requires an OpenAI plugin ZIP upload, verified
publishing identity, automated checks, reviewer access and review approval.
The package has no app-reference file or lifecycle hooks: these are not
eligible for current public submission. Upload a ZIP rooted at `billr/`,
containing its manifests, MCP files, skills, assets and license notices.
Do not include credentials, reviewer passwords or private audit notes.

Sources: https://developers.openai.com/plugins/build/plugins,
https://developers.openai.com/plugins/deploy/submission.
