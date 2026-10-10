import { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

interface StatsCardProps {
  title: string
  value: string
  change?: { value: number; trend: 'up' | 'down' | 'neutral' }
  icon: LucideIcon
  className?: string
}
export function StatsCard({
  title,
  value,
  change,
  icon: Icon,
  className,
}: StatsCardProps) {
  return (
    <div className={cn('min-w-0 px-5 py-5 sm:px-6', className)}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">{title}</p>
        <Icon size={15} strokeWidth={1.5} className="text-zinc-400" />
      </div>
      <p className="mt-3 text-[28px] font-semibold leading-none tracking-tight tabular-nums text-zinc-900">
        {value}
      </p>
      {change && (
        <p
          className={cn(
            'mt-3 text-xs',
            change.trend === 'up'
              ? 'text-emerald-600'
              : change.trend === 'down'
                ? 'text-red-600'
                : 'text-zinc-500',
          )}
        >
          {change.trend === 'up' && '+'}
          {change.value}% from last month
        </p>
      )}
    </div>
  )
}
