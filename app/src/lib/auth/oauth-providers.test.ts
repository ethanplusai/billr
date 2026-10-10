import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { signInWithOAuth } = vi.hoisted(() => ({ signInWithOAuth: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: vi.fn(() => ({ auth: { signInWithOAuth } })),
}))

import {
  OAUTH_PROVIDER_IDS,
  fetchEnabledOAuthProviders,
  startOAuthSignIn,
} from './oauth-providers'

/** A Supabase `/auth/v1/settings` response with the given providers live. */
function settings(external: Record<string, boolean>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ external }) })),
  )
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key')
  signInWithOAuth.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('provider availability', () => {
  it('offers both buttons when GitHub and Google are configured', async () => {
    settings({ github: true, google: true, email: true })
    expect(await fetchEnabledOAuthProviders()).toEqual(['github', 'google'])
  })

  it('offers only Google when GitHub is turned off', async () => {
    settings({ github: false, google: true })
    expect(await fetchEnabledOAuthProviders()).toEqual(['google'])
  })

  it('offers only GitHub when Google is turned off', async () => {
    settings({ github: true, google: false })
    expect(await fetchEnabledOAuthProviders()).toEqual(['github'])
  })

  it('offers nothing when no social provider is configured', async () => {
    settings({ email: true })
    expect(await fetchEnabledOAuthProviders()).toEqual([])
  })

  it('ignores providers Billr does not implement', async () => {
    settings({ google: true, gitlab: true, azure: true })
    expect(await fetchEnabledOAuthProviders()).toEqual(['google'])
  })

  it('reads availability from the Supabase settings document', async () => {
    settings({ google: true })
    await fetchEnabledOAuthProviders()
    expect(fetch).toHaveBeenCalledWith(
      'https://project.supabase.co/auth/v1/settings',
      { headers: { apikey: 'anon-key' } },
    )
  })

  it('offers nothing when the settings document is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    expect(await fetchEnabledOAuthProviders()).toEqual([])
  })

  it('offers nothing when Supabase is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await fetchEnabledOAuthProviders()).toEqual([])
  })

  it('knows exactly the two providers the buttons render', () => {
    expect(OAUTH_PROVIDER_IDS).toEqual(['github', 'google'])
  })
})

describe('starting a sign-in', () => {
  it('sends GitHub through the app callback with the requested destination', async () => {
    signInWithOAuth.mockResolvedValue({
      data: { url: 'https://github.com/login/oauth/authorize?x=1' },
      error: null,
    })
    const url = await startOAuthSignIn('github', '/agents', 'https://invoices.example.org')
    expect(url).toBe('https://github.com/login/oauth/authorize?x=1')
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: 'github',
      options: {
        redirectTo: 'https://invoices.example.org/api/auth/callback?next=%2Fagents',
        skipBrowserRedirect: true,
      },
    })
  })

  it('asks Google for an identity only', async () => {
    signInWithOAuth.mockResolvedValue({
      data: { url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' },
      error: null,
    })
    await startOAuthSignIn('google', '/dashboard', 'https://invoices.example.org')
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: 'https://invoices.example.org/api/auth/callback?next=%2Fdashboard',
        skipBrowserRedirect: true,
        scopes: 'email profile',
      },
    })
  })

  it('refuses to carry an off-site destination through the provider', async () => {
    signInWithOAuth.mockResolvedValue({ data: { url: 'https://provider.example' }, error: null })
    await startOAuthSignIn('google', '//evil.example', 'https://invoices.example.org')
    expect(signInWithOAuth.mock.calls[0][0].options.redirectTo).toBe(
      'https://invoices.example.org/api/auth/callback?next=%2Fdashboard',
    )
  })

  it('names the provider when the flow cannot be started', async () => {
    signInWithOAuth.mockResolvedValue({ data: { url: null }, error: null })
    await expect(
      startOAuthSignIn('google', '/dashboard', 'https://invoices.example.org'),
    ).rejects.toThrow('Could not start Google sign-in. Please try again.')
  })

  it('surfaces a provider error as a retryable message', async () => {
    signInWithOAuth.mockResolvedValue({ data: null, error: new Error('provider down') })
    await expect(
      startOAuthSignIn('github', '/dashboard', 'https://invoices.example.org'),
    ).rejects.toThrow('Could not start GitHub sign-in. Please try again.')
  })
})
