import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import {
  MIN_SUPABASE_CLI,
  checkDocker,
  checkEnvFile,
  checkNode,
  checkPorts,
  checkSupabaseCli,
  compareVersions,
  portFree,
  report,
} from './doctor.mjs'

test('compares versions numerically', () => {
  assert.equal(compareVersions('2.67.1', '2.67.1'), 0)
  assert.equal(compareVersions('2.120.0', '2.67.1'), 1)
  assert.equal(compareVersions('1.226.4', '2.67.1'), -1)
})

test('Node 22 passes and Node 20 fails', () => {
  assert.equal(checkNode('22.23.1').status, 'pass')
  const old = checkNode('20.19.0')
  assert.equal(old.status, 'fail')
  assert.match(old.detail, /22/)
})

test('a running Docker with enough memory passes', () =>
  assert.equal(checkDocker(() => '29.2.1 12528578560\n').status, 'pass'))

test('a running Docker with under 4 GB warns', () =>
  assert.equal(checkDocker(() => '29.2.1 2147483648\n').status, 'warn'))

test('Docker that is not running fails', () =>
  assert.equal(
    checkDocker(() => {
      throw new Error('Cannot connect to the Docker daemon')
    }).status,
    'fail',
  ))

test('the minimum Supabase CLI passes', () =>
  assert.equal(checkSupabaseCli(() => `${MIN_SUPABASE_CLI}\n`).status, 'pass'))

test('an older Supabase CLI fails and names the minimum', () => {
  const result = checkSupabaseCli(() => '1.226.4\n')
  assert.equal(result.status, 'fail')
  assert.match(result.detail, /2\.67\.1/)
})

test('a missing Supabase CLI fails with the install link', () => {
  const result = checkSupabaseCli(() => {
    throw new Error('ENOENT')
  })
  assert.equal(result.status, 'fail')
  assert.match(result.detail, /supabase\.com/)
})

test('free ports pass', async () =>
  assert.equal(
    (await checkPorts({ appPort: 3000, dbBase: 56421, isFree: async () => true, envExists: false })).status,
    'pass',
  ))

test('a busy port fails before setup, named with the override variable', async () => {
  const result = await checkPorts({
    appPort: 3000,
    dbBase: 56421,
    isFree: async (port) => port !== 56421,
    envExists: false,
  })
  assert.equal(result.status, 'fail')
  assert.match(result.detail, /56421/)
  assert.match(result.detail, /BILLR_LOCAL_DB_PORT/)
})

test('a busy app port fails, named with the app override and not the database one', async () => {
  const result = await checkPorts({
    appPort: 3000,
    dbBase: 56421,
    isFree: async (port) => port !== 3000,
    envExists: false,
  })
  assert.equal(result.status, 'fail')
  assert.match(result.detail, /BILLR_LOCAL_APP_PORT for the app \(3000 is busy\)/)
  assert.match(result.detail, /BILLR_LOCAL_APP_PORT=3010 npm run doctor, then the same prefix on npm run setup:local/)
  assert.doesNotMatch(result.detail, /BILLR_LOCAL_DB_PORT/)
})

test('checks the app port and the ten local database ports', async () => {
  const asked = []
  await checkPorts({
    appPort: 3000,
    dbBase: 56421,
    isFree: async (port) => {
      asked.push(port)
      return true
    },
    envExists: false,
  })
  assert.deepEqual(asked, [3000, 56420, 56421, 56422, 56423, 56424, 56425, 56426, 56427, 56428, 56429])
})

test('busy ports only warn once setup has run', async () =>
  assert.equal(
    (await checkPorts({ appPort: 3000, dbBase: 56421, isFree: async () => false, envExists: true })).status,
    'warn',
  ))

test('sees a port held on every interface, the way Docker publishes them', async () => {
  const server = createServer()
  await new Promise((done) => server.listen(0, '0.0.0.0', done))
  try {
    assert.equal(await portFree(server.address().port), false)
  } finally {
    await new Promise((done) => server.close(done))
  }
})

test('sees a port held on loopback only', async () => {
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  try {
    assert.equal(await portFree(server.address().port), false)
  } finally {
    await new Promise((done) => server.close(done))
  }
})

test('an existing .env.local is a warning, not a failure', () => {
  assert.equal(checkEnvFile(true).status, 'warn')
  assert.equal(checkEnvFile(false).status, 'pass')
})

test('the report fails only when a check fails', () => {
  assert.equal(report([{ status: 'pass', name: 'a', detail: '' }, { status: 'fail', name: 'b', detail: 'x' }]).ok, false)
  assert.equal(report([{ status: 'warn', name: 'a', detail: '' }]).ok, true)
  assert.match(report([{ status: 'fail', name: 'Docker', detail: 'not running' }]).text, /^FAIL {2}Docker: not running$/m)
})
