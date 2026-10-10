/** Shown wherever a new account is refused. Plain module: client pages import it. */
export const SIGNUP_CLOSED_MESSAGE =
  'Sign-up is closed on this Billr. Ask the person who runs it to let you in.'

/**
 * Shown when the database could not answer whether an account may use this
 * Billr. The account is refused either way, but it is not told sign-up is
 * closed, because that may not be true.
 */
export const ACCESS_CHECK_FAILED_MESSAGE =
  'We could not check access to this install. Try again in a moment.'
