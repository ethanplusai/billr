'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import {
  Activity,
  AlertCircle,
  Clock,
  FileText,
  Loader2,
  Receipt,
  User,
  Wallet,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/shared/empty-state'
import { useBusiness } from '@/lib/hooks/use-business'
import { activityHref, toActivityRow, type ActivityRow } from '@/lib/agents/activity'

const ENTITY_ICONS = {
  invoice: FileText,
  client: User,
  estimate: FileText,
  time_entry: Clock,
  expense: Receipt,
  payment: Wallet,
} as const

const PAGE_LIMIT = 50

function formatCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(amount)
}

export function ActivityPanel() {
  const { currentBusiness } = useBusiness()
  const [rows, setRows] = useState<ActivityRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)

  const loadPage = useCallback(
    async (before?: { createdAt: string; entityId: string }) => {
      if (!currentBusiness) return { ok: false as const }

      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()

      const { data, error: rpcError } = await supabase.rpc('get_agent_activity', {
        p_business_ids: [currentBusiness.id],
        p_limit: PAGE_LIMIT,
        ...(before
          ? { p_before: before.createdAt, p_before_id: before.entityId }
          : {}),
      })

      if (rpcError) {
        return { ok: false as const }
      }

      const rawRows = data ?? []
      const mapped = rawRows
        .map(toActivityRow)
        .filter((r): r is ActivityRow => r !== null)

      setHasMore(rawRows.length === PAGE_LIMIT)
      setRows((prev) => (before ? [...prev, ...mapped] : mapped))
      return { ok: true as const }
    },
    [currentBusiness]
  )

  useEffect(() => {
    async function initialLoad() {
      setIsLoading(true)
      setError(null)
      const result = await loadPage()
      if (!result.ok) {
        setError('Could not load agent activity. Try again in a moment.')
      }
      setIsLoading(false)
    }
    initialLoad()
  }, [loadPage])

  async function handleLoadMore() {
    const last = rows[rows.length - 1]
    if (!last) return
    setIsLoadingMore(true)
    setLoadMoreError(null)
    const result = await loadPage({ createdAt: last.created_at, entityId: last.entity_id })
    if (!result.ok) {
      setLoadMoreError('Could not load more activity. Try again in a moment.')
    }
    setIsLoadingMore(false)
  }

  if (!currentBusiness) {
    return null
  }

  return (
    <div>
      <div>
        <h2 className="text-lg font-semibold text-foreground">Activity</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          What your connected agents have created in Billr, newest first
        </p>
      </div>

      <div className="mt-6">
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex h-32 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="flex h-32 flex-col items-center justify-center gap-3 text-center">
                <AlertCircle className="h-6 w-6 text-destructive" />
                <p className="text-sm text-muted-foreground">{error}</p>
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={Activity}
                title="No agent activity yet"
                description="Agents have not created anything yet. Connect an agent to get started."
                action={{ label: 'Go to Connect', href: '/agents?tab=connect' }}
              />
            ) : (
              <div>
                <ul className="divide-y">
                  {rows.map((row) => {
                    const Icon = ENTITY_ICONS[row.entity_type]
                    return (
                      <li key={`${row.entity_type}-${row.entity_id}`}>
                        <Link
                          href={activityHref(row)}
                          className="flex items-center gap-3 p-4 hover:bg-muted/50"
                        >
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
                            <Icon className="h-4 w-4 text-muted-foreground" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium text-foreground">{row.label}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatDistanceToNow(new Date(row.created_at), { addSuffix: true })}
                            </p>
                          </div>
                          {row.amount !== null && (
                            <span className="shrink-0 font-medium tabular-nums">
                              {formatCurrency(row.amount, currentBusiness.default_currency || 'USD')}
                            </span>
                          )}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
                {loadMoreError && (
                  <div className="flex flex-col items-center gap-2 border-t p-4 text-center">
                    <p className="text-sm text-muted-foreground">{loadMoreError}</p>
                    <Button variant="outline" size="sm" onClick={handleLoadMore} disabled={isLoadingMore}>
                      {isLoadingMore && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Try again
                    </Button>
                  </div>
                )}
                {!loadMoreError && hasMore && (
                  <div className="flex justify-center border-t p-4">
                    <Button variant="outline" onClick={handleLoadMore} disabled={isLoadingMore}>
                      {isLoadingMore && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Load more
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
