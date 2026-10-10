'use client'

import { AuditPanel } from '@/components/agents/audit-panel'
import { useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConnectPanel } from '@/components/agents/connect-panel'
import { ApiKeysPanel } from '@/components/agents/api-keys-panel'
import { PaymentsPanel } from '@/components/agents/payments-panel'
import { ActivityPanel } from '@/components/agents/activity-panel'
import { RecipesPanel } from '@/components/agents/recipes-panel'

const TABS = ['connect', 'keys', 'payments', 'activity', 'audit', 'recipes'] as const
type TabValue = (typeof TABS)[number]
const DEFAULT_TAB: TabValue = 'connect'

function isTabValue(value: string | null): value is TabValue {
  return !!value && (TABS as readonly string[]).includes(value)
}

export function AgentsTabs() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tabParam = searchParams.get('tab')
  const activeTab: TabValue = isTabValue(tabParam) ? tabParam : DEFAULT_TAB

  const handleTabChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString())
      params.set('tab', value)
      router.push(`/agents?${params.toString()}`)
    },
    [router, searchParams]
  )

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <TabsList>
        <TabsTrigger value="connect">Connect</TabsTrigger>
        <TabsTrigger value="keys">API Keys</TabsTrigger>
        <TabsTrigger value="payments">Payments</TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
        <TabsTrigger value="audit">Audit</TabsTrigger>
        <TabsTrigger value="recipes">Recipes</TabsTrigger>
      </TabsList>

      <TabsContent value="connect" className="mt-6">
        <ConnectPanel />
      </TabsContent>
      <TabsContent value="keys" className="mt-6">
        <ApiKeysPanel />
      </TabsContent>
      <TabsContent value="payments" className="mt-6">
        <PaymentsPanel />
      </TabsContent>
      <TabsContent value="activity" className="mt-6">
        <ActivityPanel />
      </TabsContent>
      <TabsContent value="audit" className="mt-6"><AuditPanel /></TabsContent>
      <TabsContent value="recipes" className="mt-6">
        <RecipesPanel />
      </TabsContent>
    </Tabs>
  )
}
