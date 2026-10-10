import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Billr is self-hosted software. This scan keeps everything that
// belongs to a hosted service, and every private trace, out of the repository.
const root = fileURLToPath(new URL('../../', import.meta.url))
const SELF = 'app/scripts/repo-clean.test.mjs'
const BINARY = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|pdf)$/i
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '.self-host', 'dist', 'coverage', '.temp', '.branches'])

function repositoryFiles() {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
  } catch {
    // No Git (a downloaded archive): walk the tree instead.
    const files = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name) || /^\.env/.test(name) && name !== '.env.example') continue
        const path = resolve(dir, name)
        if (lstatSync(path).isDirectory()) walk(path)
        else files.push(relative(root, path))
      }
    }
    walk(root)
    return files
  }
}

const files = repositoryFiles().filter((file) => file !== SELF && existsSync(resolve(root, file)))

const CONTENT_RULES = [
  ['edition switch', /isBillrHosted|BILLR_EDITION/],
  ['hosted plans', /\bplan_status\b|trial_ends_at|start_hosted_trial|billing_events|billing_state|STRIPE_BILLING|\bpaywall\b|free trial|trial notice/i],
  ['billr.cc outside the README', /billr\.cc/, ['README.md']],
  ['hosted analytics or error tracking', /@sentry\/|SENTRY_|posthog|googletagmanager|@vercel\/analytics|signup_attribution/i],
  ['personal home path', /\/(?:Users|home)\/[^/\s]+\//],
  ['planning material', /agent-work|superpowers|\.agents\/|\borcha\b|\.playwright-mcp/i],
  ['payment platform', /STRIPE_CONNECT|application_fee|PLATFORM_FEE|stripe_account_id|stripe_connected|stripe_payments_enabled|deauthorize|stripe_checkout_session_id/],
  ['support desk', /turnstile|support_request|SUPPORT_EMAIL|help@/i],
  ['terms gate', /accept-terms|acceptedTerms|terms_version|privacy_version/i],
  ['plugin directory challenge', /openai-apps-challenge|OPENAI_APPS_CHALLENGE/],
  ['payments sandbox', /sandbox_test_payments|billr_sandbox/],
  ['em dash', /\u2014/],
  ['Stripe secret', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['Billr credential', /\bbillr_(?:sk|at)_[0-9a-f]{40,}\b/],
  ['Supabase JWT', /eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
]

const PATH_RULES = [
  /(^|\/)\(marketing\)\//,
  /(^|\/)(components|lib)\/(billing|support|analytics|observability|marketing|blog|guides|seo|content)\//,
  /accept-terms|\/legal\/|openai-apps-challenge|sentry/i,
  /(^|\/)(AGENTS|CLAUDE|PUBLICATION|IMPLEMENTATION|HANDOFF|PLAN|NOTES|TODO)\.md$/,
  /(^|\/)(\.agents|docs\/superpowers|docs\/agent-work|distribution)\//,
  /release-manifest\.json$|(^|\/)supabase\/\.temp\//,
]

test('no hosted, private or credential content in any file', () => {
  const issues = []
  for (const file of files) {
    if (BINARY.test(file)) continue
    const text = readFileSync(resolve(root, file), 'utf8')
    for (const [label, pattern, exempt] of CONTENT_RULES)
      if (!exempt?.includes(file) && pattern.test(text)) issues.push(`${file}: ${label}`)
  }
  assert.deepEqual(issues, [])
})

test('no file lives at a hosted or private path', () => {
  assert.deepEqual(files.filter((file) => PATH_RULES.some((rule) => rule.test(file))), [])
})

test('the README mentions billr.cc exactly once, as the hosted version', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
  const lines = readme.split('\n').filter((line) => line.includes('billr.cc'))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /Prefer not to run it yourself\? \[billr\.cc\]\(https:\/\/billr\.cc\) is the hosted version of Billr\./)
})

test('the README states the generated tool count', () => {
  const reference = readFileSync(resolve(root, 'plugins/shared/skill/references/tools.md'), 'utf8')
  const count = (reference.match(/^### `/gm) || []).length
  const claimed = readFileSync(resolve(root, 'README.md'), 'utf8').match(/\*\*(\d+) tools\*\*/)
  assert(claimed, 'README.md does not state a tool count')
  assert.equal(Number(claimed[1]), count)
})

test('the repository has the files a reader looks for first', () => {
  for (const file of [
    'LICENSE', 'NOTICE', 'README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'SUPPORT.md',
    'CHANGELOG.md', '.gitignore', '.editorconfig', '.nvmrc', '.github/workflows/ci.yml', '.github/dependabot.yml',
    '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml',
    '.github/ISSUE_TEMPLATE/config.yml', '.github/PULL_REQUEST_TEMPLATE.md', '.github/CODEOWNERS',
    '.claude-plugin/marketplace.json', 'docs/self-hosting.md', 'docs/fresh-machine-test.md',
    'docs/images/dashboard.png', 'docs/images/wordmark.png', 'app/Dockerfile', 'app/compose.yaml',
    'app/.env.example', 'app/supabase/migrations/00001_baseline.sql', 'plugins/README.md',
  ])
    assert.ok(existsSync(resolve(root, file)), `missing ${file}`)
})
