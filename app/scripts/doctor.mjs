// Checks a machine before installing Billr. Uses only Node built-ins, so it
// runs before `npm ci`. Prints PASS, WARN or FAIL per check; exits 1 on FAIL.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MIN_NODE_MAJOR = 22
/** The Supabase CLI version CI tests the migrations with. */
export const MIN_SUPABASE_CLI = '2.67.1'
/** Memory Docker needs to build the production image (see docs/self-hosting.md). */
export const BUILD_MEMORY_BYTES = 4 * 1024 ** 3

export function compareVersions(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] || 0) - (right[i] || 0)
    if (difference) return Math.sign(difference)
  }
  return 0
}

export function checkNode(version = process.versions.node) {
  const major = Number(version.split('.')[0])
  return major >= MIN_NODE_MAJOR
    ? { status: 'pass', name: 'Node.js', detail: `v${version}` }
    : {
        status: 'fail',
        name: 'Node.js',
        detail: `v${version} found; install Node.js ${MIN_NODE_MAJOR} or newer (the repository's .nvmrc names it)`,
      }
}

export function checkDocker(run) {
  let output
  try {
    output = run('docker', ['info', '--format', '{{.ServerVersion}} {{.MemTotal}}']).trim()
  } catch {
    return {
      status: 'fail',
      name: 'Docker',
      detail: 'not running or not installed; start Docker Desktop (or the Docker daemon) and run this again',
    }
  }
  const [version, memory] = output.split(' ')
  const bytes = Number(memory)
  if (Number.isFinite(bytes) && bytes > 0 && bytes < BUILD_MEMORY_BYTES)
    return {
      status: 'warn',
      name: 'Docker',
      detail: `running (${version}) with ${(bytes / 1024 ** 3).toFixed(1)} GB; local development works, but give Docker at least 4 GB before building the production image`,
    }
  return { status: 'pass', name: 'Docker', detail: `running (${version})` }
}

export function checkSupabaseCli(run, cli = 'supabase') {
  let output
  try {
    output = run(cli, ['--version'])
  } catch {
    return {
      status: 'fail',
      name: 'Supabase CLI',
      detail: 'not found; install it: https://supabase.com/docs/guides/local-development/cli/getting-started',
    }
  }
  const version = output.match(/\d+\.\d+\.\d+/)?.[0]
  if (!version)
    return { status: 'warn', name: 'Supabase CLI', detail: `could not read a version from "${output.trim()}"` }
  return compareVersions(version, MIN_SUPABASE_CLI) >= 0
    ? { status: 'pass', name: 'Supabase CLI', detail: `v${version}` }
    : { status: 'fail', name: 'Supabase CLI', detail: `v${version} found; update to ${MIN_SUPABASE_CLI} or newer` }
}

function canConnect(port) {
  return new Promise((done) => {
    const socket = connect({ port, host: '127.0.0.1' })
    socket.setTimeout(1000)
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      done(false)
    })
    socket.once('error', () => done(false))
  })
}

function canListen(port) {
  return new Promise((done) => {
    const server = createServer()
    server.once('error', () => done(false))
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
  })
}

/**
 * Free means nothing answers on it and we can bind it. The connect probe
 * matters on macOS, where binding 127.0.0.1 can succeed while Docker holds
 * the same port on 0.0.0.0.
 */
export async function portFree(port) {
  if (await canConnect(port)) return false
  return canListen(port)
}

export async function checkPorts({ appPort, dbBase, isFree = portFree, envExists }) {
  const first = dbBase - 1
  const ports = [appPort, ...Array.from({ length: 10 }, (_, i) => first + i)]
  const busy = []
  for (const port of ports) if (!(await isFree(port))) busy.push(port)
  const fixes = []
  if (busy.includes(appPort))
    fixes.push(
      `set BILLR_LOCAL_APP_PORT for the app (${appPort} is busy), for example BILLR_LOCAL_APP_PORT=${appPort + 10} npm run doctor, then the same prefix on npm run setup:local`,
    )
  if (busy.some((port) => port !== appPort))
    fixes.push(`set BILLR_LOCAL_DB_PORT for the database (it uses ${first}-${first + 9}; busy: ${busy.filter((port) => port !== appPort).join(', ')})`)
  if (!busy.length)
    return { status: 'pass', name: 'Ports', detail: `${appPort} and ${first}-${first + 9} are free` }
  return {
    status: envExists ? 'warn' : 'fail',
    name: 'Ports',
    detail: envExists
      ? `in use: ${busy.join(', ')}. Expected if your Billr dev server or local database is already running.`
      : `in use: ${busy.join(', ')}. Stop whatever holds them, or choose other ports for setup:local: ${fixes.join('; ')}.`,
  }
}

export function checkEnvFile(envExists) {
  return envExists
    ? {
        status: 'warn',
        name: '.env.local',
        detail: 'already exists, so setup:local will refuse to overwrite it. Expected if you already ran setup:local.',
      }
    : { status: 'pass', name: '.env.local', detail: 'not created yet; setup:local will write it' }
}

const LABEL = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' }

export function report(results) {
  const ok = !results.some((result) => result.status === 'fail')
  const lines = results.map((result) => `${LABEL[result.status]}  ${result.name}: ${result.detail}`)
  lines.push(ok ? 'Ready. Next: npm ci, then npm run setup:local.' : 'Fix the FAIL lines above, then run npm run doctor again.')
  return { text: lines.join('\n'), ok }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = fileURLToPath(new URL('../', import.meta.url))
  const run = (command, args) =>
    execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 })
  const envExists = existsSync(resolve(app, '.env.local'))
  const results = [
    checkNode(),
    checkDocker(run),
    checkSupabaseCli(run, process.env.BILLR_SUPABASE_CLI || 'supabase'),
    await checkPorts({
      appPort: Number(process.env.BILLR_LOCAL_APP_PORT || 3000),
      dbBase: Number(process.env.BILLR_LOCAL_DB_PORT || 56421),
      envExists,
    }),
    checkEnvFile(envExists),
  ]
  const { text, ok } = report(results)
  console.log(text)
  process.exitCode = ok ? 0 : 1
}
