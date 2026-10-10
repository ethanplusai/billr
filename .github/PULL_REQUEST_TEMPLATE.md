## What this changes

<!-- The problem, and the resulting behaviour. One concern per pull request. -->

## Why

<!-- What made the current behaviour wrong or insufficient. Link the issue if there is one. -->

## How it was validated

<!-- Paste the commands you ran and their results. -->

```
cd app
npm test
npm run test:installation
npm run lint
npm run typecheck
npm run build
```

## Checklist

- [ ] One concern, and the diff is as small as that concern allows.
- [ ] Tests added or updated, including a test that would have caught the bug.
- [ ] Unit tests, installation checks, lint, type-check and a production build all pass.
- [ ] No em-dashes in anything a user can read, and no fabricated metrics or claims.
- [ ] Fixtures and sample content use the fictional cast on `.example` domains. No real person, business, client, domain or email address, including my own.
- [ ] No secrets, environment files, database dumps, real invoices, logs or build output are committed.

### If this touches the database

- [ ] A new migration with the next number; no applied migration was modified or renumbered.
- [ ] Verified with `supabase db reset` and `supabase migration up`, and `npm run test:sql` passes.
- [ ] Every `SECURITY DEFINER` function ends with `SET search_path = public, pg_temp`.
- [ ] Grants revoked from `anon` and `authenticated` and granted back explicitly, asserted in the same migration.
- [ ] Public payloads still build from a column allowlist.
- [ ] `app/src/types/database.ts` regenerated rather than hand-edited.

### If this touches MCP tools

- [ ] Data is reached through the scoped database helpers, never an unscoped service-role query.
- [ ] Missing and out-of-scope records return the same generic error.
- [ ] The tool is categorised under exactly one permission.
- [ ] The tool catalog test passes and the agent toolkit contracts are in step.
- [ ] Retryable writes take a stable request id and are idempotent.
- [ ] Any breaking change to a tool name, input schema or field meaning is called out above.
