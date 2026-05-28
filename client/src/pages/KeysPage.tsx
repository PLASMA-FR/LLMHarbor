import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { PageHeader, SectionTitle, EmptyState } from '@/components/page-header'
import { cn } from '@/lib/utils'
import type { ApiKey, Platform } from '../../../shared/types'

const BUILT_IN_PLATFORMS: { value: Platform; label: string }[] = [
  { value: 'google', label: 'Google AI Studio' },
  { value: 'groq', label: 'Groq' },
  { value: 'cerebras', label: 'Cerebras' },
  { value: 'sambanova', label: 'SambaNova' },
  { value: 'nvidia', label: 'NVIDIA NIM' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'github', label: 'GitHub Models' },
  { value: 'cohere', label: 'Cohere' },
  { value: 'cloudflare', label: 'Cloudflare Workers AI' },
  { value: 'zhipu', label: 'Zhipu AI (Z.ai)' },
  { value: 'ollama', label: 'Ollama Cloud' },
  { value: 'kilo', label: 'Kilo Gateway (anon ok)' },
  { value: 'pollinations', label: 'Pollinations (anon ok)' },
  { value: 'llm7', label: 'LLM7 (anon ok)' },
  { value: 'huggingface', label: 'HuggingFace Router' },
]

const statusDot: Record<string, string> = {
  healthy: 'bg-emerald-500 ',
  rate_limited: 'bg-amber-500 ',
  invalid: 'bg-rose-500 ',
  error: 'bg-rose-500 ',
  unknown: 'bg-muted-foreground/40',
}

const statusLabel: Record<string, string> = {
  healthy: 'Healthy',
  rate_limited: 'Rate-limited',
  invalid: 'Invalid',
  error: 'Error',
  unknown: 'Unchecked',
}

interface HealthData {
  keys: { id: number; platform: string; status: string; lastCheckedAt: string | null }[]
}

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

function UnifiedKeySection() {
  const queryClient = useQueryClient()
  const [showKey, setShowKey] = useState(false)
  const [copied, setCopied] = useState(false)

  const { data } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const regenerate = useMutation({
    mutationFn: () => apiFetch('/api/settings/api-key/regenerate', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['unified-key'] }),
  })

  const apiKey = data?.apiKey ?? ''
  const masked = apiKey ? `${apiKey.slice(0, 13)}${'•'.repeat(26)}${apiKey.slice(-6)}` : 'Generating...'
  const baseUrl = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`

  function copy() {
    if (!apiKey) return
    navigator.clipboard.writeText(apiKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="panel-card relative overflow-hidden rounded-2xl p-5 sm:p-6">
      <div className="relative flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-primary/80">Client key</p>
          <h2 className="mt-2 text-xl font-semibold tracking-[-0.035em]">Unified API key</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Use this OpenAI-compatible key in your apps. LLMHarbor keeps provider keys on this machine.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
          {regenerate.isPending ? 'Regenerating...' : 'Regenerate key'}
        </Button>
      </div>

      <div className="relative mt-5 rounded-2xl border border-border bg-background p-3 ">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 truncate rounded-2xl bg-muted/70 px-3 py-3 font-mono text-xs tabular-nums select-all">
            {showKey ? apiKey : masked}
          </code>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowKey(!showKey)}>{showKey ? 'Hide' : 'Show'}</Button>
            <Button variant="default" size="sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
          </div>
        </div>
        <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
          <div className="rounded-2xl bg-card px-3 py-2">
            <span className="block text-muted-foreground">Base URL</span>
            <code className="mt-0.5 block truncate font-mono">{baseUrl}</code>
          </div>
          <div className="rounded-2xl bg-card px-3 py-2">
            <span className="block text-muted-foreground">Endpoint</span>
            <code className="mt-0.5 block truncate font-mono">/v1/chat/completions</code>
          </div>
        </div>
      </div>
    </section>
  )
}

function StatCard({ label, value, tone = 'default' }: { label: string; value: string | number; tone?: 'default' | 'good' | 'warn' | 'bad' }) {
  const color = tone === 'good' ? 'text-emerald-600 dark:text-emerald-300' : tone === 'warn' ? 'text-amber-600 dark:text-amber-300' : tone === 'bad' ? 'text-rose-600 dark:text-rose-300' : 'text-foreground'
  return (
    <div className="rounded-2xl border border-border bg-card p-4 ">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <p className={cn('mt-2 text-2xl font-semibold tracking-[-0.04em] tabular-nums', color)}>{value}</p>
    </div>
  )
}

export default function KeysPage() {
  const queryClient = useQueryClient()
  const [platform, setPlatform] = useState<Platform | ''>('')
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [label, setLabel] = useState('')
  const [endpointName, setEndpointName] = useState('')
  const [endpointBaseUrl, setEndpointBaseUrl] = useState('')

  const { data: keys = [], isLoading } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const { data: healthData } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: () => apiFetch('/api/health'),
    refetchInterval: 30000,
  })

  const { data: endpoints = [] } = useQuery<EndpointSummary[]>({
    queryKey: ['custom-endpoints'],
    queryFn: () => apiFetch('/api/endpoints'),
  })

  const customEndpoints = endpoints.filter(endpoint => endpoint.custom)

  const addEndpoint = useMutation({
    mutationFn: (body: { name: string; baseUrl: string }) =>
      apiFetch<EndpointSummary>('/api/endpoints', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-endpoints'] })
      setEndpointName('')
      setEndpointBaseUrl('')
    },
  })

  const deleteEndpoint = useMutation({
    mutationFn: (endpointPlatform: string) => apiFetch(`/api/endpoints/${endpointPlatform}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-endpoints'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  const addKey = useMutation({
    mutationFn: (body: { platform: string; key: string; label?: string }) =>
      apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setPlatform('')
      setApiKey('')
      setAccountId('')
      setLabel('')
    },
  })

  const deleteKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
  })

  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  const checkKey = useMutation({
    mutationFn: (keyId: number) => apiFetch(`/api/health/check/${keyId}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  const togglePlatform = useMutation({
    mutationFn: ({ platform, enabled }: { platform: string; enabled: boolean }) =>
      apiFetch(`/api/keys/platform/${platform}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  const allPlatforms = endpoints.length > 0
    ? endpoints.map(endpoint => ({ value: endpoint.platform as Platform, label: endpoint.custom ? `${endpoint.name} (custom)` : endpoint.name }))
    : BUILT_IN_PLATFORMS
  const needsAccountId = platform === 'cloudflare'

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!platform || !apiKey) return
    if (needsAccountId && !accountId) return
    const key = needsAccountId ? `${accountId}:${apiKey}` : apiKey
    addKey.mutate({ platform, key, label: label || undefined })
  }

  const healthKeyMap = new Map<number, { status: string; lastCheckedAt: string | null }>()
  for (const k of healthData?.keys ?? []) healthKeyMap.set(k.id, k)

  const grouped = allPlatforms.map(p => ({
    ...p,
    keys: keys.filter(k => k.platform === p.value),
  })).filter(p => p.keys.length > 0)

  const healthyCount = healthData?.keys.filter(k => k.status === 'healthy').length ?? keys.filter(k => k.status === 'healthy').length
  const issueCount = healthData?.keys.filter(k => ['invalid', 'error', 'rate_limited'].includes(k.status)).length ?? 0
  const enabledPlatforms = grouped.filter(g => g.keys.some(k => k.enabled)).length

  return (
    <div>
      <PageHeader
        eyebrow="Credentials"
        title="Keys"
        description="Add provider credentials, check their health, and manage custom OpenAI-compatible endpoints. Model registration now lives on the Models page."
        actions={
          keys.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => checkAll.mutate()} disabled={checkAll.isPending}>
              {checkAll.isPending ? 'Checking...' : 'Check all'}
            </Button>
          )
        }
      />

      <div className="space-y-7">
        <UnifiedKeySection />

        <div className="grid gap-3 sm:grid-cols-4">
          <StatCard label="Provider keys" value={keys.length} />
          <StatCard label="Custom endpoints" value={customEndpoints.length} />
          <StatCard label="Healthy keys" value={healthyCount} tone="good" />
          <StatCard label="Needs attention" value={issueCount} tone={issueCount > 0 ? 'warn' : 'default'} />
        </div>

        <section className="panel-card rounded-2xl p-5 sm:p-6">
          <SectionTitle title="Custom providers" description="Add OpenAI-compatible harbors here. Register the models served by each endpoint from the Models page." />
          <div className="grid gap-3 lg:grid-cols-[220px_1fr_auto]">
            <div className="space-y-1.5">
              <Label className="text-xs">Endpoint name</Label>
              <Input value={endpointName} onChange={e => setEndpointName(e.target.value)} placeholder="Local vLLM" className="h-10 rounded-2xl bg-background" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Base URL</Label>
              <Input value={endpointBaseUrl} onChange={e => setEndpointBaseUrl(e.target.value)} placeholder="http://127.0.0.1:8000/v1" className="h-10 rounded-2xl bg-background font-mono text-xs" />
            </div>
            <Button type="button" size="lg" className="self-end rounded-2xl" disabled={!endpointName || !endpointBaseUrl || addEndpoint.isPending} onClick={() => addEndpoint.mutate({ name: endpointName, baseUrl: endpointBaseUrl })}>
              {addEndpoint.isPending ? 'Adding...' : 'Add endpoint'}
            </Button>
          </div>
          {addEndpoint.isError && <p className="mt-3 text-xs text-destructive">{(addEndpoint.error as Error).message}</p>}

          {customEndpoints.length > 0 && (
            <div className="mt-5 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-background">
              {customEndpoints.map(endpoint => (
                <div key={endpoint.platform} className="grid gap-3 px-4 py-3 sm:grid-cols-[1fr_auto_auto] sm:items-center">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{endpoint.name}</p>
                    <code className="mt-1 block truncate text-[11px] text-muted-foreground">{endpoint.baseUrl}</code>
                  </div>
                  <span className="text-xs text-muted-foreground">{endpoint.modelCount} model{endpoint.modelCount === 1 ? '' : 's'} · {endpoint.keyCount} key{endpoint.keyCount === 1 ? '' : 's'}</span>
                  <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={() => deleteEndpoint.mutate(endpoint.platform)} disabled={deleteEndpoint.isPending}>Remove</Button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="panel-card rounded-2xl p-5 sm:p-6">
          <SectionTitle title="Add a provider key" description="Cloudflare needs an account ID and token. For other providers, paste the key." />
          <form onSubmit={handleSubmit} className="grid gap-3 lg:grid-cols-[240px_1fr_180px_auto] lg:items-end">
            <div className="space-y-1.5">
              <Label className="text-xs">Platform</Label>
              <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
                <SelectTrigger className="h-10 rounded-2xl bg-background">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {allPlatforms.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {needsAccountId && (
              <div className="space-y-1.5 lg:col-span-1">
                <Label className="text-xs">Account ID</Label>
                <Input value={accountId} onChange={e => setAccountId(e.target.value)} placeholder="a1b2c3d4..." className="h-10 rounded-2xl bg-background font-mono text-xs" />
              </div>
            )}
            <div className={cn('space-y-1.5', needsAccountId ? 'lg:col-span-1' : 'lg:col-span-1')}>
              <Label className="text-xs">{needsAccountId ? 'API token' : 'API key'}</Label>
              <Input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={needsAccountId ? 'Bearer token' : 'Paste key'} className="h-10 rounded-2xl bg-background font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Label</Label>
              <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="optional" className="h-10 rounded-2xl bg-background" />
            </div>
            <Button type="submit" size="lg" className="rounded-2xl" disabled={!platform || !apiKey || (needsAccountId && !accountId) || addKey.isPending}>
              {addKey.isPending ? 'Adding...' : 'Add key'}
            </Button>
          </form>
          {addKey.isError && <p className="mt-3 text-xs text-destructive">{(addKey.error as Error).message}</p>}
        </section>

        <section>
          <SectionTitle
            title="Configured providers"
            description={enabledPlatforms > 0 ? `${enabledPlatforms} provider${enabledPlatforms === 1 ? '' : 's'} enabled for routing.` : 'Enable at least one provider to route requests.'}
          />
          {isLoading ? (
            <div className="panel-card rounded-[var(--radius-panel)] p-8 text-sm text-muted-foreground">Loading provider keys...</div>
          ) : keys.length === 0 ? (
            <EmptyState title="No provider keys yet" description="Add a key above, then enable it for routing." />
          ) : (
            <div className="space-y-4">
              {grouped.map(group => (
                <div key={group.value} className="panel-card overflow-hidden rounded-[var(--radius-panel)]">
                  <div className="flex flex-col gap-3 border-b border-border bg-card px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-3">
                      <Switch checked={group.keys.some(k => k.enabled)} onCheckedChange={(checked) => togglePlatform.mutate({ platform: group.value, enabled: checked })} disabled={togglePlatform.isPending} />
                      <div>
                        <h3 className="text-sm font-semibold">{group.label}</h3>
                        <p className="text-xs text-muted-foreground tabular-nums">{group.keys.length} key{group.keys.length === 1 ? '' : 's'}</p>
                      </div>
                    </div>
                    <span className="rounded-[var(--radius-badge)] bg-muted px-3 py-1 text-xs text-muted-foreground">{group.keys.some(k => k.enabled) ? 'Routing enabled' : 'Paused'}</span>
                  </div>
                  <div className="divide-y divide-border">
                    {group.keys.map(k => {
                      const h = healthKeyMap.get(k.id)
                      const status = h?.status ?? k.status
                      const lastChecked = h?.lastCheckedAt
                      return (
                        <div key={k.id} className="grid gap-3 px-4 py-3 transition-colors hover:bg-muted/35 sm:grid-cols-[auto_150px_1fr_auto_auto_auto] sm:items-center">
                          <span className={cn('size-2 rounded-[var(--radius-badge)]', statusDot[status] ?? statusDot.unknown)} />
                          <code className="font-mono text-xs tabular-nums">{k.maskedKey}</code>
                          <div className="min-w-0 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{k.label || 'Unlabeled key'}</span>
                            <span className="ml-2">{statusLabel[status] ?? status}</span>
                          </div>
                          <span className="text-[11px] text-muted-foreground tabular-nums">{lastChecked ? new Date(lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'not checked'}</span>
                          <Button variant="ghost" size="xs" onClick={() => checkKey.mutate(k.id)} disabled={checkKey.isPending}>Check</Button>
                          <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={() => deleteKey.mutate(k.id)} disabled={deleteKey.isPending}>Remove</Button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
