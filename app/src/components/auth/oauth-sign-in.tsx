'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { Github, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  OAUTH_PROVIDERS,
  fetchEnabledOAuthProviders,
  startOAuthSignIn,
  type OAuthProviderId,
} from '@/lib/auth/oauth-providers'

/** GitHub ships with the icon set; Google gets a neutral in-house glyph. */
function ProviderMark({ provider }: { provider: OAuthProviderId }) {
  if (provider === 'github') return <Github className="h-4 w-4" />
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
