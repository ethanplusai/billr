# Contributing to Billr

Thank you for wanting to help. Please read this page before opening a pull request; it will save you a round trip.

## What Billr is for

Billr is self-hosted invoicing that people and their agents run to bill their own clients. Changes that serve that are welcome. Changes that turn it into a hosted service are not: plans and trials, a payment platform between the operator and Stripe, a public support desk, terms acceptance, telemetry. Pull requests are reviewed and merged here. Contributions are accepted under Apache-2.0, the same license as the project.

## Setting up locally

You need Node.js 22+, Docker and the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) 2.67.1 or newer.

```sh
git clone https://github.com/ethanplusai/billr.git
cd billr/app
npm run doctor
npm ci
npm run setup:local
npm run dev -- --hostname 127.0.0.1
```

`npm run setup:local` starts an isolated local Supabase project, applies every migration and writes an ignored `app/.env.local`. Never point local development, tests or acceptance runs at a database that holds real invoices.

## Branches, commits and pull requests

- Branch from `main`. Name the branch for the change, for example `fix-estimate-conversion-currency`.
- One concern per pull request. A refactor bundled with a behaviour change is hard to review and harder to revert.
- Write commit subjects in the imperative mood, under about 72 characters, describing what the change does rather than what you did: `Bill engagement entries from invoices`, not `fixed stuff`. Put the reasoning in the body, wrapped at 72 columns.
- A pull request description should say what the problem was, what the resulting behaviour is, and how you validated it. Paste the commands you ran.

## Tests to run

From `app/`:

```sh
npm test                  # unit and integration tests (vitest)
npm run test:installation # configuration, scripts and repository checks
npm run lint              # eslint
npm run typecheck         # next typegen, then tsc
npm run check:unused      # unused files, exports and dependencies (knip)
npm run build             # production build
supabase start && npm run test:sql   # SQL tests, for database changes
```

Run all of them for anything that touches shared code. Add tests with the change: a bug fix should come with the test that would have caught it.

## Database migrations

Migrations are append-only. A migration that has been applied anywhere is history, and history is not edited.

- The schema starts from one baseline, `app/supabase/migrations/00001_baseline.sql`. Add a change as a new file with the next number, zero padded to five digits, and a short snake_case description: `00002_short_description.sql`.
- Never modify an applied migration, and never renumber one. Fix a mistake with a new migration.
- Verify the migration twice: on a fresh database (`supabase db reset`) and on an existing local database with the earlier migrations applied (`supabase migration up`). Both must succeed, and `npm run test:sql` must pass.
- Every `SECURITY DEFINER` function must end with `SET search_path = public, pg_temp`. `CREATE OR REPLACE FUNCTION` replaces the whole config rather than merging it, so recreating a function silently drops that pin; `app/supabase/tests/security.sql` asserts that every function in `public` keeps it.
- **Grants are not optional work.** Supabase grants `EXECUTE` on every new function to `anon`, `authenticated` and `service_role` by name, so `REVOKE ALL ON FUNCTION ... FROM PUBLIC` does not lock anything down. Explicitly `REVOKE ALL ON FUNCTION ... FROM anon, authenticated`, then `GRANT` back only what is needed, and assert the result in the same migration with `has_function_privilege(...)`.
- Public invoice and estimate access goes only through the dedicated `SECURITY DEFINER` functions keyed on `public_id`. Do not add broad `SELECT` policies to `invoices` or `estimates`.
- Public payloads are built from an **allowlist** of columns, never by subtracting columns from a row. Adding a column to `businesses` or `clients` must not widen what a public document exposes.
- Validate against the real schema, not a rebuilt subset. Some constraints are added by `ALTER TABLE` after the tables exist and will not be reproduced by a stub schema.
- `app/src/types/database.ts` is generated with `supabase gen types typescript --local --schema public`. Regenerate it after a migration rather than hand-editing it; CI fails when it is stale.

## MCP tool contract rules

The MCP server and the agent toolkit are a published contract. Agents in the wild depend on it.

- Every tool must reach data through the scoped database helpers. A bare service-role query without a business scope filter is never acceptable in a tool.
- A missing record and an out-of-scope record must return the same generic error. Different errors would tell an agent whether someone else's invoice exists.
- Every tool belongs to exactly one permission. An uncategorised tool is denied by default; add it to the right set in the same change.
- The tool catalog is asserted against the registered tools by a test. Never hand-maintain a list of tools somewhere else in the codebase; a hand-written list once advertised a tool that did not exist and omitted one that did.
- Write tools that an agent may retry must take a stable request id and be idempotent.
- Changing a tool's name, its input schema or the meaning of a field is a breaking change. Say so in the pull request.

## Copy rules

These apply to everything a user can read: UI strings, error messages, documentation, comments and commit messages.

- **No em-dashes.** Use a comma, a colon, a full stop or a pair of brackets.
- **No fabricated metrics or claims.** No user counts, no dollars billed, no ratings, no "trusted by" numbers, no performance figures that nobody measured.
- **Fictional data only.** Sample and demo content uses the project's fictional cast (Fieldstone Digital, Harbor & Lane, Halcyon Labs, Meridian Design, Camber Coffee) on `.example` domains reserved by RFC 2606. Never use a real person, business, client, domain or email address, including your own.
- Write plainly. Say what something does and what it does not do.

## What maintainers will not merge

- Anything that weakens tenant isolation: a new service-role caller, a broad row-level policy, a tool that trusts a client-supplied business id.
- A change to an already applied migration, or a renumbered one.
- Secrets, environment files, database dumps, real invoices, logs or build output committed to the tree.
- A telemetry, analytics, crash-reporting or auto-update channel that phones home from an installation.
- A second implementation of something that already exists, for example a parallel copy of a tool list, a duplicated billing calculation or an app-only code path that the MCP tools do not share.
- A hard-coded URL, address or provider account of someone else's deployment. Everything an operator needs comes from their own environment.
- SaaS features: plans, trials, paywalls, platform payments, a public support form, terms acceptance.
- Fabricated claims, em-dashes, real customer data in fixtures.
- A dependency added for a few lines of code, or one whose license is not compatible with Apache-2.0. New third-party assets must keep their license and notice files.
- A large unsolicited rewrite. Open an issue and agree the approach first.

## Reporting a vulnerability

Do not open a pull request or a public issue for a security problem. Follow [SECURITY.md](SECURITY.md).
