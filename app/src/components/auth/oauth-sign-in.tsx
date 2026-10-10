'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  OAUTH_PROVIDERS,
  fetchEnabledOAuthProviders,
  startOAuthSignIn,
  type OAuthProviderId,
} from '@/lib/auth/oauth-providers'

/**
 * GitHub's mark from Octicons (MIT), inline so it follows the text colour.
 * Google gets a neutral in-house glyph.
 */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor" className="h-4 w-4">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  )
}

function ProviderMark({ provider }: { provider: OAuthProviderId }) {
  if (provider === 'github') return <GitHubMark />
  return (
    <Image
      src="/auth/google.svg"
      alt=""
      width={16}
      height={16}
      className="h-4 w-4"
    />
  )
}

/**
 * Social sign-in buttons.
 *
 * Supabase publishes provider availability, so each button appears only once
 * its provider is configured and no redeployment is needed to turn one on.
 * With none configured this collapses to spacing and the email form below is
 * the only way in.
 */
export function OAuthSignIn({ next = '/dashboard' }: { next?: string }) {
  const [providers, setProviders] = useState<OAuthProviderId[]>([])
  const [busy, setBusy] = useState<OAuthProviderId | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetchEnabledOAuthProviders().then((enabled) => {
      if (active) setProviders(enabled)
    })
    return () => {
      active = false
    }
  }, [])

  async function signIn(provider: OAuthProviderId) {
    setBusy(provider)
    setError('')
    try {
      window.location.assign(
        await startOAuthSignIn(provider, next, window.location.origin),
      )
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : `Could not connect to ${OAUTH_PROVIDERS[provider].label}. Please try again.`,
      )
      setBusy(null)
    }
  }

  return (
    <div className="mt-7">
      {providers.length > 0 && (
        <>
          <div className="space-y-3">
            {providers.map((provider) => (
              <Button
                key={provider}
                type="button"
                variant="outline"
                className="h-11 w-full gap-2.5 bg-white"
                onClick={() => signIn(provider)}
                disabled={busy !== null}
              >
                {busy === provider ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ProviderMark provider={provider} />
                )}
                {busy === provider
                  ? `Connecting to ${OAUTH_PROVIDERS[provider].label}…`
                  : `Continue with ${OAUTH_PROVIDERS[provider].label}`}
              </Button>
            ))}
          </div>
          {error && (
            <p
              role="alert"
              className="mt-3 text-sm leading-relaxed text-destructive"
            >
              {error}
            </p>
          )}
          <div className="my-6 flex items-center gap-4 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or continue with email
            <span className="h-px flex-1 bg-border" />
          </div>
        </>
      )}
    </div>
  )
}
