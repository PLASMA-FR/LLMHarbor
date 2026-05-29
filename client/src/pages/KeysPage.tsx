import { useEffect, useRef, useState } from 'react'
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
  { value: 'openai', label: 'OpenAI' },
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

interface ClientKeyLimits {
  rpm: number | null
  rpd: number | null
  tpm: number | null
  tpd: number | null
}

interface ClientApiKey {
  id: number
  label: string
  key?: string
  maskedKey: string
  enabled: boolean
  createdAt: string
  lastUsedAt: string | null
  localEndpointId?: number | null
  limits: ClientKeyLimits
}

type LimitKey = keyof ClientKeyLimits

type LimitDraft = Record<LimitKey, string>

const LIMIT_FIELDS: Array<{ key: LimitKey; label: string; helper: string }> = [
  { key: 'rpm', label: 'RPM', helper: 'requests/min' },
  { key: 'rpd', label: 'RPD', helper: 'requests/day' },
  { key: 'tpm', label: 'TPM', helper: 'tokens/min' },
  { key: 'tpd', label: 'TPD', helper: 'tokens/day' },
]

const EMPTY_LIMIT_DRAFT: LimitDraft = { rpm: '', rpd: '', tpm: '', tpd: '' }

function limitsToDraft(limits?: Partial<ClientKeyLimits>): LimitDraft {
  return {
    rpm: limits?.rpm ? String(limits.rpm) : '',
    rpd: limits?.rpd ? String(limits.rpd) : '',
    tpm: limits?.tpm ? String(limits.tpm) : '',
    tpd: limits?.tpd ? String(limits.tpd) : '',
  }
}

function draftToLimits(draft: LimitDraft): ClientKeyLimits {
  return LIMIT_FIELDS.reduce((acc, field) => {
    const value = draft[field.key].trim()
    acc[field.key] = value ? Number(value) : null
    return acc
  }, { rpm: null, rpd: null, tpm: null, tpd: null } as ClientKeyLimits)
}

function limitSummary(limits: ClientKeyLimits) {
  const active = LIMIT_FIELDS
    .map(field => limits[field.key] ? `${field.label} ${limits[field.key]}` : null)
    .filter(Boolean)
  return active.length > 0 ? active.join(' · ') : 'Unlimited'
}

interface ProviderImportTarget {
  providerId: number
  platform: string
  name: string
}

interface BulkImportResult {
  providerId: number
  platform: string
  providerName: string
  attempted: number
  imported: number
  skipped: number
}

function ClientKeyLimitEditor({ keyRecord, onSave, saving }: { keyRecord: ClientApiKey; onSave: (limits: ClientKeyLimits) => void; saving: boolean }) {
  const [draft, setDraft] = useState<LimitDraft>(() => limitsToDraft(keyRecord.limits))

  useEffect(() => {
    setDraft(limitsToDraft(keyRecord.limits))
  }, [keyRecord.limits.rpm, keyRecord.limits.rpd, keyRecord.limits.tpm, keyRecord.limits.tpd])

  return (
    <div className="mt-3 rounded-2xl border border-border/70 bg-card/60 p-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Local limits</p>
          <p className="text-xs text-muted-foreground">{limitSummary(keyRecord.limits)}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => onSave(draftToLimits(draft))} disabled={saving}>
          {saving ? 'Saving...' : 'Save limits'}
        </Button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        {LIMIT_FIELDS.map(field => (
          <div key={field.key} className="grid gap-1">
            <Label className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{field.label}</Label>
            <Input
              inputMode="numeric"
              pattern="[0-9]*"
              min={1}
              value={draft[field.key]}
              onChange={event => setDraft(prev => ({ ...prev, [field.key]: event.target.value.replace(/[^0-9]/g, '') }))}
              placeholder="∞"
            />
            <span className="text-[10px] text-muted-foreground">{field.helper}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ClientKeysSection() {
  const queryClient = useQueryClient()
  const [visibleKeyId, setVisibleKeyId] = useState<number | null>(null)
  const [copiedKeyId, setCopiedKeyId] = useState<number | null>(null)
  const [createdKey, setCreatedKey] = useState<ClientApiKey | null>(null)
  const [newKeyLabel, setNewKeyLabel] = useState('')
  const [newKeyLimits, setNewKeyLimits] = useState<LimitDraft>(EMPTY_LIMIT_DRAFT)

  const { data: clientKeys = [] } = useQuery<ClientApiKey[]>({
    queryKey: ['client-api-keys'],
    queryFn: () => apiFetch('/api/settings/api-keys'),
  })

  const createKey = useMutation({
    mutationFn: ({ label, limits }: { label: string; limits: ClientKeyLimits }) => apiFetch<ClientApiKey>('/api/settings/api-keys', {
      method: 'POST',
      body: JSON.stringify({ label: label || 'Personal key', limits }),
    }),
    onSuccess: (key) => {
      setCreatedKey(key)
      queryClient.invalidateQueries({ queryKey: ['client-api-keys'] })
      queryClient.invalidateQueries({ queryKey: ['unified-key'] })
      setNewKeyLabel('')
      setNewKeyLimits(EMPTY_LIMIT_DRAFT)
    },
  })

  const toggleKey = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => apiFetch<ClientApiKey>(`/api/settings/api-keys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['client-api-keys'] }),
  })

  const updateKeyLimits = useMutation({
    mutationFn: ({ id, limits }: { id: number; limits: ClientKeyLimits }) => apiFetch<ClientApiKey>(`/api/settings/api-keys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ limits }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['client-api-keys'] }),
  })

  const deleteClientKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/settings/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-api-keys'] })
      queryClient.invalidateQueries({ queryKey: ['unified-key'] })
    },
  })

  const baseUrl = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`

  function copy(key: ClientApiKey) {
    if (!key.key) return
    navigator.clipboard.writeText(key.key)
    setCopiedKeyId(key.id)
    setTimeout(() => setCopiedKeyId(null), 1500)
  }

  return (
    <section className="panel-card relative overflow-hidden rounded-2xl p-5 sm:p-6">
      <div className="relative flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-primary/80">Personal API platform</p>
          <h2 className="mt-2 text-xl font-semibold tracking-[-0.035em]">Client API keys</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Create one OpenAI-compatible key per app, agent, laptop, or experiment. Revoke a single client without touching provider credentials.
          </p>
        </div>
        <div className="grid min-w-0 gap-3 sm:min-w-[360px]">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <Input
              placeholder="Label, e.g. Cursor on MacBook"
              value={newKeyLabel}
              onChange={(event) => setNewKeyLabel(event.target.value)}
            />
            <Button onClick={() => createKey.mutate({ label: newKeyLabel, limits: draftToLimits(newKeyLimits) })} disabled={createKey.isPending}>
              {createKey.isPending ? 'Creating...' : 'New key'}
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-4">
            {LIMIT_FIELDS.map(field => (
              <div key={field.key} className="grid gap-1">
                <Label className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{field.label}</Label>
                <Input
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={newKeyLimits[field.key]}
                  onChange={event => setNewKeyLimits(prev => ({ ...prev, [field.key]: event.target.value.replace(/[^0-9]/g, '') }))}
                  placeholder="∞"
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="relative mt-5 grid gap-3 text-xs sm:grid-cols-2">
        <div className="rounded-2xl bg-card px-3 py-2">
          <span className="block text-muted-foreground">Base URL</span>
          <code className="mt-0.5 block truncate font-mono">{baseUrl}</code>
        </div>
        <div className="rounded-2xl bg-card px-3 py-2">
          <span className="block text-muted-foreground">Endpoint</span>
          <code className="mt-0.5 block truncate font-mono">/v1/chat/completions</code>
        </div>
      </div>

      {createdKey?.key && (
        <div className="relative mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-semibold text-amber-900 dark:text-amber-100">Copy this new key now. It will only be shown once.</p>
              <code className="mt-2 block truncate rounded-xl bg-background/80 px-3 py-2 font-mono select-all">{createdKey.key}</code>
            </div>
            <Button size="sm" onClick={() => copy(createdKey)}>{copiedKeyId === createdKey.id ? 'Copied' : 'Copy key'}</Button>
          </div>
        </div>
      )}

      <div className="relative mt-5 space-y-3">
        {clientKeys.length === 0 ? (
          <EmptyState title="No client keys yet" description="Create a key to call the local OpenAI-compatible API." />
        ) : clientKeys.map((key) => (
          <div key={key.id} className="rounded-2xl border border-border bg-background p-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-foreground">{key.label}</p>
                  <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]', key.enabled ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground')}>
                    {key.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  {key.lastUsedAt && <span className="text-xs text-muted-foreground">Last used {new Date(key.lastUsedAt).toLocaleString()}</span>}
                </div>
                <code className="mt-2 block truncate rounded-xl bg-muted/70 px-3 py-2 font-mono text-xs tabular-nums select-all">
                  {visibleKeyId === key.id && key.key ? key.key : key.maskedKey}
                </code>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setVisibleKeyId(visibleKeyId === key.id ? null : key.id)} disabled={!key.key}>{visibleKeyId === key.id && key.key ? 'Hide' : 'Show'}</Button>
                <Button variant="default" size="sm" onClick={() => copy(key)} disabled={!key.key}>{copiedKeyId === key.id ? 'Copied' : 'Copy'}</Button>
                <Switch checked={key.enabled} onCheckedChange={(enabled) => toggleKey.mutate({ id: key.id, enabled })} />
                <Button variant="ghost" size="sm" onClick={() => deleteClientKey.mutate(key.id)}>Delete</Button>
              </div>
            </div>
            <ClientKeyLimitEditor
              keyRecord={key}
              saving={updateKeyLimits.isPending}
              onSave={(limits) => updateKeyLimits.mutate({ id: key.id, limits })}
            />
          </div>
        ))}
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
  const [importProviderId, setImportProviderId] = useState('')
  const [importLabelPrefix, setImportLabelPrefix] = useState('')
  const [importContents, setImportContents] = useState('')
  const [importFileName, setImportFileName] = useState('')
  const [lastImport, setLastImport] = useState<BulkImportResult | null>(null)
  const importFileRef = useRef<HTMLInputElement | null>(null)

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

  const { data: providerTargets = [] } = useQuery<ProviderImportTarget[]>({
    queryKey: ['key-import-providers'],
    queryFn: () => apiFetch('/api/keys/providers'),
  })

  const customEndpoints = endpoints.filter(endpoint => endpoint.custom)

  const addEndpoint = useMutation({
    mutationFn: (body: { name: string; baseUrl: string }) =>
      apiFetch<EndpointSummary>('/api/endpoints', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-endpoints'] })
      queryClient.invalidateQueries({ queryKey: ['key-import-providers'] })
      setEndpointName('')
      setEndpointBaseUrl('')
    },
  })

  const deleteEndpoint = useMutation({
    mutationFn: (endpointPlatform: string) => apiFetch(`/api/endpoints/${encodeURIComponent(endpointPlatform)}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-endpoints'] })
      queryClient.invalidateQueries({ queryKey: ['key-import-providers'] })
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
      apiFetch(`/api/keys/platform/${encodeURIComponent(platform)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  const bulkImport = useMutation({
    mutationFn: () => apiFetch<BulkImportResult>('/api/keys/import', {
      method: 'POST',
      body: JSON.stringify({
        providerId: Number(importProviderId),
        contents: importContents,
        labelPrefix: importLabelPrefix || undefined,
      }),
    }),
    onSuccess: (result) => {
      setLastImport(result)
      setImportContents('')
      setImportFileName('')
      if (importFileRef.current) importFileRef.current.value = ''
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

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setImportFileName(file.name)
    setImportContents(await file.text())
  }

  const selectedImportTarget = providerTargets.find(target => String(target.providerId) === importProviderId)

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
        <ClientKeysSection />

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

        <section className="panel-card rounded-2xl p-5 sm:p-6">
          <SectionTitle
            title="Bulk import provider keys"
            description="Upload a .txt file with one key per line. Select the numbered provider target first — Google is 1, Groq is 2, and custom providers continue after the built-ins. Blank lines and # comments are ignored."
          />
          <div className="grid gap-3 lg:grid-cols-[240px_1fr_180px_auto] lg:items-end">
            <div className="space-y-1.5">
              <Label className="text-xs">Provider ID</Label>
              <Select value={importProviderId} onValueChange={(value) => setImportProviderId(value ?? '')}>
                <SelectTrigger className="h-10 rounded-2xl bg-background">
                  <SelectValue placeholder="Choose ID" />
                </SelectTrigger>
                <SelectContent>
                  {providerTargets.map(target => (
                    <SelectItem key={target.providerId} value={String(target.providerId)}>
                      {target.providerId}. {target.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">TXT file</Label>
              <Input ref={importFileRef} type="file" accept=".txt,text/plain" onChange={handleImportFile} className="h-10 rounded-2xl bg-background text-xs file:mr-3 file:rounded-xl file:border-0 file:bg-muted file:px-3 file:py-1 file:text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Label prefix</Label>
              <Input value={importLabelPrefix} onChange={e => setImportLabelPrefix(e.target.value)} placeholder="optional" className="h-10 rounded-2xl bg-background" />
            </div>
            <Button
              type="button"
              size="lg"
              className="rounded-2xl"
              disabled={!importProviderId || !importContents || bulkImport.isPending}
              onClick={() => bulkImport.mutate()}
            >
              {bulkImport.isPending ? 'Importing...' : 'Import keys'}
            </Button>
          </div>
          <div className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
            <div className="rounded-2xl bg-card px-3 py-2">
              <span className="block text-muted-foreground">Selected target</span>
              <span className="mt-0.5 block font-medium">{selectedImportTarget ? `${selectedImportTarget.providerId}. ${selectedImportTarget.name}` : 'Pick a provider id'}</span>
            </div>
            <div className="rounded-2xl bg-card px-3 py-2">
              <span className="block text-muted-foreground">File</span>
              <span className="mt-0.5 block truncate font-medium">{importFileName || 'No file selected'}</span>
            </div>
            <div className="rounded-2xl bg-card px-3 py-2">
              <span className="block text-muted-foreground">Lines ready</span>
              <span className="mt-0.5 block font-medium tabular-nums">{importContents.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).length}</span>
            </div>
          </div>
          {lastImport && (
            <p className="mt-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-100">
              Imported {lastImport.imported} key{lastImport.imported === 1 ? '' : 's'} for {lastImport.providerName}; skipped {lastImport.skipped} duplicate{lastImport.skipped === 1 ? '' : 's'}.
            </p>
          )}
          {bulkImport.isError && <p className="mt-3 text-xs text-destructive">{(bulkImport.error as Error).message}</p>}
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
                            {k.source === 'oauth' && <span className="ml-2 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-primary">Browser account</span>}
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
