import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, useSearchParams, useNavigate } from 'react-router-dom'
import { Plus, Upload, Server, KeyRound, ArrowRight, Pencil, Trash2, RefreshCw } from 'lucide-react'
import type { ApiKey } from '../../../shared/types'
import type { ProviderSummary } from '@/lib/contracts'
import { apiFetch } from '@/lib/api'
import { notify, useConfirm } from '@/lib/feedback'
import { invalidateRoutingQueries } from '@/lib/query-cache'
import { formatRelativeTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Modal } from '@/components/ui/modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader, SectionTitle, EmptyState, ErrorState, LoadingState } from '@/components/page-header'
import { SearchField, Pagination } from '@/components/collection-controls'
import { SectionTabs } from '@/components/section-tabs'
import { ErrorNotice } from '@/components/error-notice'
import { StatusIndicator } from '@/components/status-indicator'

const statusLabels = {
  healthy: 'Healthy',
  unknown: 'Unchecked',
  invalid: 'Invalid key',
  error: 'Check failed',
  rate_limited: 'Rate limited',
}
type EndpointDraft = {
  name: string
  baseUrl: string
  validateUrl: string
  timeoutSeconds: string
  apiKey: string
}
const emptyEndpoint = (): EndpointDraft => ({
  name: '',
  baseUrl: '',
  validateUrl: '',
  timeoutSeconds: '120',
  apiKey: '',
})

export default function ProvidersPage() {
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [view, setView] = useState<'configured' | 'all'>('configured')
  const [search, setSearch] = useState('')
  const [keySearch, setKeySearch] = useState('')
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<'key' | 'endpoint' | 'import' | 'edit-key' | null>(
    params.get('add') === 'endpoint' ? 'endpoint' : params.get('add') === 'key' ? 'key' : null,
  )
  const [target, setTarget] = useState('')
  const [secret, setSecret] = useState('')
  const [label, setLabel] = useState('')
  const [accountId, setAccountId] = useState('')
  const [endpoint, setEndpoint] = useState(emptyEndpoint)
  const [editingEndpoint, setEditingEndpoint] = useState<ProviderSummary | null>(null)
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null)
  const [fileContents, setFileContents] = useState('')
  const [fileName, setFileName] = useState('')
  const [fileError, setFileError] = useState<Error | null>(null)
  const fileRead = useRef(0)
  const providers = useQuery<ProviderSummary[]>({
    queryKey: ['custom-endpoints'],
    queryFn: ({ signal }) => apiFetch('/api/providers', { signal }),
  })
  const keys = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: ({ signal }) => apiFetch('/api/provider-keys', { signal }),
    refetchInterval: 30_000,
  })
  const allProviders = providers.data ?? []
  const configured = allProviders.filter((provider) => provider.configuredKeyCount > 0 || provider.custom)
  const visible = (view === 'all' ? allProviders : configured).filter((provider) =>
    `${provider.name} ${provider.baseUrl ?? ''} ${provider.platform}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  )
  const selected =
    allProviders.find((provider) => provider.platform === params.get('provider')) ?? configured[0]
  const manualProviders = allProviders.filter((provider) => provider.credentialMode !== 'oauth')
  const filteredKeys = (keys.data ?? []).filter(
    (key) =>
      key.platform === selected?.platform &&
      `${key.label} ${key.maskedKey}`.toLowerCase().includes(keySearch.toLowerCase()),
  )
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filteredKeys.length / 10)))
  const refresh = () => invalidateRoutingQueries(queryClient)
  function closeDialog() {
    fileRead.current++
    setDialog(null)
    setSecret('')
    setAccountId('')
    setLabel('')
    setFileContents('')
    setFileName('')
    setFileError(null)
    setEditingEndpoint(null)
    setEditingKey(null)
    setParams(
      (current) => {
        current.delete('add')
        return current
      },
      { replace: true },
    )
  }
  const saveKey = useMutation({
    mutationFn: (body: { platform: string; key: string; label?: string }) =>
      apiFetch('/api/provider-keys', { method: 'POST', body: JSON.stringify(body) }),
    meta: { successMessage: 'Provider key added. Open Models to test a route.' },
    onSuccess: (_data, variables) => {
      closeDialog()
      setParams({ provider: variables.platform })
      return refresh()
    },
  })
  const saveEndpoint = useMutation({
    mutationFn: ({ draft, platform }: { draft: EndpointDraft; platform?: string }) =>
      apiFetch<ProviderSummary>(
        platform ? `/api/providers/${encodeURIComponent(platform)}` : '/api/providers',
        {
          method: platform ? 'PATCH' : 'POST',
          body: JSON.stringify({
            name: draft.name.trim(),
            baseUrl: draft.baseUrl.trim(),
            validateUrl: draft.validateUrl.trim() || null,
            timeoutMs: Number(draft.timeoutSeconds) * 1000,
            ...(!platform ? { apiKey: draft.apiKey.trim() } : {}),
          }),
        },
      ),
    meta: { successMessage: 'Endpoint saved. Register and test its models next.' },
    onSuccess: (result) => {
      closeDialog()
      setParams({ provider: result.platform })
      return refresh()
    },
  })
  const updateKey = useMutation({
    mutationFn: ({ id, body }: { id: number; body: { enabled?: boolean; label?: string; key?: string } }) =>
      apiFetch(`/api/provider-keys/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    meta: { successMessage: 'Credential updated.' },
    onSuccess: () => {
      closeDialog()
      return refresh()
    },
  })
  const removeKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/provider-keys/${id}`, { method: 'DELETE' }),
    meta: { successMessage: 'Credential deleted.' },
    onSuccess: refresh,
  })
  const checkKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/health/check/${id}`, { method: 'POST' }),
    meta: { successMessage: 'Credential health refreshed.' },
    onSuccess: refresh,
  })
  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST', timeoutMs: 300_000 }),
    meta: { successMessage: 'Credential checks complete.' },
    onSuccess: refresh,
  })
  const pauseProvider = useMutation({
    mutationFn: ({ provider, enabled }: { provider: ProviderSummary; enabled: boolean }) =>
      apiFetch(
        provider.custom
          ? `/api/providers/${provider.platform}`
          : `/api/provider-keys/platform/${provider.platform}`,
        { method: 'PATCH', body: JSON.stringify({ enabled }) },
      ),
    meta: { successMessage: 'Provider routing updated.' },
    onSuccess: refresh,
  })
  const removeEndpoint = useMutation({
    mutationFn: (platform: string) => apiFetch(`/api/providers/${platform}`, { method: 'DELETE' }),
    meta: { successMessage: 'Custom endpoint removed.' },
    onSuccess: () => {
      setParams({})
      return refresh()
    },
  })
  const bulkImport = useMutation({
    mutationFn: () =>
      apiFetch<{ imported: number; skipped: number }>('/api/provider-keys/import', {
        method: 'POST',
        body: JSON.stringify({ platform: target, contents: fileContents, labelPrefix: label || undefined }),
      }),
    onSuccess: (result) => {
      closeDialog()
      notify(`${result.imported} keys imported; ${result.skipped} duplicates skipped.`)
      return refresh()
    },
  })
  function openKey(platform = '') {
    saveKey.reset()
    setTarget(platform)
    setDialog('key')
  }
  function providerSelect(kind = 'key') {
    const labelId = `credential-provider-${kind}`
    return (
      <div className="space-y-2">
        <Label id={labelId}>Provider</Label>
        <Select value={target} onValueChange={(value) => setTarget(value ?? '')}>
          <SelectTrigger className="w-full" aria-labelledby={labelId}>
            <SelectValue>
              {manualProviders.find((provider) => provider.platform === target)?.name ?? 'Choose a provider'}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {manualProviders.map((provider) => (
              <SelectItem key={provider.platform} value={provider.platform}>
                {provider.name}
                {provider.custom ? ' · custom' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }
  const busy = saveKey.isPending || saveEndpoint.isPending || bulkImport.isPending || updateKey.isPending
  return (
    <div>
      <PageHeader
        title="Providers"
        description="Connect upstream APIs, local models and private gateways."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => {
                saveEndpoint.reset()
                setEndpoint(emptyEndpoint())
                setDialog('endpoint')
              }}
            >
              <Server aria-hidden="true" />
              Custom endpoint
            </Button>
            <Button onClick={() => openKey()}>
              <Plus aria-hidden="true" />
              Add provider key
            </Button>
          </>
        }
      />
      {providers.isError ? (
        <ErrorState
          title="Providers unavailable"
          description={providers.error.message}
          action={
            <Button variant="outline" onClick={() => providers.refetch()}>
              Retry
            </Button>
          }
        />
      ) : providers.isLoading ? (
        <LoadingState title="Loading providers" />
      ) : (
        <div className="space-y-6">
          <div className="panel-card overflow-hidden rounded-xl">
            <div className="space-y-4 p-5">
              <SectionTabs
                label="Provider view"
                value={view}
                onChange={setView}
                items={[
                  { value: 'configured', label: 'Configured', count: configured.length },
                  { value: 'all', label: 'All providers', count: allProviders.length },
                ]}
              />
              <div className="flex flex-wrap gap-3">
                <SearchField
                  value={search}
                  onChange={setSearch}
                  label="Search providers"
                  placeholder="Search by name or endpoint…"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    bulkImport.reset()
                    setTarget(selected?.credentialMode !== 'oauth' ? (selected?.platform ?? '') : '')
                    setDialog('import')
                  }}
                >
                  <Upload aria-hidden="true" />
                  Import keys
                </Button>
                {(keys.data?.length ?? 0) > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={checkAll.isPending}
                    onClick={() => checkAll.mutate()}
                  >
                    <RefreshCw className={checkAll.isPending ? 'animate-spin' : ''} aria-hidden="true" />
                    {checkAll.isPending ? 'Checking…' : 'Check all'}
                  </Button>
                ) : null}
              </div>
            </div>
            {!visible.length ? (
              <div className="px-5 pb-5">
                <EmptyState
                  title={search ? 'No matching providers' : 'Connect your first provider'}
                  description={
                    search
                      ? 'Try another name or show all providers.'
                      : 'Add an API key, connect an OAuth account, or add your local endpoint.'
                  }
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button onClick={() => openKey()}>Add API key</Button>
                      <Button variant="outline" render={<NavLink to="/oauth" />}>
                        Connect OAuth
                      </Button>
                    </div>
                  }
                />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Provider</TableHead>
                    <TableHead>Connection</TableHead>
                    <TableHead>Credentials</TableHead>
                    <TableHead className="text-right">Models</TableHead>
                    <TableHead className="pr-5 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((provider) => (
                    <TableRow
                      key={provider.platform}
                      data-state={selected?.platform === provider.platform ? 'selected' : undefined}
                    >
                      <TableCell className="max-w-[340px] pl-5">
                        <button
                          className="text-left text-sm font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
                          onClick={() => {
                            setParams({ provider: provider.platform })
                            setPage(1)
                            setKeySearch('')
                          }}
                        >
                          {provider.name}
                        </button>
                        <p
                          className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                          title={provider.baseUrl ?? provider.platform}
                        >
                          {provider.baseUrl ?? provider.platform}
                        </p>
                      </TableCell>
                      <TableCell>
                        <StatusIndicator
                          label={
                            !provider.enabled ||
                            (provider.configuredKeyCount > 0 && !provider.enabledKeyCount)
                              ? 'Paused'
                              : provider.availableKeyCount
                                ? 'Connected'
                                : provider.configuredKeyCount
                                  ? 'Needs attention'
                                  : 'Not configured'
                          }
                          tone={
                            !provider.enabled || !provider.enabledKeyCount
                              ? 'neutral'
                              : provider.availableKeyCount
                                ? 'positive'
                                : 'warning'
                          }
                        />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {provider.availableKeyCount} usable / {provider.configuredKeyCount}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">{provider.modelCount}</TableCell>
                      <TableCell className="pr-5">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="outline"
                            size="xs"
                            render={
                              <NavLink to={`/models?provider=${encodeURIComponent(provider.platform)}`} />
                            }
                          >
                            Models
                          </Button>
                          {provider.credentialMode === 'oauth' ? (
                            <Button variant="ghost" size="xs" render={<NavLink to="/oauth" />}>
                              Accounts
                            </Button>
                          ) : (
                            <Button variant="ghost" size="xs" onClick={() => openKey(provider.platform)}>
                              Add key
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
          {selected ? (
            <section
              className="panel-card overflow-hidden rounded-xl"
              aria-label={`${selected.name} credentials`}
            >
              <div className="space-y-4 p-5">
                <SectionTitle
                  title={selected.name}
                  description="Credentials and connection settings for this provider."
                  action={
                    <div className="flex flex-wrap gap-2">
                      {selected.custom ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            saveEndpoint.reset()
                            setEditingEndpoint(selected)
                            setEndpoint({
                              name: selected.name,
                              baseUrl: selected.baseUrl ?? '',
                              validateUrl: selected.validateUrl ?? '',
                              timeoutSeconds: String(selected.timeoutMs / 1000),
                              apiKey: '',
                            })
                            setDialog('endpoint')
                          }}
                        >
                          <Pencil aria-hidden="true" />
                          Edit endpoint
                        </Button>
                      ) : null}
                      {selected.configuredKeyCount > 0 ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pauseProvider.isPending}
                          onClick={() =>
                            pauseProvider.mutate({
                              provider: selected,
                              enabled: !(selected.custom ? selected.enabled : selected.enabledKeyCount > 0),
                            })
                          }
                        >
                          {(selected.custom ? selected.enabled : selected.enabledKeyCount > 0)
                            ? 'Pause provider'
                            : 'Enable provider'}
                        </Button>
                      ) : null}
                      {selected.custom ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={removeEndpoint.isPending}
                          aria-label={`Remove ${selected.name}`}
                          onClick={async () => {
                            if (
                              await confirm({
                                title: `Remove ${selected.name}?`,
                                description: `This removes the endpoint, ${selected.modelCount} registered models and ${selected.configuredKeyCount} credentials. Apps will use other eligible routes.`,
                                confirmLabel: 'Remove endpoint',
                              })
                            )
                              removeEndpoint.mutate(selected.platform)
                          }}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      ) : null}
                    </div>
                  }
                />
                <SearchField
                  value={keySearch}
                  onChange={(value) => {
                    setKeySearch(value)
                    setPage(1)
                  }}
                  label="Search provider credentials"
                  placeholder="Find a credential by label…"
                />
                <ErrorNotice
                  error={
                    keys.error ??
                    removeKey.error ??
                    pauseProvider.error ??
                    removeEndpoint.error ??
                    checkKey.error
                  }
                />
              </div>
              {keys.isLoading ? (
                <LoadingState title="Loading credentials" />
              ) : !filteredKeys.length ? (
                <div className="px-5 pb-5">
                  <EmptyState
                    title={keySearch ? 'No matching credentials' : 'No credentials yet'}
                    description="Add a provider key or connect a browser account to make models available."
                    action={
                      <Button
                        onClick={() =>
                          selected.credentialMode === 'oauth'
                            ? navigate('/oauth')
                            : openKey(selected.platform)
                        }
                      >
                        Connect provider
                      </Button>
                    }
                  />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-5">Credential</TableHead>
                      <TableHead>Health</TableHead>
                      <TableHead>Last checked</TableHead>
                      <TableHead className="pr-5 text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredKeys.slice((currentPage - 1) * 10, currentPage * 10).map((key) => (
                      <TableRow key={key.id}>
                        <TableCell className="pl-5">
                          <p className="text-sm font-medium">{key.label || `Key #${key.id}`}</p>
                          <code className="mt-1 block text-xs text-muted-foreground">{key.maskedKey}</code>
                        </TableCell>
                        <TableCell>
                          <StatusIndicator
                            label={!key.enabled ? 'Paused' : statusLabels[key.status]}
                            tone={
                              !key.enabled
                                ? 'neutral'
                                : key.status === 'healthy'
                                  ? 'positive'
                                  : ['invalid', 'error'].includes(key.status)
                                    ? 'critical'
                                    : 'neutral'
                            }
                          />
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatRelativeTime(key.lastCheckedAt)}
                        </TableCell>
                        <TableCell className="pr-5">
                          <div className="flex items-center justify-end gap-2">
                            {key.source === 'oauth' ? (
                              <Button
                                variant="outline"
                                size="xs"
                                render={<NavLink to={`/oauth?account=${key.oauthAccountId}`} />}
                              >
                                Manage account
                              </Button>
                            ) : (
                              <>
                                <Button
                                  variant="outline"
                                  size="xs"
                                  disabled={checkKey.isPending && checkKey.variables === key.id}
                                  onClick={() => checkKey.mutate(key.id)}
                                >
                                  {checkKey.isPending && checkKey.variables === key.id
                                    ? 'Checking…'
                                    : 'Check'}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label={`Edit credential ${key.label || key.id}`}
                                  onClick={() => {
                                    updateKey.reset()
                                    setEditingKey(key)
                                    setLabel(key.label)
                                    setSecret('')
                                    setDialog('edit-key')
                                  }}
                                >
                                  <Pencil aria-hidden="true" />
                                </Button>
                              </>
                            )}
                            <Switch
                              checked={key.enabled}
                              disabled={updateKey.isPending}
                              onCheckedChange={(enabled) =>
                                updateKey.mutate({ id: key.id, body: { enabled } })
                              }
                              aria-label={`${key.enabled ? 'Pause' : 'Enable'} credential ${key.label || key.id}`}
                            />
                            {key.source !== 'oauth' ? (
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                disabled={removeKey.isPending}
                                aria-label={`Delete credential ${key.label || key.id}`}
                                onClick={async () => {
                                  if (
                                    await confirm({
                                      title: 'Delete this credential?',
                                      description: `${key.label || 'This key'} will stop serving requests through ${selected.name}. Other credentials remain available.`,
                                      confirmLabel: 'Delete credential',
                                    })
                                  )
                                    removeKey.mutate(key.id)
                                }}
                              >
                                <Trash2 aria-hidden="true" />
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <Pagination
                page={currentPage}
                pageSize={10}
                total={filteredKeys.length}
                onPageChange={setPage}
              />
            </section>
          ) : null}
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <KeyRound className="size-4" aria-hidden="true" />
            Need a key for your app to call LLMHarbor?
            <NavLink
              to="/access"
              className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
            >
              Open Client access
              <ArrowRight className="size-3" aria-hidden="true" />
            </NavLink>
          </p>
        </div>
      )}
      <Modal
        open={dialog === 'key'}
        onOpenChange={(value) => {
          if (!value) closeDialog()
        }}
        title="Add provider key"
        description="Choose the upstream provider and paste its API credential."
        busy={busy}
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            saveKey.mutate({
              platform: target,
              key: target === 'cloudflare' ? `${accountId.trim()}:${secret.trim()}` : secret.trim(),
              label: label.trim() || undefined,
            })
          }}
        >
          {providerSelect()}
          {target === 'cloudflare' ? (
            <div className="space-y-2">
              <Label htmlFor="cloudflare-account">Cloudflare account ID</Label>
              <Input
                id="cloudflare-account"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                required
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="provider-secret">API key</Label>
            <Input
              id="provider-secret"
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              required
              placeholder="Paste provider credential"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="provider-label">
              Label <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="provider-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={80}
              placeholder="e.g. Personal account"
            />
          </div>
          <ErrorNotice error={saveKey.error} />
          <Button type="submit" disabled={!target || !secret.trim() || busy}>
            {busy ? 'Saving…' : 'Add key'}
          </Button>
        </form>
      </Modal>
      <Modal
        open={dialog === 'endpoint'}
        onOpenChange={(value) => {
          if (!value) closeDialog()
        }}
        title={editingEndpoint ? 'Edit endpoint' : 'Connect a custom endpoint'}
        description="Connect an OpenAI-compatible server such as Ollama, vLLM or a private gateway."
        busy={busy}
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            saveEndpoint.mutate({ draft: endpoint, platform: editingEndpoint?.platform })
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="endpoint-name">Name</Label>
            <Input
              id="endpoint-name"
              value={endpoint.name}
              onChange={(event) => setEndpoint((value) => ({ ...value, name: event.target.value }))}
              maxLength={80}
              required
              placeholder="Local Ollama"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="endpoint-url">Base URL</Label>
            <Input
              id="endpoint-url"
              type="url"
              value={endpoint.baseUrl}
              onChange={(event) => setEndpoint((value) => ({ ...value, baseUrl: event.target.value }))}
              required
              placeholder="http://localhost:11434/v1"
            />
            <p className="text-xs text-muted-foreground">
              Include the API prefix, usually /v1. Do not include /chat/completions.
            </p>
          </div>
          {!editingEndpoint ? (
            <div className="space-y-2">
              <Label htmlFor="endpoint-secret">
                API key <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="endpoint-secret"
                type="password"
                autoComplete="off"
                value={endpoint.apiKey}
                onChange={(event) => setEndpoint((value) => ({ ...value, apiKey: event.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Leave blank for a local server that does not require authentication.
              </p>
            </div>
          ) : null}
          <details className="rounded-lg border border-border">
            <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium">
              Advanced connection options
            </summary>
            <div className="space-y-4 border-t border-border p-3">
              <div className="space-y-2">
                <Label htmlFor="endpoint-timeout">Response timeout (seconds)</Label>
                <Input
                  id="endpoint-timeout"
                  type="number"
                  min={1}
                  max={600}
                  step={1}
                  value={endpoint.timeoutSeconds}
                  onChange={(event) =>
                    setEndpoint((value) => ({ ...value, timeoutSeconds: event.target.value }))
                  }
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endpoint-validation">
                  Validation URL <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="endpoint-validation"
                  type="url"
                  value={endpoint.validateUrl}
                  onChange={(event) =>
                    setEndpoint((value) => ({ ...value, validateUrl: event.target.value }))
                  }
                  placeholder="Defaults to the endpoint’s /models route"
                />
              </div>
            </div>
          </details>
          <ErrorNotice error={saveEndpoint.error} />
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : editingEndpoint ? 'Save endpoint' : 'Connect endpoint'}
          </Button>
        </form>
      </Modal>
      <Modal
        open={dialog === 'import'}
        onOpenChange={(value) => {
          if (!value) closeDialog()
        }}
        title="Import provider keys"
        description="Upload a text file with one key per line. Blank lines and # comments are ignored; duplicates are skipped."
        busy={busy}
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            bulkImport.mutate()
          }}
        >
          {providerSelect('import')}
          <div className="space-y-2">
            <Label htmlFor="import-file">Key file</Label>
            <Input
              id="import-file"
              type="file"
              accept=".txt,text/plain"
              onChange={async (event) => {
                const file = event.target.files?.[0]
                const generation = ++fileRead.current
                setFileContents('')
                setFileName(file?.name ?? '')
                setFileError(null)
                if (!file) return
                try {
                  if (file.size > 250_000)
                    throw new Error('Use a text file up to 250 KB. Split larger imports into separate files.')
                  const text = await file.text()
                  if (fileRead.current === generation) setFileContents(text)
                } catch (error) {
                  if (fileRead.current === generation)
                    setFileError(error instanceof Error ? error : new Error('Could not read the file.'))
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              {fileName
                ? `${fileName} · ${fileContents.split(/\r\n|\n|\r/).filter((line) => line.trim() && !line.trim().startsWith('#')).length} key lines`
                : 'Maximum 250 KB and 5,000 unique keys per import.'}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="import-prefix">
              Label prefix <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="import-prefix"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={80}
              placeholder="Personal pool"
            />
          </div>
          <ErrorNotice error={fileError ?? bulkImport.error} />
          <Button type="submit" disabled={busy || !target || !fileContents.trim()}>
            {busy ? 'Importing…' : 'Import keys'}
          </Button>
        </form>
      </Modal>
      <Modal
        open={dialog === 'edit-key'}
        onOpenChange={(value) => {
          if (!value) closeDialog()
        }}
        title="Edit provider credential"
        description="Rename this credential or replace its secret without removing model configuration."
        busy={busy}
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (editingKey)
              updateKey.mutate({
                id: editingKey.id,
                body: { label: label.trim(), ...(secret.trim() ? { key: secret.trim() } : {}) },
              })
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="edit-provider-label">Label</Label>
            <Input
              id="edit-provider-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={80}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="replace-provider-secret">
              New API key <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="replace-provider-secret"
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="Leave blank to keep the current credential"
            />
          </div>
          <ErrorNotice error={updateKey.error} />
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save credential'}
          </Button>
        </form>
      </Modal>
    </div>
  )
}
