'use server'

import { appOrigin, mcpUrl } from '@/lib/deployment'
import { createClient } from '@/lib/supabase/server'
import {
  buildRedirect,
  isValidCodeChallenge,
  matchesRegisteredRedirect,
  resourceMatches,
} from '@/lib/oauth/params'
import { narrowPermissions } from '@/lib/oauth/scopes'
import { findClientByClientId, issueAuthorizationCode } from '@/lib/oauth/store'

/**
 * Consent decisions.
 *
 * These are server actions, so Next's Origin/Host check covers CSRF and the
 * caller must already hold the session cookie. Everything else that arrives
 * here is attacker-controlled input from a form field, so every parameter is
 * re-validated against the database rather than trusted because the page
 * rendered it: the client must exist, the redirect URI must be one it
 * registered (exact match), the PKCE challenge must be a well-formed S256
 * digest, and the business must be one this user belongs to.
 */

export interface ConsentRequest {
  clientId: string
  redirectUri: string
  codeChallenge: string
  state?: string
  resource?: string
  businessId: string
  permissions: string[]
}

export type ConsentResult = { redirect: string } | { error: string }

interface VerifiedRequest {
  clientRowId: string
  clientName: string
  redirectUri: string
  state?: string
}

async function verifyClient(
  clientId: string,
  redirectUri: string
): Promise<VerifiedRequest | { error: string }> {
  if (!clientId || !redirectUri) return { error: 'This authorization request is incomplete.' }
  const client = await findClientByClientId(clientId)
  if (!client) return { error: 'This application is not registered with Billr.' }
  if (!matchesRegisteredRedirect(redirectUri, client.redirect_uris)) {
    return { error: 'This application asked to be sent to an address it has not registered.' }
  }
  return { clientRowId: client.id, clientName: client.client_name, redirectUri }
}

export async function approveAuthorizationAction(input: ConsentRequest): Promise<ConsentResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Your session expired. Sign in and try connecting again.' }

  const verified = await verifyClient(input.clientId, input.redirectUri)
  if ('error' in verified) return verified

  if (!isValidCodeChallenge(input.codeChallenge)) {
    return { error: 'This application did not send a valid PKCE challenge.' }
  }
  if (!resourceMatches(input.resource, mcpUrl())) {
    return { error: 'This application asked for access to a different service.' }
  }

  // Membership is checked on the caller's own client, so RLS decides, not this
  // function.
  const { data: member } = await supabase
    .from('business_members')
    .select('business_id')
    .eq('user_id', user.id)
    .eq('business_id', input.businessId)
    .maybeSingle()
  if (!member) return { error: 'Choose a business you have access to.' }

  const permissions = narrowPermissions(input.permissions)

  const code = await issueAuthorizationCode({
    clientRowId: verified.clientRowId,
    userId: user.id,
    businessId: input.businessId,
    redirectUri: verified.redirectUri,
    codeChallenge: input.codeChallenge,
    permissions,
    resource: input.resource?.trim() || null,
  })
  if (!code) return { error: 'Could not complete the connection. Please try again.' }

  return {
    redirect: buildRedirect(verified.redirectUri, {
      code,
      state: input.state,
      // RFC 9207. Advertised in the authorization-server metadata, so it must
      // actually be sent.
      iss: appOrigin(),
    }),
  }
}

export async function denyAuthorizationAction(
  input: Pick<ConsentRequest, 'clientId' | 'redirectUri' | 'state'>
): Promise<ConsentResult> {
  const verified = await verifyClient(input.clientId, input.redirectUri)
  if ('error' in verified) return verified
  return {
    redirect: buildRedirect(verified.redirectUri, {
      error: 'access_denied',
      error_description: 'The account holder declined this request.',
      state: input.state,
      iss: appOrigin(),
    }),
  }
}
