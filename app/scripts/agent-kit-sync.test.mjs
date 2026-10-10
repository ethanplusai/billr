import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The agent kit ships the app's own calculations and tool catalog. Two copies
// are only safe while they are the same file.
const PAIRS = [
  ['src/lib/work/time.ts', 'time.ts'],
  ['src/lib/stripe/money.ts', 'money.ts'],
  ['src/lib/mcp/tool-catalog.ts', 'tool-catalog.ts'],
]

for (const [app, kit] of PAIRS)
  test(`packages/agent-kit/src/${kit} matches app/${app}`, () =>
    assert.equal(
      readFileSync(new URL(`../../packages/agent-kit/src/${kit}`, import.meta.url), 'utf8'),
      readFileSync(new URL(`../${app}`, import.meta.url), 'utf8'),
      `Update both copies: app/${app} and packages/agent-kit/src/${kit}`,
    ))
