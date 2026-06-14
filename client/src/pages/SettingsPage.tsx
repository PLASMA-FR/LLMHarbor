import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader, SectionTitle, EmptyState } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { DetectedFreeModel, FreeModelUpdaterProviderOption, FreeModelUpdaterStatus } from '../../../shared/types'

interface ClientApiKey { id: number; label: string; key?: string; maskedKey: string; enabled: boolean; createdAt: string; lastUsedAt: string | null; localEndpointId?: number | null }
interface LocalEndpointKey { id: number; label: string; maskedKey: string; enabled: boolean; localEndpointId: number; createdAt?: string; lastUsedAt?: string | null }
interface LocalEndpoint { id: number; name: string; slug: string; basePath: string; enabled: boolean; providerScopes: string[]; domains: string[]; keys: LocalEndpointKey[] }
interface PolicyRoute { id: string; method: string; path: string; name: string; description: string; enabled: boolean }
interface PolicyPlatform { platform: string; name: string; baseUrl: string | null; timeoutMs: number | null; source: 'built-in' | 'custom' | 'catalog'; enabled: boolean }
interface PolicyModel { modelDbId: number; platform: string; modelId: string; displayName: string; contextWindow: number | null; catalogEnabled: boolean; enabled: boolean }
interface AccessPolicySnapshot { key: ClientApiKey; routes: PolicyRoute[]; platforms: PolicyPlatform[]; models: PolicyModel[] }

type PolicyPatch = Partial<{
  routes: Array<{ route: string; enabled: boolean }>
  platforms: Array<{ platform: string; enabled: boolean }>
  models: Array<{ modelDbId: number; enabled: boolean }>
}>

function policyTone(enabled: boolean) {
  return enabled ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-rose-500/25 bg-rose-500/5'
}

function formatContextWindow(value: number | null) {
  if (!value) return null
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1)).toString()}M ctx`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K ctx`
  return `${value} ctx`
}

function PolicyStateBadge({ enabled }: { enabled: boolean }) {
  return (
    <Badge variant={enabled ? 'default' : 'secondary'} className={cn('shrink-0', enabled ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-background' : 'bg-rose-500/10 text-rose-700 dark:text-rose-200')}>
      {enabled ? 'Allowed' : 'Blocked'}
    </Badge>
  )
}

function SummaryTile({ label, value, detail, tone = 'default' }: { label: string; value: string | number; detail: string; tone?: 'default' | 'good' | 'warn' }) {
  return (
    <div className={cn(
      'panel-card min-w-0 rounded-2xl p-4',
      tone === 'good' && 'border-emerald-500/20 bg-emerald-500/5',
      tone === 'warn' && 'border-amber-500/25 bg-amber-500/10',
    )}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-[-0.04em] tabular-nums">{value}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  )
}

function PolicyActionButton({ children, onClick, disabled, variant = 'outline' }: { children: string; onClick: () => void; disabled?: boolean; variant?: 'default' | 'outline' }) {
  return (
    <Button type="button" variant={variant} size="sm" className="shrink-0 rounded-[var(--radius-button)] whitespace-nowrap" disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  )
}

export default function SettingsPage() {
  const queryClient = useQueryClient()
  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(() => {
    const keyParam = new URLSearchParams(window.location.search).get('key')
    const keyId = Number.parseInt(keyParam ?? '', 10)
    return Number.isNaN(keyId) ? null : keyId
  })
  const [modelSearch, setModelSearch] = useState('')
  const [platformFilter, setPlatformFilter] = useState('all')
  const [showBlockedOnly, setShowBlockedOnly] = useState(false)
  const [freeUpdaterInterval, setFreeUpdaterInterval] = useState('6')

  const { data: clientKeys = [] } = useQuery<ClientApiKey[]>({
    queryKey: ['client-api-keys'],
    queryFn: () => apiFetch('/api/settings/api-keys'),
  })

  const { data: endpointData } = useQuery<{ endpoints: LocalEndpoint[] }>({
    queryKey: ['local-endpoints'],
    queryFn: () => apiFetch('/api/settings/local-endpoints'),
  })

  const activeKeyId = clientKeys.some(key => key.id === selectedKeyId) ? selectedKeyId : clientKeys[0]?.id ?? null
  const selectedKey = useMemo(() => clientKeys.find(key => key.id === activeKeyId) ?? null, [clientKeys, activeKeyId])

  const { data: policy, isLoading: policyLoading } = useQuery<AccessPolicySnapshot>({
    queryKey: ['client-api-key-access-policy', activeKeyId],
    queryFn: () => apiFetch(`/api/settings/api-keys/${activeKeyId}/access-policy`),
    enabled: activeKeyId !== null,
  })

  const patchPolicy = useMutation({
    mutationFn: ({ keyId, patch }: { keyId: number; patch: PolicyPatch }) => apiFetch<AccessPolicySnapshot>(`/api/settings/api-keys/${keyId}/access-policy`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['client-api-key-access-policy', variables.keyId] })
      queryClient.invalidateQueries({ queryKey: ['client-api-keys'] })
    },
  })

  const { data: freeUpdaterStatus } = useQuery<FreeModelUpdaterStatus>({
    queryKey: ['free-model-updater-status'],
    queryFn: () => apiFetch('/api/settings/free-model-updater/status'),
  })

  const { data: freeUpdaterProviderData } = useQuery<{ providers: FreeModelUpdaterProviderOption[] }>({
    queryKey: ['free-model-updater-providers'],
    queryFn: () => apiFetch('/api/settings/free-model-updater/providers'),
  })

  const { data: detectedFreeModels = [], isFetching: detectingFreeModels } = useQuery<DetectedFreeModel[]>({
    queryKey: ['free-model-updater-detected-models', freeUpdaterStatus?.selectedProviders ?? []],
    queryFn: () => apiFetch('/api/settings/free-model-updater/detected-models'),
    staleTime: 60_000,
  })

  const enableFreeUpdater = useMutation({
    mutationFn: (refreshIntervalHours: number) => apiFetch<FreeModelUpdaterStatus>('/api/settings/free-model-updater/enable', {
      method: 'POST',
      body: JSON.stringify({ refreshIntervalHours }),
    }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['free-model-updater-status'] }),
  })

  const disableFreeUpdater = useMutation({
    mutationFn: () => apiFetch<FreeModelUpdaterStatus>('/api/settings/free-model-updater/disable', { method: 'POST' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['free-model-updater-status'] }),
  })

  const refreshFreeModels = useMutation({
    mutationFn: () => apiFetch('/api/settings/free-model-updater/refresh-now', { method: 'POST' }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['free-model-updater-status'] })
      queryClient.invalidateQueries({ queryKey: ['free-model-updater-detected-models'] })
      queryClient.invalidateQueries({ queryKey: ['free-model-updater-providers'] })
      queryClient.invalidateQueries({ queryKey: ['client-api-key-access-policy'] })
    },
  })

  const updateFreeUpdaterProviders = useMutation({
    mutationFn: (selectedProviders: string[]) => apiFetch('/api/settings/free-model-updater/providers', {
      method: 'PUT',
      body: JSON.stringify({ selectedProviders }),
    }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['free-model-updater-status'] })
      queryClient.invalidateQueries({ queryKey: ['free-model-updater-providers'] })
      queryClient.invalidateQueries({ queryKey: ['free-model-updater-detected-models'] })
    },
  })

  useEffect(() => {
    if (freeUpdaterStatus) setFreeUpdaterInterval(String(freeUpdaterStatus.refreshIntervalHours))
  }, [freeUpdaterStatus])

  const totalEndpoints = endpointData?.endpoints.length ?? 0
  const legacyDomains = endpointData?.endpoints.reduce((sum, endpoint) => sum + endpoint.domains.length, 0) ?? 0
  const blockedRoutes = policy?.routes.filter(route => !route.enabled).length ?? 0
  const allowedRoutes = policy?.routes.filter(route => route.enabled).length ?? 0
  const blockedProviders = policy?.platforms.filter(platform => !platform.enabled).length ?? 0
  const allowedProviders = policy ? policy.platforms.length - blockedProviders : 0
  const blockedModels = policy?.models.filter(model => !model.enabled).length ?? 0
  const allowedModels = policy ? policy.models.length - blockedModels : 0
  const totalBlocked = blockedRoutes + blockedProviders + blockedModels
  const freeUpdaterProviders = freeUpdaterProviderData?.providers ?? []
  const selectedFreeUpdaterProviders = freeUpdaterProviders.filter(provider => provider.selected).map(provider => provider.platform)
  const freeUpdaterActionError = enableFreeUpdater.error ?? disableFreeUpdater.error ?? refreshFreeModels.error ?? updateFreeUpdaterProviders.error
  const providerOptions = useMemo(() => Array.from(new Set(policy?.models.map(model => model.platform) ?? [])).sort((a, b) => a.localeCompare(b)), [policy?.models])
  const visibleModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase()
    return (policy?.models ?? [])
      .filter(model => platformFilter === 'all' || model.platform === platformFilter)
      .filter(model => !showBlockedOnly || !model.enabled)
      .filter(model => !query || `${model.modelId} ${model.displayName} ${model.platform}`.toLowerCase().includes(query))
      .slice(0, 160)
  }, [modelSearch, platformFilter, policy?.models, showBlockedOnly])
  const freeUpdaterBusy = (freeUpdaterStatus?.status === 'running') || enableFreeUpdater.isPending || disableFreeUpdater.isPending || refreshFreeModels.isPending || updateFreeUpdaterProviders.isPending
  const canRefreshFreeUpdater = selectedFreeUpdaterProviders.length > 0 && !freeUpdaterBusy
  const canEnableFreeUpdater = selectedFreeUpdaterProviders.length > 0 && !freeUpdaterBusy

  function updatePolicy(patch: PolicyPatch) {
    if (!activeKeyId) return
    patchPolicy.mutate({ keyId: activeKeyId, patch })
  }

  function setAllRoutes(enabled: boolean) {
    if (!policy) return
    updatePolicy({ routes: policy.routes.map(route => ({ route: route.id, enabled })) })
  }

  function setAllPlatforms(enabled: boolean) {
    if (!policy) return
    updatePolicy({ platforms: policy.platforms.map(platform => ({ platform: platform.platform, enabled })) })
  }

  function setVisibleModels(enabled: boolean) {
    if (!visibleModels.length) return
    updatePolicy({ models: visibleModels.map(model => ({ modelDbId: model.modelDbId, enabled })) })
  }

  function setFreeUpdaterProvider(platform: string, selected: boolean) {
    const next = new Set(selectedFreeUpdaterProviders.map(String))
    if (selected) next.add(platform)
    else next.delete(platform)
    updateFreeUpdaterProviders.mutate(Array.from(next).sort((a, b) => a.localeCompare(b)))
  }

  function setAllFreeUpdaterProviders(selected: boolean) {
    updateFreeUpdaterProviders.mutate(selected ? freeUpdaterProviders.map(provider => provider.platform) : [])
  }

  function toggleFreeUpdater(enabled: boolean) {
    if (enabled) {
      const parsed = Number.parseInt(freeUpdaterInterval, 10)
      enableFreeUpdater.mutate(Number.isFinite(parsed) ? Math.min(24, Math.max(1, parsed)) : 6)
    } else {
      disableFreeUpdater.mutate()
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Settings"
        title="Local API access controls"
        description="Give every app its own route, provider, and model policy. One local /v1 endpoint, many isolated permissions."
        actions={
          <Button variant="outline" onClick={() => { window.location.href = '/keys' }}>
            Manage keys
          </Button>
        }
      />

      <section className="panel-card rounded-2xl p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <SectionTitle
            title="Free model updater"
            description="Disabled by default. Select ready providers, then optionally let LLMHarbor discover free/free-tier models, probe them, and keep the local catalog fresh."
            action={<Badge variant="secondary">Beta</Badge>}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Label className="text-xs text-muted-foreground">Interval (hours)</Label>
            <Input
              className="h-9 w-24"
              type="number"
              min={1}
              max={24}
              value={freeUpdaterInterval}
              onChange={event => setFreeUpdaterInterval(event.target.value)}
            />
            <Switch
              checked={freeUpdaterStatus?.enabled ?? false}
              onCheckedChange={toggleFreeUpdater}
              disabled={freeUpdaterBusy || (!(freeUpdaterStatus?.enabled ?? false) && !canEnableFreeUpdater)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canRefreshFreeUpdater}
              onClick={() => refreshFreeModels.mutate()}
            >
              {refreshFreeModels.isPending ? 'Refreshing…' : 'Refresh selected'}
            </Button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryTile label="Status" value={freeUpdaterStatus?.status ?? 'idle'} detail={freeUpdaterStatus?.enabled ? 'Background refresh enabled.' : 'Background refresh disabled.'} />
          <SummaryTile label="Selected" value={freeUpdaterStatus?.selectedProviderCount ?? selectedFreeUpdaterProviders.length} detail="Only these providers are fetched." tone={selectedFreeUpdaterProviders.length ? 'good' : 'warn'} />
          <SummaryTile label="Detected" value={freeUpdaterStatus?.detectedCount ?? detectedFreeModels.length} detail="Candidates from the latest selected-provider refresh." />
          <SummaryTile label="Last run" value={freeUpdaterStatus?.lastRunAt ? new Date(freeUpdaterStatus.lastRunAt).toLocaleString() : 'Never'} detail="Most recent updater cycle." />
        </div>

        <div className="mt-5 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-100">
          <strong>Beta safeguard:</strong> the updater stays off until you opt in. Built-in providers appear only when a usable upstream key is enabled. Custom endpoints are opt-in, user-declared free/local catalogs. Review provider quotas before enabling background refresh.
        </div>

        <div className="mt-5 rounded-2xl border border-border bg-background p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium">Provider selection</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Refresh selected fetches only the providers selected here. Built-in providers appear only when they have a usable enabled key. Custom endpoints remain opt-in and are treated as user-declared free/local catalogs; every listed model is probed before it is marked verified.
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button type="button" size="sm" variant="outline" disabled={freeUpdaterBusy || freeUpdaterProviders.length === 0} onClick={() => setAllFreeUpdaterProviders(true)}>Select all</Button>
              <Button type="button" size="sm" variant="outline" disabled={freeUpdaterBusy || selectedFreeUpdaterProviders.length === 0} onClick={() => setAllFreeUpdaterProviders(false)}>Clear</Button>
            </div>
          </div>
          <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {freeUpdaterProviders.length === 0 ? (
              <EmptyState title="No ready providers" description="Add or enable an API key for a supported free-tier provider, or create/enable a custom OpenAI-compatible endpoint. The beta updater only shows providers it can actually refresh." />
            ) : freeUpdaterProviders.map(provider => (
              <div key={provider.platform} className={cn('rounded-2xl border p-3 transition-colors', provider.selected ? 'border-primary bg-primary/5' : 'border-border bg-card')}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{provider.name}</p>
                    <code className="mt-1 block truncate text-[11px] text-muted-foreground">{provider.platform}</code>
                  </div>
                  <Switch checked={provider.selected} disabled={freeUpdaterBusy} onCheckedChange={checked => setFreeUpdaterProvider(provider.platform, checked)} />
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Badge variant="secondary">{provider.source}</Badge>
                  <Badge variant="outline">{provider.detectionPolicy}</Badge>
                  {provider.hasEnabledKey ? <Badge variant="default">key ready</Badge> : <Badge variant="secondary">custom/local</Badge>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {freeUpdaterStatus?.errorMessage && (
          <div className="mt-4 rounded-2xl border border-rose-500/25 bg-rose-500/8 px-3 py-2 text-sm text-rose-700 dark:text-rose-200">
            {freeUpdaterStatus.errorMessage}
          </div>
        )}

        {freeUpdaterActionError && (
          <div className="mt-4 rounded-2xl border border-rose-500/25 bg-rose-500/8 px-3 py-2 text-sm text-rose-700 dark:text-rose-200">
            {freeUpdaterActionError.message}
          </div>
        )}

        <div className="mt-5 rounded-2xl border border-border bg-background p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Detected free models preview</p>
            <Badge variant="secondary">{detectingFreeModels ? 'Loading…' : `${detectedFreeModels.length} candidates`}</Badge>
          </div>
          <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
            {detectedFreeModels.length === 0 ? (
              <EmptyState title="No preview yet" description={selectedFreeUpdaterProviders.length === 0 ? 'Select one or more ready providers before refreshing.' : 'Refresh selected providers to load free/free-tier candidates. Nothing is fetched from unselected providers.'} />
            ) : detectedFreeModels.slice(0, 80).map(model => (
              <div key={`${model.platform}:${model.modelId}`} className="rounded-xl border border-border bg-card px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{model.displayName}</span>
                  <Badge variant="outline">{model.platform}</Badge>
                  <Badge variant="secondary">{model.detectionMethod}</Badge>
                  <Badge variant={model.verificationStatus === 'verified' ? 'default' : 'secondary'}>{model.verificationStatus}</Badge>
                </div>
                <code className="mt-1 block truncate text-muted-foreground">{model.modelId}</code>
                {model.lastError && <p className="mt-1 text-rose-600 dark:text-rose-300">{model.lastError}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid min-w-0 max-w-full gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryTile label="Client keys" value={clientKeys.length} detail="Per app, agent, laptop, or experiment." />
        <SummaryTile label="Routes allowed" value={`${allowedRoutes}/${policy?.routes.length ?? 0}`} detail="OpenAI-compatible surface area." tone={blockedRoutes ? 'warn' : 'good'} />
        <SummaryTile label="Providers allowed" value={`${allowedProviders}/${policy?.platforms.length ?? 0}`} detail="Whole endpoint families for this key." tone={blockedProviders ? 'warn' : 'good'} />
        <SummaryTile label="Model blocks" value={blockedModels} detail="Explicit per-key catalog denies." tone={blockedModels ? 'warn' : 'default'} />
      </section>

      <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(260px,0.72fr)_minmax(0,1.28fr)]">
        <aside className="min-w-0 space-y-4 xl:sticky xl:top-28 xl:self-start">
          <div className="panel-card rounded-2xl p-5">
            <SectionTitle title="Choose a local key" description="Policies are isolated. Blocking a provider here will not affect other apps." />
            {clientKeys.length === 0 ? (
              <EmptyState
                title="No local API keys"
                description="Create a client key on the Keys page, then return here to set route, provider, and model policy."
                action={<Button onClick={() => { window.location.href = '/keys' }}>Create a key</Button>}
              />
            ) : (
              <div className="mt-4 space-y-2">
                {clientKeys.map(key => (
                  <button
                    key={key.id}
                    type="button"
                    onClick={() => setSelectedKeyId(key.id)}
                    className={cn(
                      'w-full rounded-2xl border p-3 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/30',
                      activeKeyId === key.id ? 'border-primary bg-primary/10' : 'border-border bg-background hover:bg-muted/60',
                    )}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{key.label}</p>
                        <code className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">{key.maskedKey}</code>
                      </div>
                      <Badge variant={key.enabled ? 'default' : 'secondary'}>{key.enabled ? 'On' : 'Off'}</Badge>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {key.lastUsedAt ? `Last used ${new Date(key.lastUsedAt).toLocaleString()}` : 'Ready for route, provider, and model policy'}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="panel-card rounded-2xl p-5">
            <SectionTitle title="Compatibility surface" description="The router keeps the default /v1 path and host mappings. New segmentation happens through per-key policy." />
            <div className="grid gap-2 text-sm">
              <div className="flex justify-between gap-3 rounded-xl bg-background px-3 py-2"><span className="text-muted-foreground">Endpoint rows</span><span className="font-medium tabular-nums">{totalEndpoints}</span></div>
              <div className="flex justify-between gap-3 rounded-xl bg-background px-3 py-2"><span className="text-muted-foreground">Host mappings</span><span className="font-medium tabular-nums">{legacyDomains}</span></div>
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-100">
                Custom local endpoint creation is closed. Create one client key per app, then scope it here.
              </div>
            </div>
          </div>
        </aside>

        <div className="space-y-5 min-w-0">
          {!selectedKey ? (
            <EmptyState title="Select a key" description="Choose a local client key to edit its access policy." />
          ) : policyLoading ? (
            <div className="panel-card rounded-2xl p-6 text-sm text-muted-foreground">Loading access policy…</div>
          ) : !policy ? (
            <EmptyState title="Policy unavailable" description="The selected key could not be loaded." />
          ) : (
            <>
              <section className="panel-card rounded-2xl p-5 sm:p-6">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-primary/80">Active policy</p>
                    <h2 className="mt-1 truncate text-xl font-semibold tracking-[-0.035em]">{policy.key.label}</h2>
                    <code className="mt-2 block truncate rounded-xl bg-muted/70 px-3 py-2 font-mono text-xs text-muted-foreground">{policy.key.maskedKey}</code>
                  </div>
                  <div className="grid min-w-0 max-w-full gap-2 text-xs sm:grid-cols-3 lg:min-w-[460px]">
                    <div className="rounded-2xl bg-background p-3"><span className="block text-muted-foreground">Base URL</span><code className="mt-1 block truncate font-mono">/v1</code></div>
                    <div className="rounded-2xl bg-background p-3"><span className="block text-muted-foreground">Providers</span><span className="mt-1 block truncate font-medium tabular-nums">{allowedProviders}/{policy.platforms.length} allowed</span></div>
                    <div className="rounded-2xl bg-background p-3"><span className="block text-muted-foreground">Models</span><span className="mt-1 block truncate font-medium tabular-nums">{allowedModels}/{policy.models.length} allowed</span></div>
                  </div>
                </div>
                <div className="mt-5 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <p className="text-sm leading-6 text-muted-foreground">
                    {totalBlocked === 0
                      ? 'This key can call every available route, provider, and catalog model.'
                      : `This key has ${totalBlocked.toLocaleString()} active policy block${totalBlocked === 1 ? '' : 's'} across routes, providers, and models.`}
                  </p>
                  <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap md:justify-end">
                    <PolicyActionButton disabled={patchPolicy.isPending} onClick={() => setAllRoutes(true)}>Open routes</PolicyActionButton>
                    <PolicyActionButton disabled={patchPolicy.isPending} onClick={() => setAllPlatforms(true)}>Allow providers</PolicyActionButton>
                    <PolicyActionButton disabled={patchPolicy.isPending || visibleModels.length === 0} onClick={() => setVisibleModels(true)}>Allow visible models</PolicyActionButton>
                  </div>
                </div>
              </section>

              <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="panel-card min-w-0 rounded-2xl p-5 sm:p-6">
                  <SectionTitle
                    title="Route access"
                    description="Keep the proxy surface small for untrusted tools. Denied routes fail with a 403 before routing."
                    action={<PolicyActionButton disabled={patchPolicy.isPending} onClick={() => setAllRoutes(true)}>Allow all</PolicyActionButton>}
                  />
                  <div className="space-y-3">
                    {policy.routes.map(route => (
                      <div key={route.id} className={cn('min-w-0 rounded-2xl border p-4 transition-colors', policyTone(route.enabled))}>
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-medium">{route.name}</p>
                              <Badge variant="outline">{route.method}</Badge>
                            </div>
                            <code className="mt-2 block font-mono text-xs text-muted-foreground">{route.path}</code>
                            <p className="mt-2 text-xs leading-5 text-muted-foreground">{route.description}</p>
                          </div>
                          <Switch checked={route.enabled} onCheckedChange={(enabled) => updatePolicy({ routes: [{ route: route.id, enabled }] })} disabled={patchPolicy.isPending} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="panel-card min-w-0 rounded-2xl p-5 sm:p-6">
                  <SectionTitle
                    title="Provider endpoints"
                    description="Block whole upstream families while leaving the key valid for approved providers."
                    action={<PolicyActionButton disabled={patchPolicy.isPending} onClick={() => setAllPlatforms(true)}>Allow all</PolicyActionButton>}
                  />
                  <div className="max-h-[440px] space-y-2 overflow-y-auto pr-1">
                    {policy.platforms.map(provider => (
                      <div key={provider.platform} className={cn('min-w-0 rounded-2xl border p-3 transition-colors', provider.enabled ? 'border-border bg-background' : 'border-rose-500/25 bg-rose-500/5')}>
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="truncate text-sm font-medium">{provider.name}</p>
                              <Badge variant="outline">{provider.source}</Badge>
                            </div>
                            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{provider.platform}</p>
                            {provider.baseUrl && <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{provider.baseUrl}</p>}
                          </div>
                          <div className="flex shrink-0 items-center gap-3">
                            <PolicyStateBadge enabled={provider.enabled} />
                            <Switch checked={provider.enabled} onCheckedChange={(enabled) => updatePolicy({ platforms: [{ platform: provider.platform, enabled }] })} disabled={patchPolicy.isPending} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </section>

              <section className="panel-card rounded-2xl p-5 sm:p-6">
                <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-end 2xl:justify-between">
                  <SectionTitle title="Model scope" description="Fine tune the catalog visible to this key. Explicit blocked model requests fail before any upstream call." />
                  <div className="grid w-full min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(180px,1fr)_minmax(140px,180px)_max-content] 2xl:max-w-[620px]">
                    <div className="grid gap-1">
                      <Label className="text-xs text-muted-foreground">Search</Label>
                      <Input value={modelSearch} onChange={event => setModelSearch(event.target.value)} placeholder="gpt, gemini, llama…" />
                    </div>
                    <div className="grid gap-1">
                      <Label className="text-xs text-muted-foreground">Provider</Label>
                      <select className="h-10 rounded-[var(--radius-input)] border border-input bg-background px-3 text-sm" value={platformFilter} onChange={event => setPlatformFilter(event.target.value)}>
                        <option value="all">All</option>
                        {providerOptions.map(platform => <option key={platform} value={platform}>{platform}</option>)}
                      </select>
                    </div>
                    <Button type="button" className="h-10 w-full self-end whitespace-nowrap sm:col-span-2 lg:col-span-1 lg:w-auto" variant={showBlockedOnly ? 'default' : 'outline'} onClick={() => setShowBlockedOnly(prev => !prev)}>
                      {showBlockedOnly ? 'Show all models' : 'Blocked only'}
                    </Button>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-background p-3">
                  <p className="text-sm text-muted-foreground">
                    Showing <span className="font-medium text-foreground tabular-nums">{visibleModels.length}</span> of <span className="font-medium text-foreground tabular-nums">{policy.models.length}</span> models. <span className="font-medium text-foreground tabular-nums">{allowedModels}</span> currently allowed.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <PolicyActionButton disabled={patchPolicy.isPending || visibleModels.length === 0} onClick={() => setVisibleModels(true)}>Allow visible</PolicyActionButton>
                    <PolicyActionButton disabled={patchPolicy.isPending || visibleModels.length === 0} onClick={() => setVisibleModels(false)} variant="outline">Block visible</PolicyActionButton>
                  </div>
                </div>

                <div className="mt-4 max-h-[620px] space-y-2 overflow-y-auto pr-1">
                  {visibleModels.length === 0 ? (
                    <EmptyState title="No matching models" description="Adjust the provider filter or search query." />
                  ) : visibleModels.map(model => {
                    const contextLabel = formatContextWindow(model.contextWindow)
                    return (
                      <div key={model.modelDbId} className={cn('rounded-2xl border p-3 transition-colors', model.enabled ? 'border-border bg-background' : 'border-rose-500/25 bg-rose-500/5')}>
                        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="truncate text-sm font-medium">{model.displayName}</p>
                              <Badge variant="outline">{model.platform}</Badge>
                              {contextLabel && <Badge variant="secondary">{contextLabel}</Badge>}
                              {!model.catalogEnabled && <Badge variant="secondary">Catalog off</Badge>}
                            </div>
                            <code className="mt-1 block truncate font-mono text-xs text-muted-foreground">{model.modelId}</code>
                          </div>
                          <div className="flex shrink-0 items-center justify-between gap-3 md:justify-end">
                            <PolicyStateBadge enabled={model.enabled} />
                            <Switch checked={model.enabled} onCheckedChange={(enabled) => updatePolicy({ models: [{ modelDbId: model.modelDbId, enabled }] })} disabled={patchPolicy.isPending} />
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                {(policy.models.length > visibleModels.length) && (
                  <p className="mt-3 text-xs text-muted-foreground">Showing {visibleModels.length} filtered models out of {policy.models.length}. Use search or provider filters to narrow the catalog.</p>
                )}
              </section>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
