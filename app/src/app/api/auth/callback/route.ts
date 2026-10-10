import { safeAuthRedirect } from '@/lib/auth/redirect'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { admitAccount } from '@/lib/auth/admission'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = safeAuthRedirect(searchParams.get('next'))

  if (code) {
    try {
      const supabase = await createClient()
      const { error } = await supabase.auth.exchangeCodeForSession(code)
      if (!error) {
        // GitHub and Google create the account before this point, so this is
        // where sign-up closes for them.
        const {
          data: { user },
        } = await supabase.auth.getUser()
        let admitted: boolean | null | 'unavailable'
        try {
          admitted = user ? await admitAccount(user.id) : false
        } catch {
          admitted = 'unavailable'
        }
        if (admitted !== true) {
          await supabase.auth.signOut()
          const reason = admitted === 'unavailable' ? 'access_check' : 'signup_closed'
          return NextResponse.redirect(`${origin}/login?error=${reason}`)
        }
        return NextResponse.redirect(`${origin}${next}`)
      }
    } catch {
      // A provider/network failure should leave the user able to try again.
    }
  }

  return NextResponse.redirect(
    `${origin}/login?error=auth&redirect=${encodeURIComponent(next)}`,
  )
}
