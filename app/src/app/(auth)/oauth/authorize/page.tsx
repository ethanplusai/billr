import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { appOrigin, mcpUrl } from '@/lib/deployment'
import { safeAuthRedirect } from '@/lib/auth/redirect'
import { createClient } from '@/lib/supabase/server'
import {
  buildRedirect,
  isValidCodeChallenge,
  matchesRegisteredRedirect,
  resourceMatches,
} from '@/lib/oauth/params'
import { requestedPermissions } from '@/lib/oauth/scopes'
import { findClientByClientId } from '@/lib/oauth/store'
import { ConsentForm } from './consent-form'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Authorize access',
  robots: { index: false, follow: false },
}

type SearchParams = Record<string, string | string[] | undefined>

function first(params: SearchParams, key: string): string {
  const value = params[key]
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

/** Rebuilds this request's own URL so sign-in can return to it intact. */
function currentPath(params: SearchParams): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') query.set(key, value)
    else if (Array.isArray(value) && value[0] != null) query.set(key, value[0])
  }
  const search = query.toString()
  return search ? `/oauth/authorize?${search}` : '/oauth/authorize'
}

function Problem({ title, detail }: { title: string; detail: string }) {
  return (
    <div>
      <h1 className="text-xl font-bold tracking-tight text-foreground">{title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{detail}</p>
      <p className="mt-6 text-sm">
        <Link href="/agents" className="font-medium text-primary hover:underline">
          Go to your Billr agents settings
        </Link>
      </p>
    </div>
  )
}

/**
 * OAuth 2.1 authorization endpoint (the consent screen).
 *
 * Order matters here. The client and its redirect URI are checked FIRST,
 * against the registration, and a failure renders on this page rather than
 * redirecting: bouncing an error to an address the client never registered is
 * how an authorization endpoint becomes an open redirector. Only once the
 * redirect URI is known to be trustworthy do protocol errors go back to the
 * client the way RFC 6749 asks.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const clientId = first(params, 'client_id')
  const redirectUri = first(params, 'redirect_uri')
  const state = first(params, 'state')
  const resource = first(params, 'resource')

  if (!clientId || !redirectUri) {
    return (
      <Problem
        title="Incomplete request"
        detail="This connection request is missing the application id or its return address, so Billr cannot tell who is asking. Start the connection again from the application."
      />
    )
  }

  const client = await findClientByClientId(clientId)
  if (!client) {
    return (
      <Problem
        title="Unknown application"
        detail="No application is registered with Billr under that client id. Start the connection again from the application, which will register itself first."
      />
    )
  }
  if (!matchesRegisteredRedirect(redirectUri, client.redirect_uris)) {
    return (
      <Problem
        title="Return address does not match"
        detail="This application asked to be sent back to an address it never registered. That is exactly the shape of a stolen-code attack, so Billr stopped here."
      />
    )
  }

  // From here the redirect URI is trusted, so protocol errors travel back to
  // the client instead of dead-ending on a page nobody is watching.
  const fail = (error: string, description: string) =>
    redirect(
      buildRedirect(redirectUri, {
        error,
        error_description: description,
        state,
        iss: appOrigin(),
      })
    )

  if (first(params, 'response_type') !== 'code') {
    fail('unsupported_response_type', 'Only the authorization code flow is supported')
  }
  const codeChallenge = first(params, 'code_challenge')
  const method = first(params, 'code_challenge_method')
  if (!codeChallenge || !isValidCodeChallenge(codeChallenge)) {
    fail('invalid_request', 'A base64url S256 code_challenge is required')
  }
  if (method !== 'S256') {
    fail('invalid_request', 'code_challenge_method must be S256')
  }
  if (!resourceMatches(resource, mcpUrl())) {
    fail('invalid_target', 'Unknown resource')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const returnTo = safeAuthRedirect(currentPath(params))
  if (!user) {
    redirect(`/login?redirect=${encodeURIComponent(returnTo)}`)
  }

  const { data: memberships } = await supabase
    .from('business_members')
    .select('business_id')
    .eq('user_id', user.id)

  const businessIds = (memberships ?? []).map((row) => row.business_id)
  const { data: businesses } = businessIds.length
    ? await supabase
        .from('businesses')
        .select('id, name')
        .in('id', businessIds)
        .eq('is_active', true)
        .order('name')
    : { data: [] as { id: string; name: string }[] }

  if (!businesses || businesses.length === 0) {
    return (
      <Problem
        title="Create a business first"
        detail="An agent connection is granted to one business, and this account does not have one yet. Set one up, then start the connection again."
      />
    )
  }

  return (
    <ConsentForm
      clientName={client.client_name}
      clientId={clientId}
      redirectUri={redirectUri}
      codeChallenge={codeChallenge}
      state={state}
      resource={resource}
      resourceLabel={mcpUrl()}
      businesses={businesses}
      preselected={requestedPermissions(first(params, 'scope'))}
    />
  )
}
