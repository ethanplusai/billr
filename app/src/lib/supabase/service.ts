// SERVER ONLY. Bypasses RLS. Sanctioned callers:
// src/lib/api-keys/resolver.ts and src/lib/mcp/scoped-db.ts (the
// mandatory-scoping data layer; all other API-key-authenticated access,
// including /api/v1/me, must go through ScopedDb).
// src/app/api/stripe/payment-intent/route.ts - the anonymous payer on a public
// invoice page has no session. It reads and writes only the single invoice row
// identified by the invoice's own public_id, never a caller-supplied id, and
// reads that invoice's payment row for its previous PaymentIntent.
// src/app/api/stripe/webhook/route.ts - the Stripe webhook has no user session.
// It writes stripe_events (idempotency ledger), payments and invoices rows
// identified only by Stripe-supplied ids (event metadata, payment_intent id),
// after verifying the request's Stripe signature.
// src/lib/rate-limit.ts - the durable rate-limit counters live in an
// RLS-locked table with no policies, and the limiter must work before any
// session exists (sign-in, sign-up, anonymous public pay links). It calls only
// consume_rate_limit / peek_rate_limit, which take an opaque hashed bucket key
// and return three integers about that key alone.
// src/lib/oauth/store.ts - the OAuth endpoints run with no
// session by construction: /api/oauth/register and /api/oauth/token are called
// by an agent process that has not signed in, and oauth_clients /
// oauth_authorization_codes / oauth_refresh_tokens are RLS-locked with no
// policies because they hold credential material no browser may read. Every
// such query lives in that one module; a signed-in user's view of their own
// connections goes through src/lib/oauth/connections.ts on their own client.
// src/lib/auth/admission.ts - sign-up closes after the first account. The
// install_accounts table and its two functions are service-role only so no
// browser can admit itself; the module calls only install_has_account and
// admit_install_account, each about one user id at most.
// Do not add callers without a review that says why.
import 'server-only'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

export function createServiceClient() {
  return createClient<Database>(
    (process.env.SUPABASE_INTERNAL_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL)!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}
