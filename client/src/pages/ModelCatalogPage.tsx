import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, useSearchParams } from 'react-router-dom'
import { Plus, Play, Pencil, Trash2, Copy } from 'lucide-react'
import type { CatalogModel, ProviderSummary } from '@/lib/contracts'
import { apiFetch } from '@/lib/api'
import { useConfirm, notify } from '@/lib/feedback'
import { copyText } from '@/lib/clipboard'
import { invalidateRoutingQueries } from '@/lib/query-cache'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Modal } from '@/components/ui/modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader, LoadingState, EmptyState, ErrorState } from '@/components/page-header'
import { SearchField, Pagination } from '@/components/collection-controls'
import { StatusIndicator, InlineNotice } from '@/components/status-indicator'
import { ErrorNotice } from '@/components/error-notice'
import { ModelEditor, type ModelSettings } from '@/components/model-editor'

interface ProbeResult {
  ok: boolean
  platform: string
  modelId: string
  latencyMs?: number
  sample?: string
  message?: string
}

export default function ModelCatalogPage() {
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const [params, setParams] = useSearchParams()
  const providerFilter = params.get('provider') ?? 'configured'
  const search = params.get('search') ?? ''
  const [routedOnly, setRoutedOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [adding, setAdding] = useState(false)
  const [target, setTarget] = useState('')
  const [modelId, setModelId] = useState('')
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<CatalogModel | null>(null)
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const providers = useQuery<ProviderSummary[]>({
    queryKey: ['custom-endpoints'],
    queryFn: ({ signal }) => apiFetch('/api/providers', { signal }),
  })
  const models = useQuery<CatalogModel[]>({
    queryKey: ['models'],
    queryFn: ({ signal }) => apiFetch('/api/models', { signal }),
  })
  const allProviders = providers.data ?? []
  const configured = new Set(
    allProviders.filter((provider) => provider.configuredKeyCount > 0).map((provider) => provider.platform),
  )
  const filtered = (models.data ?? []).filter(
    (model) =>
      (providerFilter === 'all' ||
        providerFilter === model.platform ||
        (providerFilter === 'configured' && configured.has(model.platform))) &&
      (!routedOnly || model.fallbackEnabled) &&
      `${model.displayName} ${model.modelId} ${model.platform}`.toLowerCase().includes(search.toLowerCase()),
  )
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / 20)))
  const refresh = () => invalidateRoutingQueries(queryClient)
  function filter(key: string, value: string) {
    setPage(1)
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (value) next.set(key, value)
        else next.delete(key)
        return next
      },
      { replace: true },
    )
  }
  const add = useMutation({
    mutationFn: () =>
      apiFetch(`/api/providers/${target}/models`, {
        method: 'POST',
        body: JSON.stringify({ modelId: modelId.trim(), displayName: name.trim() || modelId.trim() }),
      }),
    meta: { successMessage: 'Model registered. Test it, then enable its route.' },
    onSuccess: () => {
      setAdding(false)
      setModelId('')
      setName('')
      filter('provider', target)
      return refresh()
    },
  })
  const update = useMutation({
    mutationFn: ({ model, settings }: { model: CatalogModel; settings: Partial<ModelSettings> }) =>
      apiFetch(`/api/providers/${model.platform}/models/${model.id}`, {
        method: 'PATCH',
        body: JSON.stringify(settings),
      }),
    meta: { successMessage: 'Model settings saved.' },
    onSuccess: () => {
      setEditing(null)
      return refresh()
    },
  })
  const route = useMutation({
    mutationFn: ({ model, enabled }: { model: CatalogModel; enabled: boolean }) =>
      apiFetch(`/api/routing/models/${model.id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    meta: { successMessage: 'Model routing updated.' },
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: (model: CatalogModel) =>
      apiFetch(`/api/providers/${model.platform}/models/${model.id}`, { method: 'DELETE' }),
    meta: { successMessage: 'Model removed.' },
    onSuccess: refresh,
  })
  const testModel = useMutation({
    mutationFn: (model: CatalogModel) =>
      apiFetch<ProbeResult>(`/api/providers/${model.platform}/models/probe`, {
        method: 'POST',
        body: JSON.stringify({ modelId: model.modelId }),
        timeoutMs:
          Math.max(
            240_000,
            (allProviders.find((provider) => provider.platform === model.platform)?.timeoutMs ?? 120_000) * 2,
          ) + 15_000,
      }),
    onSuccess: (result) => {
      setProbe(result)
      notify(`Model probe passed in ${result.latencyMs ?? 0} ms.`)
    },
    onError: (error, model) =>
      setProbe({ ok: false, platform: model.platform, modelId: model.modelId, message: error.message }),
  })
  const failed = models.error ?? providers.error
  return (
    <div>
      <PageHeader
        title="Models"
        description="Find a model, verify its connection, and enable it for your apps."
        actions={
          <Button
            onClick={() => {
              add.reset()
              setTarget(
                allProviders.some((provider) => provider.platform === providerFilter)
                  ? providerFilter
                  : (allProviders.find((provider) => provider.configuredKeyCount > 0)?.platform ?? ''),
              )
              setAdding(true)
            }}
          >
            <Plus aria-hidden="true" />
            Register model
          </Button>
        }
      />
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
          <span>
            <strong className="font-mono font-medium text-foreground">{models.data?.length ?? 0}</strong>{' '}
            registered
          </span>
          <span>
            <strong className="font-mono font-medium text-foreground">
              {models.data?.filter((model) => model.enabled && model.fallbackEnabled).length ?? 0}
            </strong>{' '}
            enabled in routing
          </span>
          <NavLink to="/fallback" className="ml-auto text-primary">
            Manage routing order →
          </NavLink>
        </div>
        <div className="panel-card overflow-hidden rounded-xl">
          <div className="flex flex-wrap gap-3 p-5">
            <SearchField
              value={search}
              onChange={(value) => filter('search', value)}
              label="Search models"
              placeholder="Search name, model ID or provider…"
            />
            <Select
              value={providerFilter}
              onValueChange={(value) => filter('provider', value ?? 'configured')}
            >
              <SelectTrigger aria-label="Filter models by provider">
                <SelectValue>
                  {providerFilter === 'configured'
                    ? 'Configured providers'
                    : providerFilter === 'all'
                      ? 'All providers'
                      : (allProviders.find((provider) => provider.platform === providerFilter)?.name ??
                        providerFilter)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="configured">Configured providers</SelectItem>
                <SelectItem value="all">All providers</SelectItem>
                {allProviders.map((provider) => (
                  <SelectItem key={provider.platform} value={provider.platform}>
                    {provider.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant={routedOnly ? 'secondary' : 'outline'}
              aria-pressed={routedOnly}
              onClick={() => {
                setRoutedOnly((value) => !value)
                setPage(1)
              }}
            >
              Routed only
            </Button>
          </div>
          {failed ? (
            <div className="p-5 pt-0">
              <ErrorState
                title="Model catalog unavailable"
                description={failed.message}
                action={
                  <Button
                    variant="outline"
                    onClick={() => {
                      void models.refetch()
                      void providers.refetch()
                    }}
                  >
                    Retry
                  </Button>
                }
              />
            </div>
          ) : models.isLoading || providers.isLoading ? (
            <LoadingState title="Loading catalog" />
          ) : !filtered.length ? (
            <div className="p-5 pt-0">
              <EmptyState
                title="No models in this view"
                description={
                  configured.size
                    ? 'Adjust your filters or register a model for this provider.'
                    : 'Connect a provider to start using its models.'
                }
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setParams({ provider: 'all' })
                        setRoutedOnly(false)
                      }}
                    >
                      Show all models
                    </Button>
                    <Button render={<NavLink to="/providers" />}>Connect provider</Button>
                  </div>
                }
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Model</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Context</TableHead>
                  <TableHead>Routing</TableHead>
                  <TableHead className="pr-5 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.slice((currentPage - 1) * 20, currentPage * 20).map((model) => {
                  const provider = allProviders.find((item) => item.platform === model.platform)
                  const canProbe = provider?.enabled && provider.availableKeyCount > 0
                  return (
                    <TableRow key={model.id}>
                      <TableCell className="max-w-[330px] pl-5">
                        <p className="truncate font-medium" title={model.displayName}>
                          {model.displayName}
                        </p>
                        <div className="mt-0.5 flex items-center gap-1">
                          <code
                            className="truncate text-xs text-muted-foreground"
                            title={`${model.platform}/${model.modelId}`}
                          >
                            {model.modelId}
                          </code>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Copy model ID ${model.modelId}`}
                            onClick={async () => {
                              try {
                                await copyText(`${model.platform}/${model.modelId}`)
                                notify('Model ID copied.')
                              } catch {
                                notify('Could not copy the model ID.', 'error')
                              }
                            }}
                          >
                            <Copy className="size-3" aria-hidden="true" />
                          </Button>
                        </div>
                        {!model.enabled ? (
                          <p className="text-[11px] text-muted-foreground">
                            Catalog disabled · enable under Edit
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {provider?.name ?? model.platform}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {model.contextWindow ? Math.round(model.contextWindow / 1000) + 'K' : '—'}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={model.fallbackEnabled}
                            disabled={!model.enabled || route.isPending}
                            onCheckedChange={(enabled) => route.mutate({ model, enabled })}
                            aria-label={`${model.fallbackEnabled ? 'Disable' : 'Enable'} routing for ${model.displayName}`}
                          />
                          <span className="text-xs text-muted-foreground">
                            {model.fallbackEnabled ? 'On' : 'Off'}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="pr-5">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!canProbe || testModel.isPending}
                            title={
                              canProbe
                                ? 'Send a short probe using this provider’s credential'
                                : 'Connect an enabled, usable provider credential first'
                            }
                            onClick={() => {
                              setProbe(null)
                              testModel.mutate(model)
                            }}
                            aria-label={`Test ${model.displayName}`}
                          >
                            <Play aria-hidden="true" />
                            {testModel.isPending && testModel.variables.id === model.id ? 'Testing…' : 'Test'}
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Edit ${model.displayName}`}
                            onClick={() => {
                              update.reset()
                              setEditing(model)
                            }}
                          >
                            <Pencil aria-hidden="true" />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            disabled={remove.isPending}
                            aria-label={`Remove ${model.displayName}`}
                            onClick={async () => {
                              if (
                                await confirm({
                                  title: `Remove ${model.displayName}?`,
                                  description:
                                    'This model and its routing entry will be removed. Request history remains available.',
                                  confirmLabel: 'Remove model',
                                })
                              )
                                remove.mutate(model)
                            }}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
          <Pagination page={currentPage} pageSize={20} total={filtered.length} onPageChange={setPage} />
        </div>
        {testModel.isPending ? (
          <InlineNotice>
            Testing {testModel.variables.displayName}. The provider’s configured timeout applies.
          </InlineNotice>
        ) : null}
        <Modal
          open={Boolean(probe) && !editing && !adding}
          onOpenChange={(value) => {
            if (!value) setProbe(null)
          }}
          title="Model probe"
          description="The result of a short request to this model."
        >
          {probe ? (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <StatusIndicator
                    label={probe.ok ? 'Probe passed' : 'Probe failed'}
                    tone={probe.ok ? 'positive' : 'critical'}
                  />
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {probe.platform}/{probe.modelId}
                    {probe.latencyMs !== undefined ? ` · ${probe.latencyMs} ms` : ''}
                  </p>
                </div>
                {probe.ok &&
                (models.data ?? []).some(
                  (model) =>
                    model.platform === probe.platform &&
                    model.modelId === probe.modelId &&
                    !model.fallbackEnabled &&
                    model.enabled,
                ) ? (
                  <Button
                    disabled={route.isPending}
                    onClick={() => {
                      const model = models.data?.find(
                        (model) => model.platform === probe.platform && model.modelId === probe.modelId,
                      )
                      if (model) route.mutate({ model, enabled: true })
                    }}
                  >
                    Enable this route
                  </Button>
                ) : null}
              </div>
              <p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                {probe.sample ?? probe.message}
              </p>
            </div>
          ) : null}
        </Modal>
        <ErrorNotice error={route.error ?? remove.error} />
      </div>
      <Modal
        open={adding}
        onOpenChange={setAdding}
        title="Register a model"
        description="Use the model ID advertised by your provider. New routes start disabled until you enable them."
        busy={add.isPending}
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            add.mutate()
          }}
        >
          <div className="space-y-2">
            <Label id="model-provider-label">Provider</Label>
            <Select value={target} onValueChange={(value) => setTarget(value ?? '')}>
              <SelectTrigger className="w-full" aria-labelledby="model-provider-label">
                <SelectValue>
                  {allProviders.find((provider) => provider.platform === target)?.name ?? 'Choose a provider'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {allProviders.map((provider) => (
                  <SelectItem key={provider.platform} value={provider.platform}>
                    {provider.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="register-model-id">Model ID</Label>
            <Input
              id="register-model-id"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              placeholder="e.g. llama3.2"
              required
              maxLength={240}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="register-model-name">
              Display name <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="register-model-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Defaults to the model ID"
              maxLength={160}
            />
          </div>
          <ErrorNotice error={add.error} />
          <Button type="submit" disabled={!target || !modelId.trim() || add.isPending}>
            {add.isPending ? 'Registering…' : 'Register model'}
          </Button>
        </form>
      </Modal>
      <Modal
        open={Boolean(editing)}
        onOpenChange={(value) => {
          if (!value) setEditing(null)
        }}
        title={editing ? `Edit ${editing.displayName}` : 'Edit model'}
        description="Changes preserve the model ID and routing order."
        busy={update.isPending}
      >
        {editing ? (
          <ModelEditor
            key={editing.id}
            model={editing}
            busy={update.isPending}
            onSave={(settings) => update.mutate({ model: editing, settings })}
            onCancel={() => setEditing(null)}
          />
        ) : null}
        <ErrorNotice error={update.error} />
      </Modal>
    </div>
  )
}
