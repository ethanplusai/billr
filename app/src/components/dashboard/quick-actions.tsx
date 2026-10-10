import Link from 'next/link'
import {
  FileText,
  FileCheck,
  Users,
  Receipt,
  ArrowUpRight,
  Bot,
} from 'lucide-react'

const actions = [
  {
    title: 'Create an invoice',
    description: 'Bill a client for your work',
    href: '/invoices/new',
    icon: FileText,
  },
  {
    title: 'Send an estimate',
    description: 'Agree on the work up front',
    href: '/estimates/new',
    icon: FileCheck,
  },
  {
    title: 'Add a client',
    description: 'Keep their details in one place',
    href: '/clients/new',
    icon: Users,
  },
  {
    title: 'Record an expense',
    description: 'Keep track of what you spend',
    href: '/expenses/new',
    icon: Receipt,
  },
]
export function QuickActions() {
  return (
    <div>
      <h2 className="mb-4 text-sm font-semibold">Quick actions</h2>
      <div className="divide-y divide-zinc-100">
        {actions.map((a) => (
          <Link
            key={a.href}
            href={a.href}
            className="group flex items-center gap-3 py-4"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 transition-colors group-hover:border-blue-200 group-hover:bg-blue-50 group-hover:text-primary">
              <a.icon size={16} strokeWidth={1.5} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-zinc-800">
                {a.title}
              </span>
              <span className="mt-1 block text-xs text-zinc-400">
                {a.description}
              </span>
            </span>
            <ArrowUpRight
              size={14}
              className="text-zinc-300 group-hover:text-primary"
            />
          </Link>
        ))}
      </div>
      <Link
        href="/agents"
        className="mt-6 block rounded-xl border border-blue-100 bg-blue-50/40 p-5"
      >
        <Bot size={19} strokeWidth={1.5} className="mb-3 text-primary" />
        <span className="block text-sm font-medium">
          Let your agent handle it
        </span>
        <span className="mt-2 block text-xs leading-relaxed text-zinc-500">
          Connect an agent to log work and draft invoices in your workspace.
        </span>
        <span className="mt-4 inline-flex items-center gap-2 text-xs font-medium text-primary">
          Connect your agent
          <ArrowUpRight size={13} />
        </span>
      </Link>
    </div>
  )
}
