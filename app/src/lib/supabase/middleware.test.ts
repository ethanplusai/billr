import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createServerClientMock } = vi.hoisted(() => ({ createServerClientMock: vi.fn() }))
vi.mock('@supabase/ssr', () => ({ createServerClient: createServerClientMock }))

import { NextRequest } from 'next/server'
import { updateSession } from './middleware'

type Cookie = { name: string; value: string; options?: Record<string, unknown> }

/** Wire the mocked Supabase client to return the given account. */
function mockSession(user: unknown, refreshedCookies: Cookie[] = []) {
  createServerClientMock.mockImplementation(
    (_url: string, _key: string, options: { cookies: { setAll: (c: Cookie[]) => void } }) => {
      if (refreshedCookies.length) options.cookies.setAll(refreshedCookies)
      return { auth: { getUser: async () => ({ data: { user } }) } }
    },
  )
}

function request(path: string) {
  return new NextRequest(new URL(path, 'http://localhost:3000'))
}

beforeEach(() => {
  createServerClientMock.mockReset()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:56421')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'sb_publishable_test')
})

// Environment stubs are per test, so nothing one test sets decides another.
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('updateSession', () => {
  it('sends an anonymous visitor on a workspace page to sign-in, keeping the destination', async () => {
    mockSession(null)
    const response = await updateSession(request('/invoices'))
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?redirect=%2Finvoices',
    )
  })

  it('lets a signed-in user through to a workspace page', async () => {
    mockSession({ id: 'u1' })
    const response = await updateSession(request('/invoices'))
    expect(response.headers.get('location')).toBeNull()
  })

  it('opens the workspace at the root for a signed-in user', async () => {
    mockSession({ id: 'u1' })
    const response = await updateSession(request('/'))
    expect(response.headers.get('location')).toBe('http://localhost:3000/dashboard')
  })

  it('sends an anonymous visitor at the root to sign-in', async () => {
    mockSession(null)
    const response = await updateSession(request('/'))
    expect(response.headers.get('location')).toBe('http://localhost:3000/login')
  })

  it('keeps refreshed auth cookies on the root redirect', async () => {
    mockSession({ id: 'u1' }, [{ name: 'sb-refreshed', value: 'v' }])
    const response = await updateSession(request('/'))
    expect(response.cookies.get('sb-refreshed')?.value).toBe('v')
  })

  it('sends a signed-in user away from sign-in to the requested page', async () => {
    mockSession({ id: 'u1' })
    const response = await updateSession(request('/login?redirect=%2Fclients'))
    expect(response.headers.get('location')).toBe('http://localhost:3000/clients')
  })

  it('leaves a public invoice page alone for an anonymous visitor', async () => {
    mockSession(null)
    const response = await updateSession(request('/i/abc123xyz'))
    expect(response.headers.get('location')).toBeNull()
  })
})
