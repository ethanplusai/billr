'use client'

import type { KeyProfile } from '@/lib/mcp/permissions'
import { useEffect, useState } from 'react'
import { Loader2, Copy, Check } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useBusiness } from '@/lib/hooks/use-business'
import {
  createApiKeyAction,
  revokeApiKeyAction,
  listApiKeysAction,
  listOauthConnectionsAction,
  revokeOauthConnectionAction,
} from '@/lib/actions/api-keys'

type ApiKey = Awaited<ReturnType<typeof listApiKeysAction>>[number]
type Connection = Awaited<ReturnType<typeof listOauthConnectionsAction>>[number]

const ALL_BUSINESSES_VALUE = '__all__'

function PermissionBadges({ permissions }: { permissions: readonly string[] }) {
  if (permissions.length === 0) {
    return <span className="text-xs text-muted-foreground">No permissions</span>
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {permissions.map((permission) => (
        <Badge key={permission} variant="secondary" className="font-normal">
          {permission}
        </Badge>
      ))}
    </span>
  )
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString() : null
}

export function ApiKeysPanel() {
  const { businesses } = useBusiness()
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [checkedAt, setCheckedAt] = useState(0)
  const [isLoading, setIsLoading] = useState(true)

  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [permissionProfile, setPermissionProfile] = useState<KeyProfile>('draft')
  const [businessId, setBusinessId] = useState<string>(ALL_BUSINESSES_VALUE)
  const [isCreating, setIsCreating] = useState(false)

  const [newSecret, setNewSecret] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const [revokingId, setRevokingId] = useState<string | null>(null)

  const [connections, setConnections] = useState<Connection[]>([])
  const [pendingRevoke, setPendingRevoke] = useState<Connection | null>(null)
  const [isRevokingConnection, setIsRevokingConnection] = useState(false)

  async function loadKeys() {
    const data = await listApiKeysAction()
    setKeys(data)
    setCheckedAt(Date.now())
    setIsLoading(false)
  }

  async function loadConnections() {
    setConnections(await listOauthConnectionsAction())
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Fetch the external key list when this panel mounts.
    loadKeys()
    loadConnections()
  }, [])

  function businessName(id: string | null) {
    if (!id) return 'All businesses'
    return businesses.find((b) => b.id === id)?.name ?? 'Unknown business'
  }

  async function handleCreate() {
    if (!label.trim()) {
      toast.error('Label is required')
      return
    }

    setIsCreating(true)
    const result = await createApiKeyAction(
      label.trim(),
      businessId === ALL_BUSINESSES_VALUE ? null : businessId,
      permissionProfile
    )
    setIsCreating(false)

    if ('error' in result) {
      toast.error(result.error)
      return
    }

    setIsCreateOpen(false)
    setLabel('')
    setBusinessId(ALL_BUSINESSES_VALUE)
    setNewSecret(result.secret)
    await loadKeys()
  }

  async function handleRevoke(id: string) {
    if (!confirm('Revoke this API key? Any integration using it will stop working.')) {
      return
    }

    setRevokingId(id)
    const result = await revokeApiKeyAction(id)
    setRevokingId(null)

    if (!result.success) {
      toast.error(result.error ?? 'Could not revoke key')
      return
    }

    toast.success('API key revoked')
    await loadKeys()
  }

  async function handleRevokeConnection() {
    if (!pendingRevoke) return

    setIsRevokingConnection(true)
    const result = await revokeOauthConnectionAction(pendingRevoke.id)
    setIsRevokingConnection(false)

    if (!result.success) {
      toast.error(result.error ?? 'Could not revoke this connection')
      return
    }

    setPendingRevoke(null)
    toast.success('Connection revoked')
    await loadConnections()
  }

  async function handleCopy() {
    if (!newSecret) return
    try {
      await navigator.clipboard.writeText(newSecret)
      setCopied(true)
      toast.success('Copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy. Select the key text and copy it manually')
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">API Keys</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect agents and integrations to your Billr account
          </p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)}>Create Key</Button>
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader>
            <CardTitle>Your API Keys</CardTitle>
            <CardDescription>
              Keys let external tools and agents act on your behalf via the Billr API
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex h-32 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : keys.length === 0 ? (
              <div className="flex h-32 flex-col items-center justify-center text-center">
                <p className="text-sm text-muted-foreground">
                  No API keys yet. Create one to connect an agent or integration.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {keys.map((key) => {
                  const isRevoked = !!key.revoked_at || !!(key.expires_at && Date.parse(key.expires_at) <= checkedAt)
                  return (
                    <div
                      key={key.id}
                      className="flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{key.label}</span>
                          <PermissionBadges permissions={key.permissions} />
                          <span className="text-xs text-muted-foreground">
                            Expires {formatDate(key.expires_at) ?? 'never'}
                          </span>
                          {key.key_prefix && (
                            <span className="font-mono text-xs text-muted-foreground">
                              {key.key_prefix}&hellip;
                            </span>
                          )}
                          <Badge variant={isRevoked ? 'outline' : 'default'}>
                            {isRevoked ? 'Inactive' : 'Active'}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {businessName(key.business_id)} &middot; Created{' '}
                          {new Date(key.created_at).toLocaleDateString()} &middot; Last used{' '}
                          {key.last_used_at
                            ? new Date(key.last_used_at).toLocaleDateString()
                            : 'Never'}
                        </p>
                      </div>
                      {!isRevoked && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={revokingId === key.id}
                          onClick={() => handleRevoke(key.id)}
                        >
                          {revokingId === key.id && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          )}
                          Revoke
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader>
            <CardTitle>Connected apps</CardTitle>
            <CardDescription>
              Apps you approved on the consent screen when connecting by URL
            </CardDescription>
          </CardHeader>
          <CardContent>
            {connections.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No connected apps yet. Use the Connect tab to link Claude, Codex, Cursor or
                ChatGPT by URL.
              </p>
            ) : (
              <div className="space-y-3">
                {connections.map((connection) => {
                  const isRevoked =
                    !!connection.revokedAt ||
                    !!(connection.expiresAt && Date.parse(connection.expiresAt) <= checkedAt)
                  return (
                    <div
                      key={connection.id}
                      className="flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">
                            {connection.clientName ?? connection.label}
                          </span>
                          <PermissionBadges permissions={connection.permissions} />
                          <Badge variant={isRevoked ? 'outline' : 'default'}>
                            {isRevoked ? 'Revoked' : 'Active'}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {businessName(connection.businessId)} &middot; Connected{' '}
                          {formatDate(connection.createdAt)} &middot; Last used{' '}
                          {formatDate(connection.lastUsedAt) ?? 'Never'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {isRevoked
                            ? connection.revokedAt
                              ? `Revoked ${formatDate(connection.revokedAt)}`
                              : 'Access expired'
                            : connection.expiresAt
                              ? `Access expires ${formatDate(connection.expiresAt)}, renews automatically`
                              : 'Renews automatically'}
                        </p>
                      </div>
                      {!isRevoked && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setPendingRevoke(connection)}
                        >
                          Revoke
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Confirm revoking a connected app */}
      <Dialog
        open={!!pendingRevoke}
        onOpenChange={(open) => !open && !isRevokingConnection && setPendingRevoke(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Revoke {pendingRevoke?.clientName ?? pendingRevoke?.label ?? 'this app'}?
            </DialogTitle>
            <DialogDescription>
              It loses access to {businessName(pendingRevoke?.businessId ?? null)} right away and
              cannot renew itself. Connect it again from the Connect tab if you change your mind.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingRevoke(null)}
              disabled={isRevokingConnection}
            >
              Cancel
            </Button>
            <Button onClick={handleRevokeConnection} disabled={isRevokingConnection}>
              {isRevokingConnection && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Revoke access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create key dialog */}
      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API Key</DialogTitle>
            <DialogDescription>
              Give the key a label so you can recognize it later.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="key-label">Label</Label>
              <Input
                id="key-label"
                placeholder="e.g. My agent"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="key-business">Business</Label>
              <Select value={businessId} onValueChange={setBusinessId}>
                <SelectTrigger id="key-business" className="w-full">
                  <SelectValue placeholder="All businesses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_BUSINESSES_VALUE}>All businesses</SelectItem>
                  {businesses.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2 mb-4"><Label htmlFor="key-permissions">Agent permissions</Label><select id="key-permissions" className="w-full rounded border p-2 bg-background" value={permissionProfile} onChange={e=>setPermissionProfile(e.target.value as KeyProfile)}><option value="draft">Read and draft (recommended)</option><option value="readonly">Read only</option><option value="billing">Billing: draft, send and record payments</option><option value="full">Full: billing and delete unbilled work</option></select><p className="text-xs text-muted-foreground">Expires in 90 days. Task pricing and billing approval always require a human.</p></div>
            <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={isCreating}>
              {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Secret shown once dialog */}
      <Dialog open={!!newSecret} onOpenChange={(open) => !open && setNewSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API Key Created</DialogTitle>
            <DialogDescription>
              Copy this key now. You won&apos;t be able to see this key again.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
            <Input readOnly value={newSecret ?? ''} className="font-mono text-sm" />
            <Button type="button" variant="outline" size="icon" onClick={handleCopy}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              <span className="sr-only">Copy</span>
            </Button>
          </div>

          <DialogFooter>
            <Button onClick={() => setNewSecret(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
