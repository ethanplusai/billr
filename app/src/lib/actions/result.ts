/**
 * What every browser-facing write action returns.
 *
 * These actions are called from client components that already show a toast on
 * failure, so they answer with a value rather than throwing across the server
 * action boundary: a thrown error reaches the browser as an opaque digest and
 * the person is told nothing useful.
 */
export type WriteResult = { ok: true } | { error: string }

/** Narrows an unknown failure to something worth showing a person. */
export function failure(error: unknown, fallback: string): WriteResult {
  return { error: error instanceof Error ? error.message : fallback }
}
