import './workspace.css'
import { BusinessProvider } from '@/lib/hooks/use-business'
import { AppShell } from '@/components/layout/app-shell'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <BusinessProvider>
      <AppShell>{children}</AppShell>
    </BusinessProvider>
  )
}
