'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Plus, Search, Handshake } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { useBusiness } from '@/lib/hooks/use-business'
import { ENGAGEMENT_STATUSES } from '@/lib/engagements/schedule'
import { ENGAGEMENT_STATUS_COLORS, type EngagementListRow } from '@/lib/engagements/types'

function formatMoney(amount: number | null, currency: string | null) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
  }).format(amount ?? 0)
}

export default function EngagementsPage() {
  return (
    <Suspense>
      <EngagementsPageInner />
    </Suspense>
  )
}

function EngagementsPageInner() {
  const { currentBusiness } = useBusiness()
  // The dashboard "Ready to bill" card links here with ?ready=1, so the
  // reminder lands on exactly the engagements it was counting.
  const readyOnly = useSearchParams().get('ready') === '1'
  const [engagements, setEngagements] = useState<EngagementListRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const load = useCallback(async () => {
    if (!currentBusiness) return

    const { createClient } = await import('@/lib/supabase/client')
    const supabase = createClient()

    // The scheduled-date sweep runs on the read path rather than on a cron,
    // so opening this page is what makes a payment whose
    // date has passed show up as ready to bill.
    await supabase.rpc('promote_due_entries', { p_business_id: currentBusiness.id })

    const [{ data: rows }, { data: clients }] = await Promise.all([
      supabase
        .from('engagement_summary')
        .select('*')
        .eq('business_id', currentBusiness.id),
      supabase.from('clients').select('id, name').eq('business_id', currentBusiness.id),
    ])

    const names = new Map((clients ?? []).map((client) => [client.id, client.name]))
    const summaries = (rows ?? []) as EngagementListRow[]
    setEngagements(
      summaries
        .map((row) => ({ ...row, client_name: names.get(row.client_id ?? '') ?? null }))
        .sort((a, b) => (b.ready_count ?? 0) - (a.ready_count ?? 0) || (a.name ?? '').localeCompare(b.name ?? '')),
    )
    setIsLoading(false)
  }, [currentBusiness])

  useEffect(() => {
    load()
  }, [load])

  const filtered = engagements.filter((engagement) => {
    const query = searchQuery.toLowerCase()
    const matchesSearch =
      !query ||
      (engagement.name ?? '').toLowerCase().includes(query) ||
      (engagement.client_name ?? '').toLowerCase().includes(query)
    const matchesStatus = statusFilter === 'all' || engagement.status === statusFilter
    const matchesReady = !readyOnly || (engagement.ready_count ?? 0) > 0
    return matchesSearch && matchesStatus && matchesReady
  })

  const readyTotal = engagements.reduce((sum, row) => sum + (row.ready_count ?? 0), 0)

  if (!currentBusiness) return null

  return (
    <div className="p-6 lg:p-8">
      <PageHeader
        title="Engagements"
        description="Agreed work with a total and a payment schedule. Nothing here is ever sent to a client on its own."
      >
        <Button asChild>
          <Link href="/engagements/new">
            <Plus className="mr-2 h-4 w-4" />
            New Engagement
          </Link>
        </Button>
      </PageHeader>

      <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search engagements..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {ENGAGEMENT_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {readyOnly ? (
          <Badge className="bg-emerald-100 text-emerald-700" asChild>
            <Link href="/engagements">Ready to bill only. Show all</Link>
          </Badge>
        ) : (
          readyTotal > 0 && (
            <Link href="/engagements?ready=1">
              <Badge className="bg-emerald-100 text-emerald-700">
                {readyTotal} ready to bill
              </Badge>
            </Link>
          )
        )}
      </div>

      <div className="mt-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <Card>
            <CardContent className="py-12">
              <EmptyState
                icon={Handshake}
                title={
                  searchQuery || statusFilter !== 'all'
                    ? 'No engagements found'
                    : 'No engagements yet'
                }
                description={
                  searchQuery || statusFilter !== 'all'
                    ? 'Try adjusting your search or filter'
                    : 'Record an agreed total once, then bill it off a schedule instead of remembering what is left'
                }
                action={
                  !searchQuery && statusFilter === 'all'
                    ? { label: 'New Engagement', href: '/engagements/new' }
                    : undefined
                }
              />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Engagement</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Billed</TableHead>
                    <TableHead className="text-right">Remaining</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((engagement) => (
                    <TableRow key={engagement.engagement_id}>
                      <TableCell>
                        <Link
                          href={`/engagements/${engagement.engagement_id}`}
                          className="font-medium text-foreground hover:text-primary"
                        >
                          {engagement.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {engagement.client_name ?? 'Unknown client'}
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={
                            engagement.status
                              ? ENGAGEMENT_STATUS_COLORS[engagement.status]
                              : undefined
                          }
                        >
                          {engagement.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {formatMoney(engagement.total, engagement.currency)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatMoney(engagement.amount_billed, engagement.currency)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatMoney(engagement.amount_remaining, engagement.currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        {(engagement.ready_count ?? 0) > 0 && (
                          <Badge className="bg-emerald-100 text-emerald-700">
                            Ready to bill
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
