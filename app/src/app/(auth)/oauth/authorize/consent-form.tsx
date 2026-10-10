'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  CONSENT_CHOICES,
  CONSENT_FOOTNOTE,
  type OauthScope,
} from '@/lib/oauth/scopes'
import {
  approveAuthorizationAction,
  denyAuthorizationAction,
} from './actions'

interface BusinessOption {
  id: string
  name: string
}

/**
 * The consent screen.
 *
 * It grants LESS than the application asked for whenever the person says so:
 * the requested scope only pre-ticks boxes. Every claim next to a checkbox is
 * the plain consequence of the permission ("Emails invoices to your clients"),
 * because "write scope" means nothing to the person being asked.
 */
export function ConsentForm({
  clientName,
  clientId,
  redirectUri,
  codeChallenge,
  state,
  resource,
  resourceLabel,
  businesses,
  preselected,
}: {
  clientName: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  state: string
  resource: string
  resourceLabel: string
  businesses: BusinessOption[]
  preselected: OauthScope[]
}) {
  const [businessId, setBusinessId] = useState(businesses[0]?.id ?? '')
  const [granted, setGranted] = useState<OauthScope[]>(preselected)
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)

  function toggle(permission: OauthScope, on: boolean) {
    setGranted((current) =>
      on ? [...new Set([...current, permission])] : current.filter((p) => p !== permission)
    )
  }

  function leave(url: string) {
    // A cross-origin hand-back, so a hard navigation rather than the router.
    window.location.replace(url)
  }

  async function approve() {
    setError(null)
    setBusy('approve')
    try {
      const result = await approveAuthorizationAction({
        clientId,
        redirectUri,
        codeChallenge,
        state,
        resource,
        businessId,
        permissions: granted,
      })
      if ('error' in result) {
        setError(result.error)
        setBusy(null)
        return
      }
      leave(result.redirect)
    } catch {
      setError('Could not complete the connection. Please try again.')
      setBusy(null)
    }
  }

  async function deny() {
    setError(null)
    setBusy('deny')
    try {
      const result = await denyAuthorizationAction({ clientId, redirectUri, state })
      if ('error' in result) {
        setError(result.error)
        setBusy(null)
        return
      }
      leave(result.redirect)
    } catch {
      setError('Could not send your answer back to the application.')
      setBusy(null)
    }
  }

  return (
    <div>
      <h1 className="text-xl font-bold tracking-tight text-foreground">
        Connect {clientName} to Billr
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        {clientName} is asking to use your Billr account through{' '}
        <span className="font-mono text-xs">{resourceLabel}</span>. Choose what it may do. You
        can revoke this at any time in Agents.
      </p>

      {error && (
        <div role="alert" className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mt-6 space-y-2">
        <Label htmlFor="consent-business">Business</Label>
        <select
          id="consent-business"
          className="w-full rounded border bg-background p-2 text-sm"
          value={businessId}
          onChange={(event) => setBusinessId(event.target.value)}
        >
          {businesses.map((business) => (
            <option key={business.id} value={business.id}>
              {business.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          The connection can only see and change this business.
        </p>
      </div>

      <fieldset className="mt-6 space-y-3">
        <legend className="text-sm font-medium text-foreground">Permissions</legend>
        {CONSENT_CHOICES.map((choice) => {
          const checked = choice.fixed || granted.includes(choice.permission)
          return (
            <label
              key={choice.permission}
              className="flex items-start gap-3 rounded-lg border p-3 text-sm"
            >
              <Checkbox
                className="mt-0.5"
                checked={checked}
                disabled={choice.fixed || busy !== null}
                onCheckedChange={(value) => toggle(choice.permission, value === true)}
                aria-label={choice.label}
              />
              <span>
                <span className="font-medium text-foreground">{choice.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {choice.consequence}
                </span>
              </span>
            </label>
          )
        })}
      </fieldset>

      <p className="mt-4 text-xs text-muted-foreground">{CONSENT_FOOTNOTE}</p>

      <div className="mt-6 flex gap-3">
        <Button variant="outline" className="flex-1" onClick={deny} disabled={busy !== null}>
          {busy === 'deny' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Deny
        </Button>
        <Button className="flex-1" onClick={approve} disabled={busy !== null || !businessId}>
          {busy === 'approve' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Allow access
        </Button>
      </div>
    </div>
  )
}
