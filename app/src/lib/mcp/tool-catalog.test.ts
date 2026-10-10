import { registerTaskTools } from './tools/tasks'
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOOL_NAMES, TOOL_GROUPS, TOOL_COUNT } from './tool-catalog'

const TOOLS_DIR = join(process.cwd(), 'src/lib/mcp/tools')

function toolFiles(): string[] {
  return readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
}

function sourceOf(file: string): string {
  return readFileSync(join(TOOLS_DIR, file), 'utf8')
}

function registeredToolNames(): string[] {
  const names: string[] = []
  registerTaskTools({registerTool:(name:string)=>{names.push(name)}} as never, {} as never)
  for (const file of toolFiles().filter(f=>f!=='tasks.ts')) {
    for (const match of sourceOf(file).matchAll(/registerTool\(\s*'([a-z_]+)'/g)) {
      names.push(match[1])
    }
  }
  return names
}

describe('tool catalog', () => {
  it('advertises exactly the tools the server registers', () => {
    expect([...TOOL_NAMES].sort()).toEqual([...registeredToolNames()].sort())
  })

  it('advertises every tool exactly once', () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length)
  })

  it('keeps the published count derived from the list rather than hardcoded', () => {
    expect(TOOL_COUNT).toBe(registeredToolNames().length)
  })

  it('gives every group a name, a blurb, and at least one tool', () => {
    for (const group of TOOL_GROUPS) {
      expect(group.name.length).toBeGreaterThan(0)
      expect(group.blurb.length).toBeGreaterThan(0)
      expect(group.tools.length).toBeGreaterThan(0)
    }
  })

  it('uses no em-dashes in copy shown to users', () => {
    for (const group of TOOL_GROUPS) {
      expect(group.name).not.toContain('\u2014')
      expect(group.blurb).not.toContain('\u2014')
    }
  })
})

describe('ScopedDb discipline', () => {
  it('never lets a tool file build its own Supabase client', () => {
    for (const file of toolFiles()) {
      const src = sourceOf(file)
      expect(src, `${file} must not import a Supabase client directly`).not.toMatch(
        /from '@\/lib\/supabase\/(service|server|client)'/
      )
      expect(src, `${file} must not call createServiceClient`).not.toContain('createServiceClient(')
    }
  })

  it('routes every data access in a tool file through ctx.db', () => {
    for (const file of toolFiles()) {
      const src = sourceOf(file)
      // Collapse whitespace so a multi-line chain reads as one expression, and
      // match .from('table') specifically so Array.from(...) is not counted.
      const collapsed = src.replace(/\s+/g, '')
      const dataAccesses = collapsed.match(/\.from\('/g) ?? []
      const scopedAccesses = collapsed.match(/ctx\.db\.svc\.from\('/g) ?? []
      expect(dataAccesses.length, `${file} has a .from( that is not ctx.db.svc.from(`).toBe(
        scopedAccesses.length
      )
    }
  })

  it('has every tool file establish scope before querying', () => {
    for (const file of toolFiles()) {
      const src = sourceOf(file)
      if (!src.includes('ctx.db.svc.from(')) continue
      expect(
        /resolveBusinessId|assertClientAccess|assertInvoiceAccess|assertEstimateAccess|assertTimeEntryAccess|assertExpenseAccess/.test(
          src
        ),
        `${file} queries the database without any assert*/resolveBusinessId scoping call`
      ).toBe(true)
    }
  })
})

/**
 * Walks a TypeScript source file and returns every string literal in it: single
 * and double quoted strings, plus the literal chunks of template literals with
 * their `${...}` interpolations skipped. Line and block comments are ignored,
 * so prose written for maintainers is never mistaken for user-facing copy.
 */
function stringLiterals(src: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = []
  // A stack of frames: template literals can nest inside `${}` interpolations,
  // which are themselves code that can open further template literals.
  const stack: { kind: 'code' | 'template'; depth: number }[] = [{ kind: 'code', depth: 0 }]
  let i = 0
  let line = 1
  let buf = ''
  let bufLine = 1

  const flush = () => {
    if (buf) out.push({ line: bufLine, text: buf })
    buf = ''
  }

  while (i < src.length) {
    const frame = stack[stack.length - 1]
    const c = src[i]
    const n = src[i + 1]
    if (c === '\n') line++

    if (frame.kind === 'template') {
      if (c === '\\') {
        buf += n ?? ''
        i += 2
        continue
      }
      if (c === '`') {
        flush()
        stack.pop()
        i++
        continue
      }
      if (c === '$' && n === '{') {
        flush()
        stack.push({ kind: 'code', depth: 1 })
        i += 2
        continue
      }
      if (!buf) bufLine = line
      buf += c
      i++
      continue
    }

    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && n === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++
        i++
      }
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      const quote = c
      const startLine = line
      let text = ''
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          text += src[i + 1] ?? ''
          i += 2
          continue
        }
        if (src[i] === '\n') line++
        text += src[i]
        i++
      }
      i++
      out.push({ line: startLine, text })
      continue
    }
    if (c === '`') {
      stack.push({ kind: 'template', depth: 0 })
      bufLine = line
      i++
      continue
    }
    if (c === '{') {
      frame.depth++
      i++
      continue
    }
    if (c === '}') {
      frame.depth--
      i++
      // depth 0 on a non-root frame means we just closed a `${...}`.
      if (frame.depth === 0 && stack.length > 1) stack.pop()
      continue
    }
    i++
  }
  flush()
  return out
}

describe('user-facing copy', () => {
  // Em-dash (U+2014) and en-dash (U+2013) are banned from anything an end user
  // can see. Tool descriptions, parameter descriptions, error messages and
  // result summaries are all relayed verbatim to the user by the calling agent,
  // so every string literal in a tool module counts as user-facing copy.
  const BANNED_DASH = /[\u2013\u2014]/

  it('uses no em-dashes or en-dashes in any tool module string', () => {
    const offenders: string[] = []
    for (const file of toolFiles()) {
      for (const { line, text } of stringLiterals(sourceOf(file))) {
        if (BANNED_DASH.test(text)) {
          offenders.push(
            `src/lib/mcp/tools/${file}:${line} contains a banned dash: ${JSON.stringify(text)}`
          )
        }
      }
    }
    expect(
      offenders,
      [
        'Banned em-dash (U+2014) or en-dash (U+2013) found in user-facing copy.',
        'Rewrite each string so it reads naturally without the dash, usually as a',
        'full stop and a new sentence, keeping any recovery instruction intact:',
        ...offenders,
      ].join('\n')
    ).toEqual([])
  })
})
