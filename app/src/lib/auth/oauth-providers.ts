import { createClient } from '@/lib/supabase/client'
import { safeAuthRedirect } from '@/lib/auth/redirect'

/** The social providers Billr knows how to start a sign-in with. */
export type OAuthProviderId = 'github' | 'google'

type OAuthProviderConfig = {
  /** Name shown on the button and in any error message. */
  label: string
  /**
   * Scopes to request. Left unset means the Supabase provider default, which
   * is what GitHub sign-in has always used (authentication only, no repos).
   */
  scopes?: string
}

export const OAUTH_PROVIDERS: Record<OAuthProviderId, OAuthProviderConfig> = {
  github: { label: 'GitHub' },
  // Google needs an identity, nothing else. These are also Supabase's
  // defaults, spelled out here so a provider-level change cannot widen them.
  google: { label: 'Google', scopes: 'email profile' },
}

export const OAUTH_PROVIDER_IDS = Object.keys(
  OAUTH_PROVIDERS,
) as OAuthProviderId[]

/**
 * Providers the Supabase project currently has configured.
 *
 * Supabase publishes this at `/auth/v1/settings`, so availability is read at
 * runtime and enabling a provider needs no redeployment. An unreachable or
 * unreadable settings document means "offer none of them" and the email form
 * below the buttons stays the way in.
 */
export async function fetchEnabledOAuthProviders(): Promise<OAuthProviderId[]> {
  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`,
      { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! } },
    )
    if (!response.ok) return []
    const settings: { external?: Record<string, boolean> } =
      await response.json()
    return OAUTH_PROVIDER_IDS.filter(
      (provider) => settings.external?.[provider] === true,
    )
  } catch {
    return []
  }
}

/**
 * Start the PKCE flow and return the provider URL to send the browser to.
 *
 * The return trip lands on `/api/auth/callback`, which is provider-agnostic:
 * it exchanges the code, then routes brand-new accounts through the agreement
 * step. `origin` is a parameter so this stays testable outside a browser.
 */
export async function startOAuthSignIn(
  provider: OAuthProviderId,
  next: string,
  origin: string,
): Promise<string> {
  const { label, scopes } = OAUTH_PROVIDERS[provider]
  const callback = new URL('/api/auth/callback', origin)
  callback.searchParams.set('next', safeAuthRedirect(next))
  const { data, error } = await createClient().auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: callback.toString(),
      skipBrowserRedirect: true,
      ...(scopes ? { scopes } : {}),
    },
  })
  if (error || !data?.url)
    throw new Error(`Could not start ${label} sign-in. Please try again.`)
  return data.url
}
