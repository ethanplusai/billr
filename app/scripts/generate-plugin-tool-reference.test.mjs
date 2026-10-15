import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  checkGenerated,
  generatedFiles,
} from './generate-plugin-tool-reference.mjs'

/**
 * The point of the generator is that no packaged file drifts from the code it
 * describes. That only holds if something fails when somebody edits a
 * generated file by hand, adds an MCP tool, or renames a permission, and does
 * not re-run the generator. This is that something.
 */
test('every generated plugin file on disk is current', () => {
  const stale = checkGenerated()
  assert.deepEqual(
    stale,
    [],
    `Run: node app/scripts/generate-plugin-tool-reference.mjs\n${stale.join('\n')}`,
  )
})

test('the tool reference covers the whole registered tool surface', () => {
  const tools = generatedFiles().get(
    'plugins/shared/skill/references/tools.md',
  )
  assert(tools, 'generator produced no tool reference')
  const contracts = JSON.parse(
    readFileSync(
      new URL('../../packages/agent-kit/src/tool-contracts.json', import.meta.url),
      'utf8',
    ),
  )
  assert(contracts.length > 0)
  for (const tool of contracts)
    assert(
      tools.includes(`### \`${tool.name}\``),
      `${tool.name} is registered but missing from the generated reference`,
    )
  assert(
    tools.includes(`${contracts.length} of them`),
    'the reference quotes a tool count that does not match the contracts',
  )
})

test('generated files carry a do-not-edit stamp and no em-dash', () => {
  for (const [path, contents] of generatedFiles()) {
    assert(
      contents.includes('Do not edit'),
      `${path} is generated but does not say so`,
    )
    assert(!contents.includes('\u2014'), `${path} contains an em-dash`)
  }
})

test('the platform copies all carry the shared skill body', () => {
  const files = generatedFiles()
  const marker = 'Draft, never send.'
  for (const path of [
    'plugins/codex/billr/skills/billr/SKILL.md',
    'plugins/openclaw/billr/SKILL.md',
  ])
    assert(
      files.get(path)?.includes(marker),
      `${path} is out of step with the shared skill`,
    )
})
