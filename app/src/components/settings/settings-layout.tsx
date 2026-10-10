'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Building2, Palette, FileText, User } from 'lucide-react'
import { cn } from '@/lib/utils'

const settingsNav = [
  { href: '/settings/business', label: 'Business', icon: Building2 },
  { href: '/settings/branding', label: 'Branding', icon: Palette },
  { href: '/settings/invoices', label: 'Invoices', icon: FileText },
  { href: '/settings/account', label: 'Account', icon: User },
]

interface SettingsLayoutProps {
  children: React.ReactNode
}

export function SettingsLayout({ children }: SettingsLayoutProps) {
  const pathname = usePathname()

  return (
    <div className="space-y-7">
      {/* Sidebar Navigation */}
      <nav
        aria-label="Settings sections"
        className="flex gap-6 overflow-x-auto border-b border-zinc-200"
      >
        {settingsNav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={pathname === item.href ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-2 border-b-2 border-transparent px-1 py-3 text-xs font-medium transition-colors',
              pathname === item.href
                ? 'border-primary text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        ))}
      </nav>

      {/* Content */}
      <div className="max-w-4xl">{children}</div>
    </div>
  )
}
