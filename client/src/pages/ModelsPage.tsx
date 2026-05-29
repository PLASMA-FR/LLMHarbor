import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader, SectionTitle, EmptyState } from '@/components/page-header'
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

function CommandMetric({ label, value, tone = 'default' }: { label: string; value: string | number; tone?: 'default' | 'good' | 'warn' }) {
  const color = tone === 'good' ? 'text-emerald-600 dark:text-emerald-300' : tone === 'warn' ? 'text-amber-600 dark:text-amber-300' : 'text-foreground'
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <p className={cn('mt-2 text-2xl font-semibold tracking-[-0.04em] tabular-nums', color)}>{value}</p>
    </div>
  )
}

export default function ModelsPage() {
  const queryClient = useQueryClient()
  const [selectedEndpoint, setSelectedEndpoint] = useState('')
  const [modelId, setModelId] = useState('')
  const [modelDisplayName, setModelDisplayName] = useState('')
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null)

  const { data: endpoints = [], isLoading } = useQuery<EndpointSummary[]>({
    queryKey: ['custom-endpoints'],
    queryFn: () => apiFetch('/api/endpoints'),
  })

  const activeEndpoint = selectedEndpoint || endpoints[0]?.platform || ''

  const { data: endpointModels = [] } = useQuery<EndpointModel[]>({
    queryKey: ['custom-endpoint-models', activeEndpoint],
    queryFn: () => apiFetch(`/api/endpoints/${encodeURIComponent(activeEndpoint)}/models`),
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
  const readyEndpoints = endpoints.filter(endpoint => endpoint.keyCount > 0).length

  return (
    <div>
      <PageHeader
        eyebrow="Model command center"
        title="Models"
        description="Add models to built-in or custom endpoints, test them against live credentials, then let the fallback chain route traffic. Context is left to the provider by default."
      />

      <div className="space-y-7">
        <div className="grid gap-3 sm:grid-cols-3">
          <CommandMetric label="Endpoints" value={endpoints.length} />
          <CommandMetric label="Registered models" value={totalModels} />
          <CommandMetric label="Endpoints with keys" value={readyEndpoints} tone={readyEndpoints > 0 ? 'good' : 'warn'} />
        </div>

        <section className="panel-card rounded-2xl p-5 sm:p-6">
          <SectionTitle title="Endpoint model registry" description="Choose any harbor, register the model IDs it serves, and run a probe before adding it to your routing chain." />
          {isLoading ? (
            <div className="rounded-2xl border border-border bg-card p-8 text-sm text-muted-foreground">Loading endpoints...</div>
          ) : endpoints.length === 0 ? (
            <EmptyState title="No endpoints available" description="Add a provider key or create a custom endpoint from the Keys page." />
          ) : (
            <div className="mt-5 grid gap-4 lg:grid-cols-[320px_1fr]">
              <div className="space-y-2">
                {endpoints.map(endpoint => (
                  <button
                    type="button"
                    key={endpoint.platform}
                    onClick={() => setSelectedEndpoint(endpoint.platform)}
                    className={cn('w-full rounded-2xl border px-4 py-3 text-left transition-colors', activeEndpoint === endpoint.platform ? 'border-primary bg-primary/8' : 'border-border bg-card hover:bg-muted/45')}
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
                    <span className="mt-2 block text-xs text-muted-foreground">{endpoint.modelCount} model{endpoint.modelCount === 1 ? '' : 's'} · {endpoint.keyCount} key{endpoint.keyCount === 1 ? '' : 's'}</span>
                  </button>
                ))}
              </div>

              <div className="rounded-[var(--radius-panel)] border border-border bg-card p-4 sm:p-5">
                {selectedEndpointInfo ? (
                  <div className="space-y-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-muted-foreground">{selectedEndpointInfo.custom ? 'Custom harbor' : platformDisplay(selectedEndpointInfo.platform).surface ?? 'Built-in harbor'}</p>
                        <h3 className="mt-1 text-lg font-semibold tracking-[-0.03em]">{selectedEndpointInfo.platform === 'google-oauth' ? 'Antigravity Browser Account' : selectedEndpointInfo.name}</h3>
                        <code className="mt-1 block truncate text-xs text-muted-foreground">{selectedEndpointInfo.baseUrl || selectedEndpointInfo.platform}</code>
                      </div>
                      {selectedEndpointInfo.keyCount === 0 && <span className="rounded-[var(--radius-badge)] bg-amber-500/10 px-3 py-1 text-xs text-amber-700 dark:text-amber-300">Add a key before probing</span>}
                    </div>

                    <div className="rounded-[var(--radius-panel)] border border-border bg-background p-4">
                      <div className="grid gap-3 md:grid-cols-[1fr_1fr]">
                        <div className="space-y-1.5">
                          <Label className="text-xs">Model ID</Label>
                          <Input value={modelId} onChange={e => setModelId(e.target.value)} placeholder="llama-3.3-70b-versatile" className="h-10 rounded-[var(--radius-input)] bg-background font-mono text-xs" />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Display name</Label>
                          <Input value={modelDisplayName} onChange={e => setModelDisplayName(e.target.value)} placeholder="Llama 3.3 70B" className="h-10 rounded-[var(--radius-input)] bg-background" />
                        </div>
                      </div>
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-xs text-muted-foreground">No context field needed. LLMHarbor lets the provider enforce the model default.</p>
                        <div className="flex gap-2">
                          <Button type="button" variant="outline" size="sm" className="rounded-[var(--radius-button)]" disabled={!modelId || probeModel.isPending} onClick={() => probeModel.mutate({ platform: selectedEndpointInfo.platform, modelId })}>
                            {probeModel.isPending ? 'Testing...' : 'Test model'}
                          </Button>
                          <Button type="button" size="sm" className="rounded-[var(--radius-button)]" disabled={!modelId || !modelDisplayName || addModel.isPending} onClick={() => addModel.mutate({ platform: selectedEndpointInfo.platform, modelId, displayName: modelDisplayName })}>
                            {addModel.isPending ? 'Adding...' : 'Add model'}
                          </Button>
                        </div>
                      </div>
                    </div>

                    {probeResult && probeResult.platform === selectedEndpointInfo.platform && (
                      <div className={cn('rounded-[var(--radius-panel)] border px-4 py-3 text-sm', probeResult.ok ? 'border-emerald-500/30 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300' : 'border-rose-500/30 bg-rose-500/8 text-rose-700 dark:text-rose-300')}>
                        <span className="font-semibold">{probeResult.ok ? 'Probe passed' : 'Probe failed'}</span>
                        <span className="ml-2 text-xs opacity-80">{probeResult.modelId}{probeResult.latencyMs !== undefined ? ` · ${probeResult.latencyMs}ms` : ''}</span>
                        <p className="mt-1 text-xs opacity-85">{probeResult.sample || probeResult.message}</p>
                      </div>
                    )}
                    {addModel.isError && <p className="text-xs text-destructive">{(addModel.error as Error).message}</p>}

                    <div className="divide-y divide-border overflow-hidden rounded-[var(--radius-panel)] border border-border bg-background">
                      {endpointModels.length === 0 ? (
                        <p className="px-4 py-5 text-sm text-muted-foreground">No models registered for this endpoint yet.</p>
                      ) : endpointModels.map(model => (
                        <div key={model.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[1fr_110px_auto_auto] sm:items-center">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{model.displayName}</p>
                            <code className="block truncate text-[11px] text-muted-foreground">{model.modelId}</code>
                          </div>
                          <span className="text-xs text-muted-foreground">{model.fallbackEnabled ? `route ${model.priority ?? 'set'}` : 'not routed'}</span>
                          <Button variant="ghost" size="xs" onClick={() => probeModel.mutate({ platform: selectedEndpointInfo.platform, modelId: model.modelId })} disabled={probeModel.isPending}>Test</Button>
                          <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={() => deleteModel.mutate({ endpointPlatform: selectedEndpointInfo.platform, modelDbId: model.id })} disabled={deleteModel.isPending}>Remove</Button>
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
