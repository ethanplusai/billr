'use client'

import { toast } from 'sonner'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import {
  Plus,
  Search,
  Receipt,
  MoreHorizontal,
  Pencil,
  Trash2,
  TrendingUp,
} from 'lucide-react'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { useBusiness } from '@/lib/hooks/use-business'
import type { Expense, Client } from '@/types'

import { deleteExpenseAction } from '@/lib/actions/expenses'
import { parseDay } from '@/lib/dates'

export default function ExpensesPage() {
  const { currentBusiness } = useBusiness()
  const [expenses, setExpenses] = useState<(Expense & { client: Client | null })[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [billedFilter, setBilledFilter] = useState<string>('all')
  const [deleteExpense, setDeleteExpense] = useState<Expense | null>(null)

  useEffect(() => {
    async function fetchExpenses() {
      if (!currentBusiness) return

      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      const { data } = await supabase
        .from('expenses')
        .select('*, client:clients(*)')
        .eq('business_id', currentBusiness.id)
        .order('date', { ascending: false })

      if (data) {
        setExpenses(data as (Expense & { client: Client | null })[])
      }
      setIsLoading(false)
    }

    fetchExpenses()
  }, [currentBusiness])

  const filteredExpenses = expenses.filter((expense) => {
    const matchesSearch =
      expense.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      expense.vendor?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      expense.category.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesCategory =
      categoryFilter === 'all' || expense.category === categoryFilter
    const matchesBilled =
      billedFilter === 'all' ||
      (billedFilter === 'billed' && expense.is_billed) ||
      (billedFilter === 'unbilled' && !expense.is_billed && expense.is_billable)
    return matchesSearch && matchesCategory && matchesBilled
  })

  // Calculate totals
  const totalExpenses = filteredExpenses.filter(e=>e.currency===currentBusiness?.default_currency).reduce((sum, e) => sum + e.amount, 0)
  const billableAmount = filteredExpenses.filter(e=>(e.currency || currentBusiness?.default_currency)===currentBusiness?.default_currency)
    .filter((e) => e.is_billable && !e.is_billed)
    .reduce((sum, e) => sum + e.amount, 0)

  const formatCurrency = (amount: number, currency = currentBusiness?.default_currency || 'USD') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount)
  }

  const handleDelete = async () => {
    if (!deleteExpense) return

    const result = await deleteExpenseAction(deleteExpense.id)
    if ('error' in result) { toast.error(result.error); return }
    setExpenses(expenses.filter((e) => e.id !== deleteExpense.id))
    setDeleteExpense(null)
  }

  const uniqueCategories = Array.from(
    new Set(expenses.map((e) => e.category))
  ).sort()

  if (!currentBusiness) return null

  return (
    <div className="p-6 lg:p-8">
      <PageHeader
        title="Expenses"
        description="Track business expenses and billable costs"
      >
        <Button asChild>
          <Link href="/expenses/new">
            <Plus className="mr-2 h-4 w-4" />
            Add Expense
          </Link>
        </Button>
      </PageHeader>

      {/* Stats */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                <Receipt className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Expenses ({currentBusiness?.default_currency})</p>
                <p className="text-2xl font-bold tabular-nums">{formatCurrency(totalExpenses)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100">
                <TrendingUp className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Unbilled Expenses</p>
                <p className="text-2xl font-bold tabular-nums">{formatCurrency(billableAmount)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search expenses..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {uniqueCategories.map((cat) => (
              <SelectItem key={cat} value={cat}>
                {cat}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={billedFilter} onValueChange={setBilledFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="unbilled">Unbilled</SelectItem>
            <SelectItem value="billed">Billed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Expenses List */}
      <div className="mt-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : filteredExpenses.length === 0 ? (
          <Card>
            <CardContent className="py-12">
              <EmptyState
                icon={Receipt}
                title={searchQuery || categoryFilter !== 'all' ? 'No expenses found' : 'No expenses yet'}
                description={
                  searchQuery || categoryFilter !== 'all'
                    ? 'Try adjusting your filters'
                    : 'Track your business expenses for better accounting'
                }
                action={
                  !searchQuery && categoryFilter === 'all'
                    ? { label: 'Add Expense', href: '/expenses/new' }
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
                    <TableHead>Date</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredExpenses.map((expense) => (
                    <TableRow key={expense.id}>
                      <TableCell className="font-medium">
                        {format(parseDay(expense.date), 'MMM d, yyyy')}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{expense.category}</Badge>
                      </TableCell>
                      <TableCell className="max-w-xs truncate">
                        {expense.description || '-'}
                      </TableCell>
                      <TableCell>
                        {expense.vendor || '-'}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatCurrency(expense.amount, expense.currency)}
                      </TableCell>
                      <TableCell>
                        {!expense.is_billable ? (
                          <Badge variant="secondary">Non-billable</Badge>
                        ) : expense.is_billed ? (
                          <Badge variant="secondary" className="bg-green-100 text-green-700">
                            Billed
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="bg-amber-100 text-amber-700">
                            Unbilled
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link href={`/expenses/${expense.id}`}>
                                <Pencil className="mr-2 h-4 w-4" />
                                Edit
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setDeleteExpense(expense)}
                              className="text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Delete Confirmation */}
      <Dialog open={!!deleteExpense} onOpenChange={() => setDeleteExpense(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Expense</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this expense? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteExpense(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

