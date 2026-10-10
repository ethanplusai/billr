import { describe, it, expect } from 'vitest'
import {
  connectClients,
  CONSENT_SUMMARY,
  FIRST_PROMPT,
  type ConnectStep,
} from './connect-instructions'

const URL = 'https://mcp.example.test/api/mcp'
const clients = connectClients(URL)

function allSteps(): ConnectStep[] {
  return clients.flatMap((c) => [...c.steps, ...(c.fallback?.steps ?? [])])
}

function everyString(): string[] {
  const out: string[] = [CONSENT_SUMMARY, FIRST_PROMPT]
  for (const client of clients) {
    out.push(client.name, client.title, client.requirements, client.verify)
    if (client.source) out.push(client.source)
    if (client.fallback) out.push(client.fallback.summary, client.fallback.detail)
  }
  for (const step of allSteps()) {
    out.push(step.title)
    if (step.detail) out.push(step.detail)
    if (step.code) out.push(step.code.label, step.code.text)
  }
  return out
}

describe('connect instructions', () => {
  it('covers every client the Connect panel advertises', () => {
    expect(clients.map((c) => c.id)).toEqual([
      'claude',
      'claude-code',
      'codex',
      'cursor',
      'chatgpt',
      'other',
    ])
  })

  it('gives every client three to six numbered steps and a verify line', () => {
    for (const client of clients) {
      expect(client.steps.length, client.id).toBeGreaterThanOrEqual(3)
      expect(client.steps.length, client.id).toBeLessThanOrEqual(6)
      expect(client.requirements.trim(), client.id).not.toBe('')
      expect(client.verify, client.id).toContain(FIRST_PROMPT)
      for (const step of client.steps) {
        expect(step.title.trim(), `${client.id}: step title`).not.toBe('')
      }
    }
  })

  it('shows the MCP URL to every client and never a different server URL', () => {
    for (const client of clients) {
      const blocks = [...client.steps, ...(client.fallback?.steps ?? [])]
        .map((s) => s.code?.text)
        .filter((text): text is string => !!text)
      expect(blocks.length, client.id).toBeGreaterThan(0)
      expect(blocks.some((text) => text.includes(URL)), client.id).toBe(true)
      for (const text of blocks) {
        for (const found of text.match(/https?:\/\/[^\s"']+/g) ?? []) {
          expect(found, client.id).toBe(URL)
        }
      }
    }
  })

  it('offers the API key fallback only where a client cannot sign in', () => {
    const withFallback = clients.filter((c) => c.fallback).map((c) => c.id)
    expect(withFallback).toEqual(['claude-code', 'codex', 'cursor', 'other'])
    for (const client of clients) {
      if (!client.fallback) continue
      expect(client.fallback.summary, client.id).toBe('Use an API key instead')
      expect(client.fallback.steps.length, client.id).toBeGreaterThan(0)
    }
  })

  it('labels every copyable block', () => {
    for (const step of allSteps()) {
      if (!step.code) continue
      expect(step.code.label.trim()).not.toBe('')
      expect(step.code.text.trim()).not.toBe('')
    }
  })

  it('records the vendor page each set of steps was read from', () => {
    for (const client of clients) {
      if (client.id === 'other') continue
      expect(client.source, client.id).toMatch(/^https:\/\//)
      expect(client.verifiedOn, client.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('uses no em-dashes or en-dashes anywhere', () => {
    for (const value of everyString()) {
      expect(value).not.toMatch(/[\u2013\u2014]/)
    }
  })
})
