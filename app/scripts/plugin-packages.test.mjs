import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const json = (path) => JSON.parse(read(path))
const endpoint = new URL(json('plugins/codex/billr/mcp.json').mcpServers.billr.url)
const packages = ['plugins/claude-code/billr', 'plugins/codex/billr', 'plugins/cursor', 'plugins/openclaw/billr']

test('all shipped MCP configurations use the same public HTTPS OAuth endpoint', () => {
  assert.equal(endpoint.protocol, 'https:')
  assert.equal(endpoint.username, '')
  assert.equal(endpoint.password, '')
  assert.equal(endpoint.search, '')
  assert.notEqual(endpoint.hostname, 'localhost')
  for (const file of ['plugins/claude-code/billr/.mcp.json', 'plugins/codex/billr/.mcp.json', 'plugins/codex/billr/mcp.json', 'plugins/cursor/mcp.json']) {
    const servers = json(file).mcpServers
    assert.deepEqual(Object.keys(servers), ['billr'])
    assert.equal(new URL(servers.billr.url).href, endpoint.href, file)
    assert.equal(servers.billr.headers, undefined, `${file} must not embed credentials`)
  }
  const codex = read('plugins/codex/codex-config.toml').split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
  assert(codex.includes(`url = "${endpoint.origin}"`))
  assert(read('plugins/openclaw/README.md').includes(endpoint.origin))
  assert(read('plugins/shared/skill/SKILL.md').includes(endpoint.origin))
})

test('marketplaces resolve to packaged manifests with matching release versions', () => {
  for (const [file, base, manifest] of [
    ['.claude-plugin/marketplace.json', '', '.claude-plugin/plugin.json'],
    ['plugins/claude-code/.claude-plugin/marketplace.json', 'plugins/claude-code', '.claude-plugin/plugin.json'],
    ['.cursor-plugin/marketplace.json', '', '.cursor-plugin/plugin.json'],
  ]) {
    for (const entry of json(file).plugins) {
      assert.equal(typeof entry.source, 'string')
      const plugin = json(`${base}/${entry.source}/${manifest}`.replace(/^\//, ''))
      assert.equal(plugin.name, entry.name)
      assert.equal(plugin.version, entry.version)
    }
  }
  const codex = json('plugins/codex/billr/.codex-plugin/plugin.json')
  assert.equal(codex.version, json('plugins/codex/billr/plugin.json').version)
  assert.equal(codex.version, json('plugins/cursor/.cursor-plugin/plugin.json').version)
})

test('standalone packages include instructions, licenses and only safe files', () => {
  for (const directory of packages) {
    for (const name of ['README.md', 'LICENSE', 'NOTICE']) assert(existsSync(resolve(root, directory, name)), `${directory}/${name}`)
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        assert(!['.env', '.env.local', '.app.json', '.git', 'node_modules', '.agents', 'hooks.json'].includes(name), `private or unsupported package entry: ${name}`)
        const path = resolve(dir, name)
        assert(!lstatSync(path).isSymbolicLink(), 'packages must be self-contained')
        if (lstatSync(path).isDirectory()) walk(path)
      }
    }
    walk(resolve(root, directory))
  }
})

test('listing assets and component paths resolve inside each package', () => {
  for (const [directory, manifest] of [
    ['plugins/codex/billr', '.codex-plugin/plugin.json'],
    ['plugins/cursor', '.cursor-plugin/plugin.json'],
  ]) {
    const data = json(`${directory}/${manifest}`)
    assert.equal(data.apps, undefined)
    assert.equal(data.hooks, undefined)
    for (const path of [data.skills, data.mcpServers, data.logo, data.interface?.logo, data.interface?.composerIcon].filter(Boolean)) {
      assert(!path.includes('..') && !path.startsWith('/'))
      assert(existsSync(resolve(root, directory, path)), `${directory}: ${path}`)
    }
  }
})
