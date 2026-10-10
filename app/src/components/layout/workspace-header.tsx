'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { workspaceNavigation } from './sidebar'

const detailNames: Record<string, string> = {
  new: 'Create new',
  edit: 'Edit',
  business: 'Business',
  account: 'Account',
  branding: 'Branding',
  invoices: 'Invoice defaults',
}
export function WorkspaceHeader() {
  const pathname = usePathname()
  const segments = pathname.split('/').filter(Boolean)
  const page = workspaceNavigation
    .flatMap((g) => g.items)
    .find((item) => item.href === `/${segments[0]}`)
  if (!page) return null
  return (
    <div className="hidden h-14 shrink-0 items-center justify-between border-b border-zinc-100 px-8 lg:flex">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs">
        <page.icon size={14} className="text-zinc-400" />
        <Link href={page.href} className="text-zinc-500 hover:text-primary">
          {page.label}
        </Link>
        {segments.slice(1).map((part, index) => (
          <span key={index} className="flex items-center gap-2">
            <ChevronRight size={12} className="text-zinc-300" />
            <span className="text-zinc-700">
              {detailNames[part] || 'Details'}
            </span>
          </span>
        ))}
      </nav>
      <span className="text-[11px] text-zinc-400">Your billing workspace</span>
    </div>
  )
}
