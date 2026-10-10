'use client'

import { Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import { PageHeader } from '@/components/shared/page-header'
import { AgentsTabs } from '@/components/agents/agents-tabs'

export default function AgentsPage() {
  return (
    <div className="p-6 lg:p-8">
      <PageHeader
        title="Agents"
        description="Connect agents to your Billr account and manage keys, payments, activity, and recipes"
      />

      <div className="mt-6">
        <Suspense
          fallback={
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <AgentsTabs />
        </Suspense>
      </div>
    </div>
  )
}
