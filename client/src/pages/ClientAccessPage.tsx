import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, useSearchParams } from 'react-router-dom'
import { KeyRound, Plus, RotateCw, Trash2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useConfirm } from '@/lib/feedback'
import type { ClientKey } from '@/lib/contracts'
import { invalidateRoutingQueries } from '@/lib/query-cache'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Modal } from '@/components/ui/modal'
import { PageHeader, EmptyState, ErrorState, LoadingState, SectionTitle } from '@/components/page-header'
import { InlineNotice, StatusIndicator } from '@/components/status-indicator'
import { ErrorNotice } from '@/components/error-notice'
import { SearchField } from '@/components/collection-controls'
import { CodeBlock } from '@/components/code-block'
import { AccessPolicyEditor } from '@/components/access-policy-editor'

const quotaFields = [
  ['rpm', 'Requests / minute'],
  ['rpd', 'Requests / day'],
  ['tpm', 'Tokens / minute'],
  ['tpd', 'Tokens / day'],
] as const

function KeyEditor({
  client,
  busy,
  onSave,
}: {
  client: ClientKey
  busy: boolean
  onSave: (body: { label: string; limits: ClientKey['limits'] }) => void
}) {
  const [label, setLabel] = useState(client.label)
  const [limits, setLimits] = useState(() =>
    Object.fromEntries(quotaFields.map(([field]) => [field, client.limits[field]?.toString() ?? ''])),
  )
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        onSave({
          label: label.trim(),
          limits: Object.fromEntries(
            quotaFields.map(([field]) => [field, limits[field].trim() ? Number(limits[field]) : null]),
          ) as ClientKey['limits'],
        })
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="edit-client-label">Name</Label>
        <Input
          id="edit-client-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          required
          maxLength={80}
          disabled={busy}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {quotaFields.map(([field, title]) => (
          <div key={field} className="space-y-2">
            <Label htmlFor={`quota-${field}`}>{title}</Label>
            <Input
              id={`quota-${field}`}
              type="number"
              min={1}
              step={1}
              value={limits[field]}
              onChange={(event) => setLimits((values) => ({ ...values, [field]: event.target.value }))}
              placeholder="Unlimited"
              disabled={busy}
            />
          </div>
        ))}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Leave a quota blank for unlimited use. Limits apply across every request made with this key.
      </p>
      <Button type="submit" disabled={busy || !label.trim()}>
        {busy ? 'Saving…' : 'Save changes'}
      </Button>
    </form>
  )
}

export default function ClientAccessPage() {
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(params.get('create') === '1')
  const [label, setLabel] = useState('')
  const [revealed, setRevealed] = useState<ClientKey | null>(null)
  const [editing, setEditing] = useState<ClientKey | null>(null)
  const query = useQuery<ClientKey[]>({
    queryKey: ['client-api-keys'],
    queryFn: ({ signal }) => apiFetch('/api/client-keys', { signal }),
  })
  const keys = query.data ?? []
  const legacy = useQuery<{
    endpoints: Array<{
      id: number
      name: string
      enabled: boolean
      basePath: string
      providerScopes: string[]
    }>
  }>({
    queryKey: ['local-endpoints'],
    queryFn: ({ signal }) => apiFetch('/api/settings/local-endpoints', { signal }),
    enabled: keys.some((key) => (key.localEndpointId ?? 0) > 1),
  })
  const selected = params.has('key') ? keys.find((key) => String(key.id) === params.get('key')) : keys[0]
  const legacyBound = (selected?.localEndpointId ?? 0) > 1
  const legacyEndpoint = legacy.data?.endpoints.find((endpoint) => endpoint.id === selected?.localEndpointId)
  const filtered = keys.filter((key) =>
    `${key.label} ${key.maskedKey}`.toLowerCase().includes(search.toLowerCase()),
  )
  const select = (id: number) => setParams({ key: String(id) }, { replace: true })
  const createKey = useMutation({
    mutationFn: (name: string) =>
      apiFetch<ClientKey>('/api/client-keys', { method: 'POST', body: JSON.stringify({ label: name }) }),
    onSuccess: (key) => {
      setCreateOpen(false)
      setLabel('')
      setRevealed(key)
      select(key.id)
      return invalidateRoutingQueries(queryClient)
    },
  })
  const updateKey = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: number
      body: { label?: string; enabled?: boolean; limits?: ClientKey['limits'] }
    }) => apiFetch<ClientKey>(`/api/client-keys/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    meta: { successMessage: 'Client key updated.' },
    onSuccess: () => {
      setEditing(null)
      return invalidateRoutingQueries(queryClient)
    },
  })
  const rotateKey = useMutation({
    mutationFn: (id: number) => apiFetch<ClientKey>(`/api/client-keys/${id}/rotate`, { method: 'POST' }),
    onSuccess: (key) => {
      setRevealed(key)
      return invalidateRoutingQueries(queryClient)
    },
  })
  const deleteKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/client-keys/${id}`, { method: 'DELETE' }),
    meta: { successMessage: 'Client key deleted.' },
    onSuccess: () => {
      setParams({}, { replace: true })
      return invalidateRoutingQueries(queryClient)
    },
  })
  const dismissSecret = () => {
    setRevealed(null)
    createKey.reset()
    rotateKey.reset()
  }
  return (
    <div>
      <PageHeader
        title="Client access"
        description="Give each app its own key, quota and access policy."
        actions={
          <Button
            onClick={() => {
              createKey.reset()
              setCreateOpen(true)
            }}
          >
            <Plus aria-hidden="true" />
            New client key
          </Button>
        }
      />
      {query.isLoading ? (
        <LoadingState title="Loading client access" />
      ) : query.isError ? (
        <ErrorState
          description={query.error.message}
          action={
            <Button variant="outline" onClick={() => query.refetch()}>
              Retry
            </Button>
          }
        />
      ) : (
        <div className="grid min-w-0 gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="min-w-0 space-y-4" aria-label="Client keys">
            <div className="panel-card overflow-hidden rounded-xl">
              <div className="space-y-3 p-4">
                <p className="flex items-center justify-between text-sm font-medium">
                  <span>Client keys</span>
                  <span className="text-xs text-muted-foreground">{keys.length}</span>
                </p>
                <SearchField
                  value={search}
                  onChange={setSearch}
                  label="Search client keys"
                  placeholder="Find an app or key…"
                />
              </div>
              <div className="max-h-[480px] overflow-y-auto border-t border-border">
                {filtered.map((key) => (
                  <button
                    key={key.id}
                    type="button"
                    aria-pressed={selected?.id === key.id}
                    onClick={() => select(key.id)}
                    className={cn(
                      'block w-full border-b border-border px-4 py-3 text-left outline-none last:border-b-0 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                      selected?.id === key.id && 'bg-primary/5 shadow-[inset_3px_0_0_var(--primary)]',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{key.label}</span>
                      <span
                        className={cn(
                          'size-1.5 shrink-0 rounded-full',
                          key.enabled ? 'bg-primary' : 'bg-muted-foreground',
                        )}
                        role="img"
                        aria-label={key.enabled ? 'Enabled' : 'Paused'}
                      />
                    </span>
                    <code className="mt-1 block truncate text-[11px] text-muted-foreground">
                      {key.maskedKey}
                    </code>
                  </button>
                ))}
                {!filtered.length ? (
                  <p className="px-4 py-6 text-sm text-muted-foreground">
                    {keys.length ? 'No keys match your search.' : 'Create a key to connect your first app.'}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="px-1 text-xs leading-6 text-muted-foreground">
              <KeyRound className="mb-2 size-4 text-primary" aria-hidden="true" />
              Client keys authenticate your apps to LLMHarbor.{' '}
              <NavLink to="/api-guide" className="text-primary underline underline-offset-2">
                Get SDK examples
              </NavLink>{' '}
              to connect an app.
            </div>
          </aside>
          <div className="min-w-0 space-y-5">
            {!selected ? (
              <EmptyState
                title={keys.length ? 'Choose a client key' : 'Connect your first app'}
                description={
                  params.has('key')
                    ? 'This key no longer exists. Select another key or create a new one.'
                    : 'Create a named key, save the secret once, and choose which providers it can use.'
                }
                action={<Button onClick={() => setCreateOpen(true)}>New client key</Button>}
              />
            ) : (
              <>
                <section className="panel-card rounded-xl p-5" aria-labelledby="selected-client-title">
                  <SectionTitle
                    id="selected-client-title"
                    title={selected.label}
                    description={selected.maskedKey}
                    action={
                      <div className="flex items-center gap-3">
                        <StatusIndicator
                          label={selected.enabled ? 'Enabled' : 'Paused'}
                          tone={selected.enabled ? 'positive' : 'neutral'}
                        />
                        <Switch
                          checked={selected.enabled}
                          disabled={updateKey.isPending}
                          onCheckedChange={(enabled) =>
                            updateKey.mutate({ id: selected.id, body: { enabled } })
                          }
                          aria-label={`${selected.enabled ? 'Pause' : 'Enable'} client key ${selected.label}`}
                        />
                      </div>
                    }
                  />
                  {!selected.enabled ? (
                    <InlineNotice tone="warning" className="mb-4">
                      Apps using this key cannot authenticate until you enable it again.
                    </InlineNotice>
                  ) : null}
                  {legacyBound ? (
                    <InlineNotice tone="warning" className="mb-4">
                      {legacyEndpoint ? (
                        <>
                          This legacy key uses <code>{legacyEndpoint.basePath}</code>.{' '}
                          {legacyEndpoint.enabled
                            ? 'Its endpoint provider scope also applies to the policy below.'
                            : 'The assigned endpoint is paused.'}
                        </>
                      ) : legacy.isLoading ? (
                        'Checking this key’s legacy endpoint…'
                      ) : (
                        'The assigned legacy endpoint is unavailable. Create a new client key to use /v1.'
                      )}
                    </InlineNotice>
                  ) : null}
                  <dl className="grid grid-cols-2 gap-4 border-y border-border py-4 sm:grid-cols-4">
                    {quotaFields.map(([field, name]) => (
                      <div key={field}>
                        <dt className="text-xs text-muted-foreground">{name}</dt>
                        <dd className="mt-1 font-mono text-sm">
                          {selected.limits[field]?.toLocaleString() ?? 'Unlimited'}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground" title={formatDateTime(selected.createdAt)}>
                      Created {formatRelativeTime(selected.createdAt)} · Used{' '}
                      {formatRelativeTime(selected.lastUsedAt)}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          updateKey.reset()
                          setEditing(selected)
                        }}
                      >
                        Edit name & quotas
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={rotateKey.isPending}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `Rotate ${selected.label}?`,
                              description:
                                'Apps using the current secret will stop working. Your quotas and access policy stay in place. Save the new secret and update those apps.',
                              confirmLabel: 'Rotate key',
                            })
                          )
                            rotateKey.mutate(selected.id)
                        }}
                      >
                        <RotateCw aria-hidden="true" />
                        Rotate
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={deleteKey.isPending || keys.length <= 1}
                        aria-label={`Delete client key ${selected.label}`}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `Delete ${selected.label}?`,
                              description:
                                'Apps using this client key will lose access immediately. Its saved quotas and access policy will be removed.',
                              confirmLabel: 'Delete key',
                            })
                          )
                            deleteKey.mutate(selected.id)
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                  <ErrorNotice error={updateKey.error ?? rotateKey.error ?? deleteKey.error} />
                </section>
                {legacyBound && legacy.isLoading ? (
                  <LoadingState title="Resolving legacy endpoint" />
                ) : (
                  <AccessPolicyEditor
                    key={selected.id}
                    clientId={selected.id}
                    legacyScope={legacyEndpoint?.providerScopes}
                    endpointUnavailable={legacyBound && !legacyEndpoint?.enabled}
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}
      <Modal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New client key"
        description="Create one key per app or environment. You can set quotas and access after creation."
        busy={createKey.isPending}
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            createKey.mutate(label.trim() || 'Client key')
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="new-client-label">Name</Label>
            <Input
              id="new-client-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={80}
              placeholder="e.g. Cursor · laptop"
              required
            />
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            The secret is shown once. Review access before sharing it with an app.
          </p>
          <ErrorNotice error={createKey.error} />
          <Button type="submit" disabled={createKey.isPending}>
            {createKey.isPending ? 'Creating…' : 'Create client key'}
          </Button>
        </form>
      </Modal>
      <Modal
        open={Boolean(revealed)}
        onOpenChange={async (value) => {
          if (
            !value &&
            (await confirm({
              title: 'Have you saved this key?',
              description:
                'This secret cannot be revealed again after closing. You can rotate it later if needed.',
              confirmLabel: 'Close',
              destructive: false,
            }))
          )
            dismissSecret()
        }}
        title="Save your client key"
        description={
          revealed ? `${revealed.label} is ready. Copy this secret now; it is only shown once.` : undefined
        }
      >
        {revealed?.key ? <CodeBlock code={revealed.key} label="Client API key" secret /> : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button onClick={dismissSecret}>I saved this key</Button>
        </div>
      </Modal>
      <Modal
        open={Boolean(editing)}
        onOpenChange={(value) => {
          if (!value) setEditing(null)
        }}
        title="Edit client key"
        description="Rename this key or set per-app quotas."
        busy={updateKey.isPending}
      >
        {editing ? (
          <KeyEditor
            key={editing.id}
            client={editing}
            busy={updateKey.isPending}
            onSave={(body) => updateKey.mutate({ id: editing.id, body })}
          />
        ) : null}
        <ErrorNotice error={updateKey.error} />
      </Modal>
    </div>
  )
}
