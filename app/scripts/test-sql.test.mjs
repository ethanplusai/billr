import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { containerName, projectId, sqlTestFiles } from './test-sql.mjs'

const app = fileURLToPath(new URL('../', import.meta.url))
const tests = fileURLToPath(new URL('../supabase/tests/', import.meta.url))

test('reads the project id from config.toml', () =>
  assert.equal(projectId('project_id = "billr-development"\n[api]\n'), 'billr-development'))

test('refuses a config without a project id', () =>
  assert.throws(() => projectId('[api]\nport = 1\n'), /project_id/))

test('derives the database container from the checked-in config', () =>
  assert.equal(containerName(app), 'supabase_db_billr'))

test('finds the SQL tests in name order', () => {
  const files = sqlTestFiles(tests)
  assert.ok(files.includes('security.sql'))
  assert.deepEqual(files, [...files].sort())
})

test('no SQL test includes another file, because tests are piped through stdin', () => {
  for (const file of sqlTestFiles(tests))
    assert.doesNotMatch(readFileSync(`${tests}${file}`, 'utf8'), /^\\i/m, file)
})
