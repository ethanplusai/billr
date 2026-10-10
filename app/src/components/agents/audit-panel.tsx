'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import type { Database } from '@/types/database'
type Call = Database['public']['Tables']['agent_tool_calls']['Row']
export function AuditPanel() {
  const [calls, setCalls] = useState<Call[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true)
  async function load() {
    const { data, error } = await createClient()
      .from('agent_tool_calls')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) setError('Could not load your audit history')
    else {
      setCalls(data || [])
      setError('')
    }
    setLoading(false)
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Fetch the external audit log on mount.
    void load()
  }, [])
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Tool audit history</h2>
        <Button variant="outline" onClick={load}>
          Refresh
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Your 100 most recent agent calls. A started call has no confirmed
        outcome; check its records before retrying. Arguments and API secrets
        are not included.
      </p>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p>Loading…</p>
      ) : calls.length === 0 ? (
        <p>No tool calls yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">Time</th>
                <th className="p-2">Tool</th>
                <th className="p-2">Outcome</th>
                <th className="p-2">Key ID</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id} className="border-b">
                  <td className="p-2">
                    {new Date(c.created_at).toLocaleString()}
                  </td>
                  <td className="p-2 font-mono">{c.tool_name}</td>
                  <td className="p-2">{c.status}</td>
                  <td className="p-2 font-mono">{c.key_id || 'Deleted key'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
