/** Preserve measured seconds; round money only after applying the agreed rate. */
export function secondsFromHours(hours: number): number {
  const seconds = Math.round(hours * 3600)
  if (!Number.isFinite(hours) || seconds < 1 || seconds > 86400) {
    throw new Error('Time must be between one second and 24 hours')
  }
  return seconds
}

export function timeAmount(
  seconds: number,
  rate: number | null
): number | null {
  if (!Number.isSafeInteger(seconds) || seconds < 0)
    throw new Error('Duration must be whole nonnegative seconds')
  if (rate === null) return null
  if (!Number.isFinite(rate) || rate < 0)
    throw new Error('Rate must be nonnegative')
  return Math.round(((seconds * rate) / 3600 + Number.EPSILON) * 100) / 100
}

export function entrySeconds(entry: {
  duration_seconds?: number | null
  duration_minutes?: number | null
}): number {
  return entry.duration_seconds ?? (entry.duration_minutes ?? 0) * 60
}
