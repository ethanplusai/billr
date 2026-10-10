// Runs every supabase/tests/*.sql file against a running local Supabase stack,
// inside its database container, so no host psql is needed. Each file opens
// and rolls back its own transaction.
//
//   supabase start          # from app/, the checked-in test stack
//   npm run test:sql
//   npm run test:sql -- --workdir .self-host/billr-local-56421
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const app = fileURLToPath(new URL('../', import.meta.url))

export function projectId(configToml) {
  const match = configToml.match(/^project_id\s*=\s*"([^"]+)"/m)
  if (!match) throw Error('supabase/config.toml has no project_id')
  return match[1]
}

export function containerName(workdir) {
  const config = readFileSync(resolve(workdir, 'supabase/config.toml'), 'utf8')
  return `supabase_db_${projectId(config)}`
}

export function sqlTestFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--workdir')
  const workdir = resolve(app, at >= 0 ? args[at + 1] : '.')
  const container = process.env.BILLR_SQL_CONTAINER || containerName(workdir)
  const dir = resolve(app, 'supabase/tests')
  let failed = 0
  for (const file of sqlTestFiles(dir)) {
    try {
      execFileSync(
        'docker',
        ['exec', '-i', container, 'psql', 'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
          '-v', 'ON_ERROR_STOP=1', '-q', '-X'],
        { input: readFileSync(resolve(dir, file)), stdio: ['pipe', 'pipe', 'pipe'] },
      )
      console.log(`PASS ${file}`)
    } catch (error) {
      failed++
      console.log(`FAIL ${file}`)
      const lines = String(error.stderr || error.message).split('\n')
      console.log(lines.filter((line) => /ERROR|FAILED|No such/.test(line)).slice(0, 5).join('\n'))
    }
  }
  if (failed) process.exitCode = 1
}
