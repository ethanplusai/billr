'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { DOCS_URL } from '@/lib/deployment'
import {
  LayoutDashboard,
  FileText,
  FileCheck,
  Handshake,
  Users,
  Package,
  Clock,
  Receipt,
  CreditCard,
  BarChart3,
  Bot,
  Settings,
  Plus,
  LogOut,
  ChevronDown,
  Building2,
  ArrowUpRight,
  Timer,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { useBusiness } from '@/lib/hooks/use-business'
import { createClient } from '@/lib/supabase/client'
import { Logo } from '@/components/brand/logo'

export const workspaceNavigation = [
  {
    label: 'Workspace',
    items: [
      {
        href: '/dashboard',
        label: 'Overview',
        icon: LayoutDashboard,
        tourId: 'dashboard',
      },
      {
        href: '/invoices',
        label: 'Invoices',
        icon: FileText,
        tourId: 'invoices',
      },
      {
        href: '/engagements',
        label: 'Engagements',
        icon: Handshake,
        tourId: 'engagements',
      },
      {
        href: '/estimates',
        label: 'Estimates',
        icon: FileCheck,
        tourId: 'estimates',
      },
      { href: '/clients', label: 'Clients', icon: Users, tourId: 'clients' },
      { href: '/items', label: 'Saved items', icon: Package, tourId: 'items' },
    ],
  },
  {
    label: 'Work & money',
    items: [
      { href: '/tasks', label: 'Task billing', icon: Timer, tourId: 'tasks' },
      { href: '/time', label: 'Time entries', icon: Clock, tourId: 'time' },
      {
        href: '/expenses',
        label: 'Expenses',
        icon: Receipt,
        tourId: 'expenses',
      },
      {
        href: '/payments',
        label: 'Payments',
        icon: CreditCard,
        tourId: 'payments',
      },
      {
        href: '/reports',
        label: 'Reports',
        icon: BarChart3,
        tourId: 'reports',
      },
    ],
  },
  {
    label: 'Manage',
    items: [
      { href: '/agents', label: 'Agents', icon: Bot, tourId: 'agents' },
      {
        href: '/settings',
        label: 'Settings',
        icon: Settings,
        tourId: 'settings',
      },
    ],
  },
]

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  const router = useRouter()
  const { currentBusiness, businesses, profile, setCurrentBusiness } =
    useBusiness()
  async function signOut() {
    await createClient().auth.signOut()
    onNavigate?.()
    router.push('/login')
    router.refresh()
  }
  const initials = (profile?.full_name || 'Your account')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <aside className="workspace-sidebar flex h-dvh w-[232px] flex-col bg-[#f7f8fa]">
      <div className="flex h-[68px] shrink-0 items-center px-6">
        <Link
          href="/dashboard"
          onClick={onNavigate}
          aria-label="Billr overview"
        >
          <Logo size="sm" />
        </Link>
      </div>
      <div className="px-3 pb-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="h-auto w-full justify-between gap-2 rounded-lg border border-zinc-200/80 bg-white px-3 py-2.5 shadow-sm"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-blue-50 text-primary">
                  <Building2 size={14} />
                </span>
                <span className="min-w-0 text-left">
                  <span className="block text-[10px] font-normal text-zinc-400">
                    Workspace
                  </span>
                  <span className="block truncate text-xs font-medium">
                    {currentBusiness?.name || 'Select business'}
                  </span>
                </span>
              </span>
              <ChevronDown size={13} className="shrink-0 text-zinc-400" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-60" align="start">
            {businesses.map((b) => (
              <DropdownMenuItem
                key={b.id}
                onClick={() => setCurrentBusiness(b.id)}
                className={cn(b.id === currentBusiness?.id && 'bg-accent')}
              >
                <Building2 className="mr-2 h-4 w-4" />
                {b.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings/business?new=true" onClick={onNavigate}>
                <Plus className="mr-2 h-4 w-4" />
                Add business
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <nav
        aria-label="Workspace navigation"
        className="flex-1 space-y-5 overflow-y-auto px-3 pb-4"
        data-tour="nav"
      >
        {workspaceNavigation.map((group) => (
          <div key={group.label}>
            <p className="mb-2 px-3 text-[10px] font-medium uppercase tracking-[.12em] text-zinc-400">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active =
                  pathname === item.href || pathname.startsWith(item.href + '/')
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    data-tour={item.tourId}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex min-h-9 items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors',
                      active
                        ? 'bg-white font-medium text-primary shadow-[0_1px_3px_#18181b0b] ring-1 ring-zinc-200/70'
                        : 'text-zinc-500 hover:bg-zinc-200/40 hover:text-zinc-900',
                    )}
                  >
                    <item.icon size={16} strokeWidth={1.65} />
                    {item.label}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="mx-3 border-t border-zinc-200/80 py-3">
        <Link
          href={DOCS_URL}
          target="_blank"
          className="mb-2 flex items-center justify-between rounded-lg px-3 py-2 text-xs text-zinc-500 hover:bg-white"
        >
          Help & documentation
          <ArrowUpRight size={13} />
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="h-11 w-full justify-start gap-2.5 px-2"
            >
              <Avatar className="h-7 w-7">
                <AvatarFallback className="bg-zinc-200/70 text-[10px] text-zinc-600">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">
                {profile?.full_name || 'Your account'}
              </span>
              <ChevronDown size={13} className="text-zinc-400" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align="end" side="top">
            <DropdownMenuItem asChild>
              <Link href="/settings/account" onClick={onNavigate}>
                <Settings className="mr-2 h-4 w-4" />
                Account settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={signOut}>
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  )
}
