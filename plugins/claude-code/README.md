# Billr for Claude Code

This plugin connects to hosted Billr at `https://mcp.billr.cc`. It includes
the billing skill, generated tool reference and `/billr:billr-status` command.
A Billr account is required; plugin installation includes no subscription.

## Install

Once the repository is publicly accessible:

```sh
claude plugin marketplace add ethanplusai/billr
claude plugin install billr@billr
```

From a checkout instead:

```sh
claude plugin marketplace add ./plugins/claude-code
claude plugin install billr@billr
```

Open `/mcp`, select Billr and authenticate. Choose the intended business and
Read only for the first test. Run `/billr:billr-status` and verify no data is
changed. For a temporary local package test:

```sh
claude --plugin-dir ./plugins/claude-code/billr
```

Validate before release:

```sh
claude plugin validate ./plugins/claude-code/billr
claude plugin validate ./plugins/claude-code
```

## Self-hosting

The distributed package defaults to hosted Billr. For your own installation,
configure it directly with `claude mcp add --transport http billr-selfhosted
https://billing.example.com/api/mcp` and authenticate, or change the URL in a
private copy of `.mcp.json`. Avoid duplicate servers for the same account.
Use OAuth; do not put bearer keys in command-line arguments or chat.

## Distribution

The GitHub marketplace works independently of Anthropic's public directory.
Directory inclusion requires a separate submission and review. Claude web and
Desktop use a custom remote connector; test that surface separately from
Claude Code before submitting its connector listing.

Sources: https://code.claude.com/docs/en/plugin-marketplaces,
https://code.claude.com/docs/en/plugins-reference,
https://claude.com/docs/connectors/building/submission.
