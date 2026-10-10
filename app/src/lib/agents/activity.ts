const ACTIVITY_ENTITIES = [
  'invoice', 'client', 'estimate', 'time_entry', 'expense', 'payment',
] as const

type ActivityEntity = (typeof ACTIVITY_ENTITIES)[number]

export interface ActivityRow {
  entity_type: ActivityEntity
  entity_id: string
  business_id: string
  label: string
  amount: number | null
  created_at: string
  created_via: string
  created_by_key_id: string | null
}

export function activityHref(row: ActivityRow): string {
  switch (row.entity_type) {
    case 'invoice': return `/invoices/${row.entity_id}`
    case 'client': return `/clients/${row.entity_id}`
    case 'estimate': return `/estimates/${row.entity_id}`
    case 'time_entry': return '/time'
    case 'expense': return '/expenses'
    case 'payment': return '/payments'
  }
}

function isActivityEntity(value: unknown): value is ActivityEntity {
  return typeof value === 'string' && (ACTIVITY_ENTITIES as readonly string[]).includes(value)
}

/**
 * Coerces a raw row returned by the `get_agent_activity` RPC into an
 * `ActivityRow`. The generated Supabase types (`src/types/database.ts`)
 * report `amount` and `created_by_key_id` as non-null strings/numbers, but
 * the actual SQL returns NULL for both on several entity types (e.g.
 * `client`/`time_entry` rows always have NULL `amount`; rows created outside
 * the MCP/agent path have NULL `created_by_key_id`), so callers must not
 * trust the generated `Args`/`Returns` types directly and should route every
 * raw RPC row through this mapper instead.
 *
 * Rows with an `entity_type` outside the six known literals are dropped
 * (returns `null`) rather than thrown, since the activity feed is a
 * best-effort UI list: one unrecognized/future row type shouldn't take down
 * the whole feed. Callers should filter nulls out, e.g.
 * `rows.map(toActivityRow).filter((r): r is ActivityRow => r !== null)`.
 */
export function toActivityRow(raw: unknown): ActivityRow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  if (!isActivityEntity(r.entity_type)) return null
  if (typeof r.entity_id !== 'string') return null
  if (typeof r.business_id !== 'string') return null
  if (typeof r.label !== 'string') return null
  if (typeof r.created_at !== 'string') return null
  if (typeof r.created_via !== 'string') return null

  const amount = typeof r.amount === 'number' ? r.amount : null
  const created_by_key_id = typeof r.created_by_key_id === 'string' ? r.created_by_key_id : null

  return {
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    business_id: r.business_id,
    label: r.label,
    amount,
    created_at: r.created_at,
    created_via: r.created_via,
    created_by_key_id,
  }
}
