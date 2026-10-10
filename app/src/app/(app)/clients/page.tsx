'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Plus, Search, Users, MoreHorizontal, Mail, Phone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { AgentBadge } from '@/components/agents/agent-badge'
import { useBusiness } from '@/lib/hooks/use-business'
import type { Client } from '@/types'

type ClientRow = Client & { created_via?: string | null }

const ZERO_TOTALS = { total_invoiced: 0, total_paid: 0, outstanding_balance: 0 }

export default function ClientsPage() {
  const { currentBusiness } = useBusiness()
  const [clients, setClients] = useState<ClientRow[]>([])
  const [totals, setTotals] = useState<Map<string, typeof ZERO_TOTALS>>(new Map())
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    async function fetchClients() {
      if (!currentBusiness) return

      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      // Totals come from the client_financials view, which
      // computes them from the invoices table. The clients table used to carry
      // total_invoiced / total_paid columns that nothing ever wrote, so this
      // card showed $0.00 for every client.
      const [{ data }, { data: financials }] = await Promise.all([
        supabase
          .from('clients')
          .select('*')
          .eq('business_id', currentBusiness.id)
          .eq('is_active', true)
          .order('name'),
        supabase
          .from('client_financials')
          .select('client_id, currency, total_invoiced, total_paid, outstanding_balance')
          .eq('business_id', currentBusiness.id),
      ])

      if (data) {
        setClients(data as ClientRow[])
      }
      if (financials) {
        setTotals(
          new Map(
            financials.map((f) => [
              `${f.client_id}:${f.currency}`,
              {
                total_invoiced: f.total_invoiced ?? 0,
                total_paid: f.total_paid ?? 0,
                outstanding_balance: f.outstanding_balance ?? 0,
              },
            ])
          )
        )
      }
      setIsLoading(false)
    }

    fetchClients()
  }, [currentBusiness])

  const filteredClients = clients.filter((client) =>
    client.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    client.email?.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const formatCurrency = (amount: number, currency = currentBusiness?.default_currency || 'USD') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount)
  }

  if (!currentBusiness) {
    return null
  }

  return (
    <div className="p-6 lg:p-8">
      <PageHeader
        title="Clients"
        description="Manage your clients and their information"
      >
        <Button asChild>
          <Link href="/clients/new">
            <Plus className="mr-2 h-4 w-4" />
            Add Client
          </Link>
        </Button>
      </PageHeader>

      {/* Search */}
      <div className="mt-6">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search clients..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Client List */}
      <div className="mt-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : filteredClients.length === 0 ? (
          <Card>
            <CardContent className="py-12">
              <EmptyState
                icon={Users}
                title={searchQuery ? 'No clients found' : 'No clients yet'}
                description={
                  searchQuery
                    ? 'Try a different search term'
                    : 'Add your first client to start creating invoices'
                }
                action={
                  !searchQuery
                    ? { label: 'Add Client', href: '/clients/new' }
                    : undefined
                }
              />
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredClients.map((client) => (
              <Card key={client.id} className="transition-shadow hover:shadow-md">
                <CardContent className="p-6">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
                        {client.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/clients/${client.id}`}
                            className="font-medium hover:text-primary"
                          >
                            {client.name}
                          </Link>
                          {client.created_via === 'agent' && <AgentBadge />}
                        </div>
                        {(totals.get(`${client.id}:${client.currency}`) ?? ZERO_TOTALS).outstanding_balance > 0 && (
                          <p className="text-sm text-amber-600">
                            {formatCurrency((totals.get(`${client.id}:${client.currency}`) ?? ZERO_TOTALS).outstanding_balance, client.currency)} outstanding
                          </p>
                        )}
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link href={`/clients/${client.id}`}>View details</Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <Link href={`/invoices/new?client=${client.id}`}>
                            Create invoice
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <Link href={`/clients/${client.id}/edit`}>Edit</Link>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <div className="mt-4 space-y-2">
                    {client.email && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Mail className="h-4 w-4" />
                        <span className="truncate">{client.email}</span>
                      </div>
                    )}
                    {client.phone && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Phone className="h-4 w-4" />
                        <span>{client.phone}</span>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex items-center justify-between border-t pt-4 text-sm">
                    <span className="text-muted-foreground">Total invoiced</span>
                    <span className="font-medium tabular-nums">
                      {formatCurrency((totals.get(`${client.id}:${client.currency}`) ?? ZERO_TOTALS).total_invoiced, client.currency)}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
