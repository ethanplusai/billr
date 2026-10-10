import { scheduleErrorMessage } from './schedule'

/**
 * One vocabulary for every engagement refusal.
 *
 * The engagement RPCs raise stable codes rather than sentences, so
 * that both surfaces that call them (the MCP tools and the app's server
 * actions) turn the same code into the same explanation. Without this the two
 * drift, and a person and an agent end up being told different things about
 * the same rule.
 *
 * Codes the schedule math raises live in schedule.ts next to the math itself
 * and are looked up first.
 */
const ENGAGEMENT_ERRORS: Record<string, string> = {
  engagement_not_found: 'Engagement not found',
  entry_not_found: 'Schedule entry not found',
  client_not_found: 'Client not found',
  estimate_not_found: 'Estimate not found',
  request_id_reused:
    'That request_id was already used for a different engagement write. Use a new request_id.',
  key_cannot_manage_engagements:
    'This API key does not have the write permission, which is required to create or change an engagement.',
  engagement_closed:
    'This engagement is already completed or cancelled, so its status cannot change again.',
  invalid_status_transition: 'An engagement cannot move to that status from the one it is in.',
  invalid_status: 'Pick a status: draft, active, paused, completed, or cancelled.',
  engagement_cancelled: 'This engagement was cancelled, so nothing more can be billed against it.',
  entry_already_invoiced:
    'That entry has already been invoiced. Billed money cannot be changed here: correct it on the invoice instead.',
  entry_waived: 'That entry was already waived.',
  entry_invoiced_immutable:
    'That entry has already been invoiced, so its amount cannot change and it cannot be removed.',
  waive_reason_required: 'A reason is required to waive a schedule entry.',
  engagement_schedule_unbalanced:
    'The schedule entries must add up to exactly the engagement total.',
  invalid_name: 'An engagement needs a name between 1 and 200 characters.',
  invalid_currency: 'Use a three letter currency code, for example USD.',
  invalid_initial_status: 'A new engagement can only start as a draft or active.',
  invalid_actor: 'This write could not be attributed to anyone, so it was refused.',
  invalid_agent_key: 'That API key cannot be used for this business.',
  request_id_required: 'A request_id is required for this write.',

  // Part B: billing a schedule entry onto an invoice, and
  // turning an accepted quote into an agreement.
  engagement_entry_already_invoiced:
    'That schedule entry is already on an invoice. Delete that draft invoice first if it was wrong, or bill a different entry.',
  engagement_entry_not_ready:
    'That schedule entry is not ready to bill yet. Its due rule has not fired: start the engagement, mark the milestone complete, or wait for its date.',
  engagement_entry_not_found: 'Schedule entry not found',
  engagement_entry_client_mismatch:
    'That schedule entry belongs to a different client, so it cannot go on this invoice.',
  engagement_entry_currency_mismatch:
    'The engagement and the invoice are in different currencies. Billr never converts money on its own, so bill it on an invoice in the engagement currency.',
  engagement_not_billable:
    'That engagement is a draft or was cancelled, so nothing can be billed against it. Start it first, if the work is going ahead.',
  duplicate_engagement_entry_ids: 'The same schedule entry was listed twice. List each one once.',
  estimate_already_converted:
    'That estimate has already been converted into an invoice, so it cannot also become an engagement.',
  estimate_already_an_engagement:
    'That estimate has already become an engagement. Bill it from the engagement schedule rather than converting it again.',
  estimate_not_convertible:
    'That estimate was declined or has expired, so it cannot be converted.',
}

/**
 * The sentence for a raised code, or null when the code is not one of ours
 * (in which case the caller shows its own fallback rather than relaying a
 * Postgres error to a person).
 */
export function engagementErrorMessage(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim()
  if (!code) return null

  const exact = scheduleErrorMessage(code) ?? ENGAGEMENT_ERRORS[code]
  if (exact) return exact

  // Postgres wraps the code in a longer message on some paths, so fall back to
  // a containment match rather than giving up on an otherwise known rule.
  for (const [key, message] of Object.entries(ENGAGEMENT_ERRORS)) {
    if (code.includes(key)) return message
  }
  return null
}
