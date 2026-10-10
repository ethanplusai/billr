# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

First release as a standalone repository.

### Added

- The invoicing workspace: clients, items, invoices, estimates, time entries, expenses, payments and reports, with per-business numbering, currencies, discounts and tax.
- Estimates a client can approve or decline through a public link, and convert into an invoice or an engagement.
- Engagements: an agreed total with a billing schedule, entries billed from an invoice or waived, and a ready-to-bill view.
- Payments recorded by any method, reconciled in the database, with corrections and voids kept in an audit trail.
- Optional card payments on your own Stripe account, configured with three environment variables, with signed, idempotently processed webhook events for payments, failures, refunds and disputes.
- Optional invoice and estimate email through your own Resend account, with an optional daily cap.
- Task billing for agents: open, heartbeat, record usage against and complete a task, leaving a record for a person to price and approve.
- The MCP server at `/api/mcp` with 53 tools, connect-by-URL OAuth 2.1, and `billr_sk_` API keys with permission profiles, activity and audit views.
- `packages/agent-kit` and agent connection packs in `plugins` for Claude Code, Codex, Cursor and OpenClaw, plus Grok connection notes.
- Sign-up closes after the first account, who owns the installation; `BILLR_OPEN_SIGNUP=true` reopens it.
- One baseline database migration with SQL tests (`npm run test:sql`).
- `npm run doctor`, `npm run setup:local`, a Dockerfile and Compose file with a documented recipe for the local database, and [docs/fresh-machine-test.md](docs/fresh-machine-test.md).
- CI: unit tests, lint, type-check, unused-code check, build, dependency audit, SQL tests, generated-type drift and a container build.

### Security

- Public invoice and estimate access goes only through read-only database functions keyed on a secret `public_id`, returning an allow-list of columns.
- Every tool and route resolves data through a business scope; a missing record and an out-of-scope record return the same generic error.
- Every function and table states its privileges explicitly, revoked from `anon` and `authenticated` and granted back only where needed.
