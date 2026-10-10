import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'

type ServiceDb = ReturnType<typeof createServiceClient>

/** BILLR_OPEN_SIGNUP=true keeps sign-up open after the first account. */
export function openSignup(env: Record<string, string | undefined> = process.env): boolean {
  return env.BILLR_OPEN_SIGNUP?.trim().toLowerCase() === 'true'
}

/**
 * Before creating an account: open when the override is on or nobody has
 * signed up yet. Fails closed: if the database cannot answer, nobody new
 * gets in.
 */
export async function signupIsOpen(db: ServiceDb = createServiceClient()): Promise<boolean> {
  if (openSignup()) return true
  const { data, error } = await db.rpc('install_has_account')
  if (error) {
    console.error('signupIsOpen: could not read install accounts', error.message)
    return false
  }
  return data === false
}

/**
 * After authentication: may this account use the installation? Records the
 * first account as the owner. TRUE admitted, FALSE refused, NULL when Supabase
 * returned a placeholder user for an address that already exists.
 *
 * Throws when the database cannot answer, so callers refuse the session but
 * can tell the person to try again rather than that sign-up is closed.
 */
export async function admitAccount(
  userId: string,
  db: ServiceDb = createServiceClient(),
): Promise<boolean | null> {
  const { data, error } = await db.rpc('admit_install_account', {
    p_user_id: userId,
    p_open: openSignup(),
  })
  if (error) {
    console.error('admitAccount: could not decide', error.message)
    throw new Error('admitAccount: could not check access')
  }
  return data
}
