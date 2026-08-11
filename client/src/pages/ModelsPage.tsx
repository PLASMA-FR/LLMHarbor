import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader, SectionTitle, EmptyState, ErrorState, LoadingState } from '@/components/page-header'
import { MetricCard } from '@/components/metric-card'
import { InlineNotice, StatusIndicator } from '@/components/status-indicator'
import { cn } from '@/lib/utils'

interface EndpointSummary {
  id: number | null
  platform: string
  name: string
  baseUrl: string | null
  validateUrl: string | null
  timeoutMs: number
  enabled: boolean
  custom: boolean
  modelCount: number
  keyCount: number
  credentialMode: 'api-key' | 'oauth' | 'optional-api-key'
  configuredKeyCount: number
  enabledKeyCount: number
  availableKeyCount: number
}

interface EndpointModel {
  id: number
  platform: string
  modelId: string
  displayName: string
  intelligenceRank: number
  speedRank: number
  sizeLabel: string
  contextWindow: number | null
  enabled: boolean
  priority?: number | null
  fallbackEnabled?: boolean
}

interface ProbeResult {
  ok: boolean
  platform: string
  modelId: string
  latencyMs?: number
  sample?: string
  message?: string
}

function platformDisplay(platform: string) {
  if (platform === 'google') return { name: 'Google AI Studio', surface: 'API key' }
  if (platform === 'google-oauth') return { name: 'Antigravity Browser Account', surface: 'OAuth' }
  return { name: platform, surface: null as string | null }
}

export default function ModelsPage() {
  const queryClient = useQueryClient()
  const [selectedEndpoint, setSelectedEndpoint] = useState('')
  const [modelId, setModelId] = useState('')
  const [modelDisplayName, setModelDisplayName] = useState('')
  const [modelSearch, setModelSearch] = useState('')
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null)

  const { data: endpoints = [], isLoading, isError, error, refetch } = useQuery<EndpointSummary[]>({
    queryKey: ['custom-endpoints'],
    queryFn: ({ signal }) => apiFetch('/api/endpoints', { signal }),
  })

  const activeEndpoint = endpoints.some(endpoint => endpoint.platform === selectedEndpoint)
    ? selectedEndpoint
    : endpoints[0]?.platform ?? ''

  const { data: endpointModels = [], isLoading: modelsLoading, isError: modelsError, error: modelsQueryError, refetch: refetchModels } = useQuery<EndpointModel[]>({
    queryKey: ['custom-endpoint-models', activeEndpoint],
    queryFn: ({ signal }) => apiFetch(`/api/endpoints/${encodeURIComponent(activeEndpoint)}/models`, { signal }),
    enabled: Boolean(activeEndpoint),
  })

  const addModel = useMutation({
    mutationFn: (body: { platform: string; modelId: string; displayName: string }) =>
      apiFetch(`/api/endpoints/${encodeURIComponent(body.platform)}/models`, {
        method: 'POST',
        body: JSON.stringify({
          modelId: body.modelId,
          displayName: body.displayName,
          sizeLabel: 'Custom',
          intelligenceRank: 50,
          speedRank: 50,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-endpoints'] })
      queryClient.invalidateQueries({ queryKey: ['custom-endpoint-models', activeEndpoint] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setModelId('')
      setModelDisplayName('')
      setProbeResult(null)
    },
  })

  const probeModel = useMutation({
    mutationFn: (body: { platform: string; modelId: string }) =>
      apiFetch<ProbeResult>(`/api/endpoints/${encodeURIComponent(body.platform)}/models/probe`, {
        method: 'POST',
        body: JSON.stringify({ modelId: body.modelId }),
      }),
    onSuccess: (result) => setProbeResult(result),
    onError: (error, variables) => setProbeResult({
      ok: false,
      platform: variables.platform,
      modelId: variables.modelId,
      message: error instanceof Error ? error.message : 'Probe failed',
    }),
  })

  const deleteModel = useMutation({
    mutationFn: ({ endpointPlatform, modelDbId }: { endpointPlatform: string; modelDbId: number }) =>
      apiFetch(`/api/endpoints/${encodeURIComponent(endpointPlatform)}/models/${modelDbId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-endpoints'] })
      queryClient.invalidateQueries({ queryKey: ['custom-endpoint-models', activeEndpoint] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  const selectedEndpointInfo = endpoints.find(endpoint => endpoint.platform === activeEndpoint)
  const totalModels = endpoints.reduce((sum, endpoint) => sum + endpoint.modelCount, 0)
  const readyEndpoints = endpoints.filter(endpoint => endpoint.enabled && endpoint.availableKeyCount > 0).length
  const visibleEndpointModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase()
    if (!query) return endpointModels
    return endpointModels.filter(model => `${model.displayName} ${model.modelId}`.toLowerCase().includes(query))
  }, [endpointModels, modelSearch])

  function submitModel(event: React.FormEvent) {
    event.preventDefault()
    const id = modelId.trim()
    const name = modelDisplayName.trim()
    if (!id || !name || !selectedEndpointInfo) return
    addModel.mutate({ platform: selectedEndpointInfo.platform, modelId: id, displayName: name })
  }

  return (
    <div>
      <PageHeader
        eyebrow="Model catalog"
        title="Models"
        description="Register provider model IDs, inspect route availability, and probe live credentials before adding models to production traffic."
      />

      <div className="space-y-7">
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard label="Endpoints" value={endpoints.length} detail={`${endpoints.filter(endpoint => endpoint.custom).length} custom`} />
          <MetricCard label="Registered models" value={totalModels} detail="Across all endpoints" />
          <MetricCard label="Ready endpoints" value={readyEndpoints} detail="With usable credentials" tone={readyEndpoints > 0 ? 'positive' : 'warning'} />
        </div>

        <section className="panel-card rounded-[var(--radius-panel)] p-5">
          <SectionTitle title="Endpoint model registry" description="Choose any endpoint, register the model IDs it serves, and run a probe before adding it to your routing order." />
          {isLoading ? (
            <LoadingState title="Loading endpoints" description="Checking built-in and custom provider endpoints…" />
          ) : isError ? (
            <ErrorState title="Could not load endpoints" description={error.message} action={<Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>} />
          ) : endpoints.length === 0 ? (
            <EmptyState title="No endpoints available" description="Add a provider key or create a custom endpoint from the Keys page." />
          ) : (
            <div className="mt-5 grid gap-4 lg:grid-cols-[320px_1fr]">
              <div className="space-y-2">
                {endpoints.map(endpoint => (
                  <button
                    type="button"
                    key={endpoint.platform}
                    onClick={() => {
                      setSelectedEndpoint(endpoint.platform)
                      setProbeResult(null)
                      setModelSearch('')
                    }}
                    aria-pressed={activeEndpoint === endpoint.platform}
                    className={cn('w-full rounded-[var(--radius-panel)] border px-3 py-3 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/25', activeEndpoint === endpoint.platform ? 'border-primary bg-primary/8' : 'border-border bg-background hover:bg-muted/45')}
                  >
                    <span className="flex items-center justify-between gap-3 text-sm font-semibold">
                      <span className="truncate">{endpoint.name}</span>
                      <span className={cn('shrink-0 rounded-lg px-2 py-0.5 text-[10px] font-semibold', endpoint.custom ? 'bg-amber-500/12 text-amber-700 dark:text-amber-300' : 'bg-primary/10 text-primary')}>{endpoint.custom ? 'Custom' : 'Built-in'}</span>
                    </span>
                    <code className="mt-1 block truncate text-[11px] text-muted-foreground">
                      {platformDisplay(endpoint.platform).name}
                      {platformDisplay(endpoint.platform).surface ? ` · ${platformDisplay(endpoint.platform).surface}` : ` · ${endpoint.platform}`}
                    </code>
                    <span className="mt-2 block truncate text-[11px] text-muted-foreground">{endpoint.baseUrl || 'Provider-specific API'}</span>
                    <span className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span>{endpoint.modelCount} model{endpoint.modelCount === 1 ? '' : 's'} · {endpoint.availableKeyCount}/{endpoint.configuredKeyCount} usable credentials</span>
                      <StatusIndicator
                        label={!endpoint.enabled ? 'Disabled' : endpoint.availableKeyCount > 0 ? 'Ready' : 'No usable credential'}
                        tone={!endpoint.enabled ? 'neutral' : endpoint.availableKeyCount > 0 ? 'positive' : 'warning'}
                      />
                    </span>
                  </button>
                ))}
              </div>

              <div className="rounded-[var(--radius-panel)] border border-border bg-card p-4 sm:p-5">
                {selectedEndpointInfo ? (
                  <div className="space-y-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-muted-foreground">{selectedEndpointInfo.custom ? 'Custom endpoint' : platformDisplay(selectedEndpointInfo.platform).surface ?? 'Built-in endpoint'}</p>
                        <h3 className="mt-1 text-lg font-semibold tracking-[-0.03em]">{selectedEndpointInfo.platform === 'google-oauth' ? 'Antigravity Browser Account' : selectedEndpointInfo.name}</h3>
                        <code className="mt-1 block truncate text-xs text-muted-foreground">{selectedEndpointInfo.baseUrl || selectedEndpointInfo.platform}</code>
                      </div>
                      <StatusIndicator
                        label={!selectedEndpointInfo.enabled ? 'Endpoint disabled' : selectedEndpointInfo.availableKeyCount > 0 ? 'Credential ready' : 'No usable credential'}
                        tone={!selectedEndpointInfo.enabled ? 'neutral' : selectedEndpointInfo.availableKeyCount > 0 ? 'positive' : 'warning'}
                      />
                    </div>

                    <form onSubmit={submitModel} className="rounded-[var(--radius-panel)] border border-border bg-background p-4">
                      <div className="grid gap-3 md:grid-cols-[1fr_1fr]">
                        <div className="space-y-1.5">
                          <Label htmlFor="model-registry-id" className="text-xs">Model ID</Label>
                          <Input id="model-registry-id" value={modelId} onChange={e => setModelId(e.target.value)} placeholder="llama-3.3-70b-versatile" className="font-mono text-xs" spellCheck={false} />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="model-registry-display-name" className="text-xs">Display name</Label>
                          <Input id="model-registry-display-name" value={modelDisplayName} onChange={e => setModelDisplayName(e.target.value)} placeholder="Llama 3.3 70B" maxLength={120} />
                        </div>
                      </div>
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-xs text-muted-foreground">New models enter Routing disabled. Probe here, then enable the verified route deliberately.</p>
                        <div className="flex gap-2">
                          <Button type="button" variant="outline" size="sm" disabled={!modelId.trim() || probeModel.isPending || !selectedEndpointInfo.enabled || selectedEndpointInfo.availableKeyCount === 0} onClick={() => probeModel.mutate({ platform: selectedEndpointInfo.platform, modelId: modelId.trim() })} aria-describedby="model-probe-help">
                            {probeModel.isPending ? 'Testing...' : 'Test model'}
                          </Button>
                          <Button type="submit" size="sm" disabled={!modelId.trim() || !modelDisplayName.trim() || addModel.isPending}>
                            {addModel.isPending ? 'Adding...' : 'Add model'}
                          </Button>
                        </div>
                      </div>
                    </form>

                    {probeResult && probeResult.platform === selectedEndpointInfo.platform && (
                      <div className={cn('rounded-[var(--radius-panel)] border px-4 py-3 text-sm', probeResult.ok ? 'border-emerald-500/30 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300' : 'border-rose-500/30 bg-rose-500/8 text-rose-700 dark:text-rose-300')} role={probeResult.ok ? 'status' : 'alert'}>
                        <span className="font-semibold">{probeResult.ok ? 'Probe passed' : 'Probe failed'}</span>
                        <span className="ml-2 text-xs opacity-80">{probeResult.modelId}{probeResult.latencyMs !== undefined ? ` · ${probeResult.latencyMs}ms` : ''}</span>
                        <p className="mt-1 text-xs opacity-85">{probeResult.sample || probeResult.message}</p>
                      </div>
                    )}
                    <p id="model-probe-help" className="text-xs text-muted-foreground">
                      {!selectedEndpointInfo.enabled
                        ? 'Enable this custom endpoint from Providers & keys before probing it.'
                        : selectedEndpointInfo.availableKeyCount === 0
                          ? selectedEndpointInfo.configuredKeyCount > 0
                            ? 'Enable or repair a configured credential before probing this endpoint.'
                            : 'Add a credential before probing this endpoint.'
                          : 'Probe uses an available endpoint credential before you rely on the model.'}
                    </p>
                    {addModel.isError || deleteModel.isError ? <InlineNotice tone="critical">{(addModel.error ?? deleteModel.error)?.message ?? 'Could not update the model registry.'}</InlineNotice> : null}

                    {endpointModels.length > 6 ? (
                      <div>
                        <Label htmlFor="endpoint-model-search" className="mb-1.5 text-xs">Search registered models</Label>
                        <Input id="endpoint-model-search" type="search" value={modelSearch} onChange={event => setModelSearch(event.target.value)} placeholder="Filter by name or model ID" />
                      </div>
                    ) : null}

                    <div className="divide-y divide-border overflow-hidden rounded-[var(--radius-panel)] border border-border bg-background">
                      {modelsLoading ? (
                        <div className="p-4"><LoadingState title="Loading models" description="Fetching registered model IDs…" /></div>
                      ) : modelsError ? (
                        <div className="p-4"><ErrorState title="Could not load models" description={modelsQueryError.message} action={<Button variant="outline" size="sm" onClick={() => refetchModels()}>Retry</Button>} /></div>
                      ) : endpointModels.length === 0 ? (
                        <p className="px-4 py-5 text-sm text-muted-foreground">No models registered for this endpoint yet.</p>
                      ) : visibleEndpointModels.length === 0 ? (
                        <p className="px-4 py-5 text-sm text-muted-foreground">No registered models match this search.</p>
                      ) : visibleEndpointModels.map(model => (
                        <div key={model.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_120px_auto_auto] sm:items-center">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{model.displayName}</p>
                            <code className="block truncate text-[11px] text-muted-foreground">{model.modelId}</code>
                          </div>
                          <StatusIndicator label={!model.enabled ? 'Disabled' : model.fallbackEnabled ? `Route ${model.priority ?? 'set'}` : 'Not routed'} tone={!model.enabled ? 'warning' : model.fallbackEnabled ? 'positive' : 'neutral'} />
                          <Button variant="ghost" size="xs" onClick={() => probeModel.mutate({ platform: selectedEndpointInfo.platform, modelId: model.modelId })} disabled={probeModel.isPending || !selectedEndpointInfo.enabled || selectedEndpointInfo.availableKeyCount === 0} aria-label={`Test ${model.displayName}`}>Test</Button>
                          <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={() => { if (window.confirm(`Remove model "${model.displayName}"?`)) deleteModel.mutate({ endpointPlatform: selectedEndpointInfo.platform, modelDbId: model.id }) }} disabled={deleteModel.isPending} aria-label={`Remove ${model.displayName}`}>Remove</Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Select an endpoint to manage its models.</p>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
