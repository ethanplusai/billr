import { Bot } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

export function AgentBadge() {
  return (
    <Badge variant="secondary" className="gap-1 text-xs font-normal text-muted-foreground">
      <Bot className="h-3 w-3" />
      via agent
    </Badge>
  )
}
