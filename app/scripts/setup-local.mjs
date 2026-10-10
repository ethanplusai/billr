import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const app = fileURLToPath(new URL('../', import.meta.url))
const target = resolve(app, '.env.local')
if (existsSync(target))
  throw Error(
    'Refusing to overwrite .env.local. Use your existing installation or move the file yourself.',
  )
const port = Number(process.env.BILLR_LOCAL_APP_PORT || 3000)
const base = Number(process.env.BILLR_LOCAL_DB_PORT || 56421)
if (![port, base].every((n) => Number.isInteger(n) && n >= 1024 && n < 65000))
  throw Error('Local ports must be integers from 1024 to 64999')
const project = `billr-local-${base}`
const work = resolve(app, '.self-host', project)
mkdirSync(resolve(work, 'supabase'), { recursive: true })
let config = readFileSync(resolve(app, 'supabase/config.toml'), 'utf8')
config = config.replace(
  'project_id = "billr"',
  `project_id = "${project}"`,
)
config = config.replace(/554(\d\d)/g, (_, tail) =>
  String(base + Number(tail) - 21),
)
config = config.replace(
  /(\[analytics\]\s*\n)enabled = true/,
  '$1enabled = false',
)
config = config.replace('sql_paths = ["./seed.sql"]', 'sql_paths = []')
config = config
  .replaceAll('http://127.0.0.1:3000', `http://localhost:${port}`)
  .replaceAll('http://localhost:3000', `http://localhost:${port}`)
writeFileSync(resolve(work, 'supabase/config.toml'), config)
cpSync(
  resolve(app, 'supabase/migrations'),
  resolve(work, 'supabase/migrations'),
  { recursive: true },
)
const cli = process.env.BILLR_SUPABASE_CLI || 'supabase'
console.log(
  'Starting an isolated LOCAL DEVELOPMENT database. Docker must be running; first start can take several minutes.',
)
try {
  execFileSync(
    cli,
    [
      'start',
      '--workdir',
      work,
      '-x',
      'studio,realtime,imgproxy,edge-runtime,logflare,vector,supavisor,postgres-meta',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 },
  )
} catch (error) {
  // Never echo CLI output: it can contain API/admin keys.
  throw Error(
    `Local database startup failed (exit ${error.status}). Inspect Docker and run supabase start --workdir ${work} in your own terminal.`,
  )
}
const status = JSON.parse(
  execFileSync(cli, ['status', '--workdir', work, '-o', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
)
for (const key of ['API_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY'])
  if (!status[key]) throw Error(`Local Supabase did not return ${key}`)
const env = {
  NEXT_PUBLIC_APP_URL: `http://localhost:${port}`,
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
}
writeFileSync(
  target,
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n',
  { mode: 0o600, flag: 'wx' },
)
console.log(
  `Created private .env.local. Start Billr: npm run dev -- --port ${port} --hostname 127.0.0.1`,
)
console.log(
  `Database project: ${project}. Stop without deleting data: supabase stop --workdir .self-host/${project}`,
)
console.log(
  'Local development only: do not expose this CLI stack or its development credentials to the internet. Production instructions: ../docs/self-hosting.md',
)
