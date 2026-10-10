import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Every variable the application reads is documented in .env.example, and
// every variable documented there is read somewhere. Variables that a runtime
// or the container sets, rather than an operator, are listed here.
const app = fileURLToPath(new URL('../', import.meta.url))
// VERCEL and VERCEL_ENV are set by Vercel's runtime when Billr is deployed there.
const RUNTIME = new Set(['NODE_ENV', 'NEXT_RUNTIME', 'BILLR_CONTAINER', 'BILLR_CONTAINER_BUILD', 'VERCEL', 'VERCEL_ENV'])

function sources(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name)
    if (lstatSync(path).isDirectory()) out.push(...sources(path))
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

const read = (path) => readFileSync(path, 'utf8')
const used = new Set()
// `env.NAME` covers helpers that take the environment as a parameter, such as
// emailDailyLimit(env) and validateConfig(env).
const READS = /(?:process\.env|\benv)\.([A-Z][A-Z0-9_]+)/g
for (const file of [
  ...sources(resolve(app, 'src')),
  resolve(app, 'next.config.ts'),
  resolve(app, 'scripts/validate-config.mjs'),
])
  for (const match of read(file).matchAll(READS)) used.add(match[1])

const documented = new Set(
  read(resolve(app, '.env.example'))
    .split('\n')
    .map((line) => line.match(/^([A-Z][A-Z0-9_]+)=/)?.[1])
    .filter(Boolean),
)

test('every variable the app reads is in .env.example', () => {
  assert.deepEqual([...used].filter((key) => !RUNTIME.has(key) && !documented.has(key)).sort(), [])
})

test('every variable in .env.example is read by the app', () => {
  assert.deepEqual([...documented].filter((key) => !used.has(key)).sort(), [])
})
