import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { invalidateRoutingQueries } from '@/lib/query-cache'
import { copyText } from '@/lib/clipboard'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { PageHeader, SectionTitle, EmptyState, ErrorState, LoadingState } from '@/components/page-header'
import { MetricCard } from '@/components/metric-card'
import { InlineNotice, StatusIndicator, type StatusTone } from '@/components/status-indicator'
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

const statusLabel: Record<string, string> = {
  healthy: 'Healthy',
  rate_limited: 'Rate-limited',
  invalid: 'Invalid',
  error: 'Error',
  unknown: 'Unchecked',
  disabled: 'Disabled',
}

const statusTone: Record<string, StatusTone> = {
  healthy: 'positive',
  rate_limited: 'warning',
  invalid: 'critical',
  error: 'critical',
  unknown: 'neutral',
  disabled: 'neutral',
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
  credentialMode: 'api-key' | 'oauth' | 'optional-api-key'
  configuredKeyCount: number
  enabledKeyCount: number
  availableKeyCount: number
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
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null }
}

interface ClientKeyEditor {
  id: number
  label: string
  rpm: string
  rpd: string
  tpm: string
  tpd: string
}

interface ConnectionInfo {
  splitMode: boolean
  dashboard: { host: string; port: number }
  publicApi: { host: string; port: number; basePath: '/v1' }
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

function validateEndpointUrl(value: string) {
  if (!value.trim()) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return 'Use an http:// or https:// URL.'
    if (url.username || url.password) return 'Do not put credentials in the endpoint URL.'
    return null
  } catch {
    return 'Enter a valid absolute URL.'
  }
}

function validateRequiredEndpointUrl(value: string) {
  return value.trim() ? validateEndpointUrl(value) : 'Base URL is required.'
}

const clientLimitLabels: Record<'rpm' | 'rpd' | 'tpm' | 'tpd', string> = {
  rpm: 'Requests per minute',
  rpd: 'Requests per day',
  tpm: 'Tokens per minute',
  tpd: 'Tokens per day',
}

function validateClientLimit(value: string, field: keyof typeof clientLimitLabels) {
  if (!value) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0
    ? null
    : `${clientLimitLabels[field]} must be a positive whole number.`
}

function connectionBaseUrl(connection: ConnectionInfo | undefined) {
  if (!connection || !connection.splitMode) return `${window.location.origin}/v1`
  const configuredHost = connection.publicApi.host
  const reachableHost = configuredHost === '0.0.0.0' || configuredHost === '::'
    ? window.location.hostname
    : configuredHost
  const unwrappedHost = reachableHost.replace(/^\[(.*)\]$/, '$1')
  const urlHost = unwrappedHost.includes(':') ? `[${unwrappedHost}]` : unwrappedHost
  return `http://${urlHost}:${connection.publicApi.port}${connection.publicApi.basePath}`
}

function ClientKeysSection() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [copiedKeyId, setCopiedKeyId] = useState<number | null>(null)
  const [connectionCopied, setConnectionCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [createdKey, setCreatedKey] = useState<ClientApiKey | null>(null)
  const [newKeyLabel, setNewKeyLabel] = useState('')
  const [keyEditor, setKeyEditor] = useState<ClientKeyEditor | null>(null)

  const { data: clientKeys = [], isLoading, isError, error, refetch } = useQuery<ClientApiKey[]>({
    queryKey: ['client-api-keys'],
    queryFn: ({ signal }) => apiFetch('/api/settings/api-keys', { signal }),
  })
  const { data: connection } = useQuery<ConnectionInfo>({
    queryKey: ['connection-info'],
    queryFn: ({ signal }) => apiFetch('/api/settings/connection', { signal }),
  })

  const createKey = useMutation({
    mutationFn: (label: string) => apiFetch<ClientApiKey>('/api/settings/api-keys', {
      method: 'POST',
      body: JSON.stringify({ label: label || 'Client key' }),
    }),
    onSuccess: (key) => {
      setCreatedKey(key)
      queryClient.invalidateQueries({ queryKey: ['client-api-keys'] })
      setNewKeyLabel('')
    },
  })

  const toggleKey = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => apiFetch<ClientApiKey>(`/api/settings/api-keys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['client-api-keys'] }),
  })

  const updateKey = useMutation({
    mutationFn: (editor: ClientKeyEditor) => apiFetch<ClientApiKey>(`/api/settings/api-keys/${editor.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        label: editor.label.trim(),
        limits: {
          rpm: editor.rpm ? Number(editor.rpm) : null,
          rpd: editor.rpd ? Number(editor.rpd) : null,
          tpm: editor.tpm ? Number(editor.tpm) : null,
          tpd: editor.tpd ? Number(editor.tpd) : null,
        },
      }),
    }),
    onSuccess: () => {
      setKeyEditor(null)
      queryClient.invalidateQueries({ queryKey: ['client-api-keys'] })
    },
  })

  const deleteClientKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/settings/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-api-keys'] })
    },
  })

  const baseUrl = connectionBaseUrl(connection)

  function editClientKey(key: ClientApiKey) {
    setKeyEditor({
      id: key.id,
      label: key.label,
      rpm: key.limits.rpm?.toString() ?? '',
      rpd: key.limits.rpd?.toString() ?? '',
      tpm: key.limits.tpm?.toString() ?? '',
      tpd: key.limits.tpd?.toString() ?? '',
    })
  }

  function validClientKeyEditor(editor: ClientKeyEditor) {
    return editor.label.trim().length > 0
      && (['rpm', 'rpd', 'tpm', 'tpd'] as const).every(field => !validateClientLimit(editor[field], field))
  }

  async function copyCreatedKey(key: ClientApiKey) {
    if (!key.key) return
    try {
      await copyText(key.key)
      setCopyError(null)
      setCopiedKeyId(key.id)
      window.setTimeout(() => setCopiedKeyId(null), 1500)
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : 'Could not copy the key.')
    }
  }

  async function copyBaseUrl() {
    try {
      await copyText(baseUrl)
      setCopyError(null)
      setConnectionCopied(true)
      window.setTimeout(() => setConnectionCopied(false), 1500)
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : 'Could not copy the base URL.')
    }
  }

  return (
    <section className="panel-card relative overflow-hidden rounded-[var(--radius-panel)] p-5" aria-labelledby="client-keys-title">
      <div className="relative flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl">
          <p className="text-xs font-medium text-muted-foreground">Local API access</p>
          <h2 id="client-keys-title" className="mt-1 text-lg font-semibold tracking-[-0.025em]">Client API keys</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Create one OpenAI-compatible key per app, agent, laptop, or experiment. Then tune routes, provider endpoints, and models per key.
          </p>
        </div>
        <div className="grid min-w-0 gap-3 sm:min-w-[360px]">
          <form className="grid gap-2 sm:grid-cols-[1fr_auto]" onSubmit={event => { event.preventDefault(); createKey.mutate(newKeyLabel.trim()) }}>
            <Label htmlFor="client-key-label" className="sr-only">Client key label</Label>
            <Input
              id="client-key-label"
              placeholder="Label, e.g. Cursor on MacBook"
              value={newKeyLabel}
              onChange={(event) => setNewKeyLabel(event.target.value)}
              maxLength={80}
            />
            <Button type="submit" disabled={createKey.isPending}>
              {createKey.isPending ? 'Creating...' : 'New key'}
            </Button>
          </form>
          <div className="rounded-[var(--radius-button)] border border-border bg-background px-3 py-2 text-xs leading-5 text-muted-foreground">
            Use Access policy to restrict routes, providers, or individual models for each client.
          </div>
        </div>
      </div>

      <div className="relative mt-5 grid gap-3 text-xs sm:grid-cols-2">
        <div className="flex min-w-0 items-center justify-between gap-3 rounded-[var(--radius-button)] border border-border bg-background px-3 py-2">
          <div className="min-w-0"><span className="block text-muted-foreground">{connection?.splitMode ? 'Public API base URL' : 'Base URL'}</span><code className="mt-0.5 block truncate font-mono">{baseUrl}</code></div>
          <Button type="button" variant="ghost" size="xs" onClick={() => void copyBaseUrl()}>{connectionCopied ? 'Copied' : 'Copy'}</Button>
        </div>
        <div className="rounded-[var(--radius-button)] border border-border bg-background px-3 py-2">
          <span className="block text-muted-foreground">Endpoint</span>
          <code className="mt-0.5 block truncate font-mono">/v1/chat/completions</code>
        </div>
      </div>

      {createdKey?.key && (
        <div className="relative mt-4 rounded-[var(--radius-panel)] border border-amber-500/30 bg-amber-500/10 p-3 text-xs" role="status">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-semibold text-amber-900 dark:text-amber-100">Copy this new key now. It will only be shown once.</p>
              <code className="mt-2 block overflow-x-auto rounded-[var(--radius-button)] bg-background px-3 py-2 font-mono select-all">{createdKey.key}</code>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" onClick={() => void copyCreatedKey(createdKey)} aria-label="Copy newly created client key">{copiedKeyId === createdKey.id ? 'Copied' : 'Copy key'}</Button>
              <Button size="sm" variant="outline" onClick={() => setCreatedKey(null)}>Done</Button>
            </div>
          </div>
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite">{copiedKeyId ? 'Client key copied to clipboard.' : ''}</div>
      {copyError ? <InlineNotice tone="critical" className="mt-3">{copyError}</InlineNotice> : null}

      <div className="relative mt-5 space-y-3">
        {createKey.isError || toggleKey.isError || updateKey.isError || deleteClientKey.isError ? (
          <InlineNotice tone="critical">{(createKey.error ?? toggleKey.error ?? updateKey.error ?? deleteClientKey.error)?.message ?? 'Could not update the client key.'}</InlineNotice>
        ) : null}
        {isLoading ? (
          <LoadingState title="Loading client keys" description="Checking local API credentials…" />
        ) : isError ? (
          <ErrorState title="Could not load client keys" description={error.message} action={<Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>} />
        ) : clientKeys.length === 0 ? (
          <EmptyState title="No client keys yet" description="Create a key to call the local OpenAI-compatible API." />
        ) : clientKeys.map((key) => (
          <div key={key.id} className="rounded-[var(--radius-panel)] border border-border bg-background p-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-foreground">{key.label}</p>
                  <StatusIndicator label={key.enabled ? 'Enabled' : 'Disabled'} tone={key.enabled ? 'positive' : 'neutral'} />
                </div>
                <code className="mt-2 block truncate rounded-[var(--radius-button)] bg-muted/70 px-3 py-2 font-mono text-xs tabular-nums select-all">{key.maskedKey}</code>
                <p className="mt-2 text-xs text-muted-foreground">Created {formatDateTime(key.createdAt)} · Last used {formatRelativeTime(key.lastUsedAt)}</p>
                <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                  Limits: {key.limits.rpm ? `${key.limits.rpm} RPM` : 'RPM unlimited'} · {key.limits.rpd ? `${key.limits.rpd} RPD` : 'RPD unlimited'} · {key.limits.tpm ? `${key.limits.tpm} TPM` : 'TPM unlimited'} · {key.limits.tpd ? `${key.limits.tpd} TPD` : 'TPD unlimited'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => navigate(`/settings?key=${key.id}#access-policies`)}>Access policy</Button>
                <Button variant="outline" size="sm" onClick={() => editClientKey(key)}>Edit</Button>
                <Switch checked={key.enabled} onCheckedChange={(enabled) => toggleKey.mutate({ id: key.id, enabled })} aria-label={`${key.enabled ? 'Disable' : 'Enable'} client key ${key.label}`} />
                <Button variant="ghost" size="sm" onClick={() => { if (window.confirm(`Delete client key "${key.label}"?`)) deleteClientKey.mutate(key.id) }} disabled={deleteClientKey.isPending} aria-label={`Delete client key ${key.label}`}>Delete</Button>
              </div>
            </div>
            {keyEditor?.id === key.id ? (
              <form className="mt-4 grid gap-3 border-t border-border pt-4 lg:grid-cols-[minmax(180px,1.5fr)_repeat(4,minmax(90px,1fr))_auto] lg:items-end" onSubmit={event => { event.preventDefault(); if (validClientKeyEditor(keyEditor)) updateKey.mutate(keyEditor) }}>
                <div className="space-y-1.5">
                  <Label htmlFor={`client-key-edit-label-${key.id}`} className="text-xs">Label</Label>
                  <Input
                    id={`client-key-edit-label-${key.id}`}
                    value={keyEditor.label}
                    maxLength={80}
                    required
                    aria-invalid={!keyEditor.label.trim()}
                    aria-describedby={!keyEditor.label.trim() ? `client-key-edit-label-error-${key.id}` : undefined}
                    onChange={event => setKeyEditor(current => current ? { ...current, label: event.target.value } : current)}
                  />
                  {!keyEditor.label.trim() ? <p id={`client-key-edit-label-error-${key.id}`} className="text-[11px] text-destructive">A label is required.</p> : null}
                </div>
                {(['rpm', 'rpd', 'tpm', 'tpd'] as const).map(field => {
                  const validationError = validateClientLimit(keyEditor[field], field)
                  const errorId = `client-key-${field}-error-${key.id}`
                  return (
                    <div className="space-y-1.5" key={field}>
                      <Label htmlFor={`client-key-${field}-${key.id}`} className="text-xs uppercase">{field}</Label>
                      <Input
                        id={`client-key-${field}-${key.id}`}
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        placeholder="Unlimited"
                        value={keyEditor[field]}
                        aria-invalid={Boolean(validationError)}
                        aria-describedby={validationError ? errorId : undefined}
                        onChange={event => setKeyEditor(current => current ? { ...current, [field]: event.target.value } : current)}
                      />
                      {validationError ? <p id={errorId} className="text-[11px] leading-4 text-destructive">{validationError}</p> : null}
                    </div>
                  )
                })}
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={!validClientKeyEditor(keyEditor) || updateKey.isPending}>{updateKey.isPending ? 'Saving…' : 'Save'}</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setKeyEditor(null)}>Cancel</Button>
                </div>
              </form>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  )
}

export default function KeysPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [platform, setPlatform] = useState<Platform | ''>('')
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [label, setLabel] = useState('')
  const [endpointName, setEndpointName] = useState('')
  const [endpointBaseUrl, setEndpointBaseUrl] = useState('')
  const [endpointEditor, setEndpointEditor] = useState<{ platform: string; name: string; baseUrl: string } | null>(null)
  const [importPlatform, setImportPlatform] = useState('')
  const [importLabelPrefix, setImportLabelPrefix] = useState('')
  const [importContents, setImportContents] = useState('')
  const [importFileName, setImportFileName] = useState('')
  const [importFileError, setImportFileError] = useState<string | null>(null)
  const [lastImport, setLastImport] = useState<BulkImportResult | null>(null)
  const importFileRef = useRef<HTMLInputElement | null>(null)

  const { data: keys = [], isLoading, isError, error, refetch } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: ({ signal }) => apiFetch('/api/keys', { signal }),
  })

  const { data: healthData, isError: healthError, error: healthQueryError } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: ({ signal }) => apiFetch('/api/health', { signal }),
    refetchInterval: 30000,
  })

  const { data: endpoints = [], isError: endpointsError, error: endpointsQueryError, refetch: refetchEndpoints } = useQuery<EndpointSummary[]>({
    queryKey: ['custom-endpoints'],
    queryFn: ({ signal }) => apiFetch('/api/endpoints', { signal }),
  })

  const { data: providerTargets = [], isError: providerTargetsError, error: providerTargetsQueryError, refetch: refetchProviderTargets } = useQuery<ProviderImportTarget[]>({
    queryKey: ['key-import-providers'],
    queryFn: ({ signal }) => apiFetch('/api/keys/providers', { signal }),
  })

  const customEndpoints = endpoints.filter(endpoint => endpoint.custom)
  const endpointUrlError = useMemo(() => validateEndpointUrl(endpointBaseUrl), [endpointBaseUrl])
  const importLineCount = useMemo(
    () => importContents.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).length,
    [importContents],
  )

  const addEndpoint = useMutation({
    mutationFn: (body: { name: string; baseUrl: string }) =>
      apiFetch<EndpointSummary>('/api/endpoints', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      void invalidateRoutingQueries(queryClient)
      setEndpointName('')
      setEndpointBaseUrl('')
    },
  })

  const deleteEndpoint = useMutation({
    mutationFn: (endpointPlatform: string) => apiFetch(`/api/endpoints/${encodeURIComponent(endpointPlatform)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void invalidateRoutingQueries(queryClient)
    },
  })

  const toggleEndpoint = useMutation({
    mutationFn: ({ endpointPlatform, enabled }: { endpointPlatform: string; enabled: boolean }) =>
      apiFetch(`/api/endpoints/${encodeURIComponent(endpointPlatform)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      void invalidateRoutingQueries(queryClient)
    },
  })

  const updateEndpoint = useMutation({
    mutationFn: (editor: { platform: string; name: string; baseUrl: string }) =>
      apiFetch(`/api/endpoints/${encodeURIComponent(editor.platform)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editor.name.trim(), baseUrl: editor.baseUrl.trim() }),
      }),
    onSuccess: () => {
      setEndpointEditor(null)
      void invalidateRoutingQueries(queryClient)
    },
  })

  const addKey = useMutation({
    mutationFn: (body: { platform: string; key: string; label?: string }) =>
      apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      void invalidateRoutingQueries(queryClient)
      setPlatform('')
      setApiKey('')
      setAccountId('')
      setLabel('')
    },
  })

  const deleteKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void invalidateRoutingQueries(queryClient)
    },
  })

  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST', timeoutMs: 300_000 }),
    onSuccess: () => {
      void invalidateRoutingQueries(queryClient)
    },
  })

  const checkKey = useMutation({
    mutationFn: (keyId: number) => apiFetch(`/api/health/check/${keyId}`, { method: 'POST' }),
    onSuccess: () => {
      void invalidateRoutingQueries(queryClient)
    },
  })

  const togglePlatform = useMutation({
    mutationFn: ({ platform, enabled }: { platform: string; enabled: boolean }) =>
      apiFetch(`/api/keys/platform/${encodeURIComponent(platform)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      void invalidateRoutingQueries(queryClient)
    },
  })

  const toggleProviderKey = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiFetch(`/api/keys/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      void invalidateRoutingQueries(queryClient)
    },
  })

  const bulkImport = useMutation({
    mutationFn: () => apiFetch<BulkImportResult>('/api/keys/import', {
      method: 'POST',
      body: JSON.stringify({
        platform: importPlatform,
        contents: importContents,
        labelPrefix: importLabelPrefix || undefined,
      }),
    }),
    onSuccess: (result) => {
      setLastImport(result)
      setImportContents('')
      setImportFileName('')
      if (importFileRef.current) importFileRef.current.value = ''
      void invalidateRoutingQueries(queryClient)
    },
  })

  const allPlatforms = endpoints.length > 0
    ? endpoints
      .filter(endpoint => endpoint.credentialMode !== 'oauth')
      .map(endpoint => ({ value: endpoint.platform as Platform, label: endpoint.custom ? `${endpoint.name} (custom)` : endpoint.name }))
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
    setImportContents('')
    setImportFileError(null)
    try {
      if (file.size > 250_000) throw new Error('Import files must be 250 KB or smaller. Split larger lists into separate files.')
      setImportContents(await file.text())
    } catch (error) {
      setImportFileError(error instanceof Error ? error.message : 'Could not read the selected file.')
      if (importFileRef.current) importFileRef.current.value = ''
    }
  }

  const selectedImportTarget = providerTargets.find(target => target.platform === importPlatform)

  const healthKeyMap = new Map<number, { status: string; lastCheckedAt: string | null }>()
  for (const k of healthData?.keys ?? []) healthKeyMap.set(k.id, k)

  const grouped = allPlatforms.map(p => ({
    ...p,
    endpoint: endpoints.find(endpoint => endpoint.platform === p.value),
    keys: keys.filter(k => k.platform === p.value),
  })).filter(p => p.keys.length > 0)

  const healthyCount = healthData?.keys.filter(k => k.status === 'healthy').length ?? keys.filter(k => k.status === 'healthy').length
  const issueCount = healthData?.keys.filter(k => ['invalid', 'error', 'rate_limited'].includes(k.status)).length ?? 0
  const enabledPlatforms = grouped.filter(g => g.keys.some(k => k.enabled)).length

  return (
    <div>
      <PageHeader
        eyebrow="Provider capacity"
        title="Providers & keys"
        description="Manage local client access, encrypted upstream credentials, health checks, and custom OpenAI-compatible endpoints."
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
          <MetricCard label="Provider keys" value={keys.length} detail={`${enabledPlatforms} providers enabled`} />
          <MetricCard label="Custom endpoints" value={customEndpoints.length} detail="OpenAI-compatible" />
          <MetricCard label="Healthy keys" value={healthyCount} detail="Latest health check" tone={healthyCount > 0 ? 'positive' : 'default'} />
          <MetricCard label="Needs attention" value={issueCount} detail="Invalid, failed, or limited" tone={issueCount > 0 ? 'warning' : 'positive'} />
        </div>

        <section className="panel-card rounded-[var(--radius-panel)] p-5">
          <SectionTitle title="Custom providers" description="Add OpenAI-compatible endpoints here. Register the models served by each endpoint from the Models page." />
          {endpointsError ? <ErrorState title="Could not load provider endpoints" description={endpointsQueryError.message} action={<Button variant="outline" size="sm" onClick={() => refetchEndpoints()}>Retry</Button>} /> : null}
          <form className="grid gap-3 lg:grid-cols-[220px_1fr_auto]" onSubmit={event => { event.preventDefault(); if (endpointName.trim() && endpointBaseUrl.trim() && !endpointUrlError) addEndpoint.mutate({ name: endpointName.trim(), baseUrl: endpointBaseUrl.trim() }) }}>
            <div className="space-y-1.5">
              <Label htmlFor="custom-endpoint-name" className="text-xs">Endpoint name</Label>
              <Input id="custom-endpoint-name" value={endpointName} onChange={e => setEndpointName(e.target.value)} placeholder="Local vLLM" maxLength={80} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="custom-endpoint-base-url" className="text-xs">Base URL</Label>
              <Input id="custom-endpoint-base-url" type="url" value={endpointBaseUrl} onChange={e => setEndpointBaseUrl(e.target.value)} placeholder="http://127.0.0.1:8000/v1" className="font-mono text-xs" required aria-invalid={Boolean(endpointUrlError)} aria-describedby="custom-endpoint-url-help" spellCheck={false} />
              <p id="custom-endpoint-url-help" className={cn('text-[11px]', endpointUrlError ? 'text-destructive' : 'text-muted-foreground')}>{endpointUrlError ?? 'Credentials are stored separately; do not include them in the URL.'}</p>
            </div>
            <Button type="submit" size="lg" className="self-end" disabled={!endpointName.trim() || !endpointBaseUrl.trim() || Boolean(endpointUrlError) || addEndpoint.isPending}>
              {addEndpoint.isPending ? 'Adding...' : 'Add endpoint'}
            </Button>
          </form>
          {addEndpoint.isError ? <InlineNotice tone="critical" className="mt-3">{addEndpoint.error.message}</InlineNotice> : null}
          {updateEndpoint.isError ? <InlineNotice tone="critical" className="mt-3">{updateEndpoint.error.message}</InlineNotice> : null}

          {customEndpoints.length > 0 && (
            <div className="mt-5 divide-y divide-border overflow-hidden rounded-[var(--radius-panel)] border border-border bg-background">
              {customEndpoints.map(endpoint => endpointEditor?.platform === endpoint.platform ? (
                <form key={endpoint.platform} className="grid gap-3 px-4 py-3 lg:grid-cols-[220px_minmax(0,1fr)_auto] lg:items-end" onSubmit={event => { event.preventDefault(); if (endpointEditor.name.trim() && endpointEditor.baseUrl.trim() && !validateEndpointUrl(endpointEditor.baseUrl)) updateEndpoint.mutate(endpointEditor) }}>
                  <div className="space-y-1.5">
                    <Label htmlFor={`endpoint-edit-name-${endpoint.id}`} className="text-xs">Name</Label>
                    <Input
                      id={`endpoint-edit-name-${endpoint.id}`}
                      value={endpointEditor.name}
                      maxLength={80}
                      required
                      aria-invalid={!endpointEditor.name.trim()}
                      aria-describedby={!endpointEditor.name.trim() ? `endpoint-edit-name-error-${endpoint.id}` : undefined}
                      onChange={event => setEndpointEditor(current => current ? { ...current, name: event.target.value } : current)}
                    />
                    {!endpointEditor.name.trim() ? <p id={`endpoint-edit-name-error-${endpoint.id}`} className="text-[11px] text-destructive">An endpoint name is required.</p> : null}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`endpoint-edit-url-${endpoint.id}`} className="text-xs">Base URL</Label>
                    <Input
                      id={`endpoint-edit-url-${endpoint.id}`}
                      type="url"
                      className="font-mono text-xs"
                      value={endpointEditor.baseUrl}
                      maxLength={500}
                      required
                      aria-invalid={Boolean(validateRequiredEndpointUrl(endpointEditor.baseUrl))}
                      aria-describedby={validateRequiredEndpointUrl(endpointEditor.baseUrl) ? `endpoint-edit-url-error-${endpoint.id}` : undefined}
                      onChange={event => setEndpointEditor(current => current ? { ...current, baseUrl: event.target.value } : current)}
                    />
                    {validateRequiredEndpointUrl(endpointEditor.baseUrl) ? <p id={`endpoint-edit-url-error-${endpoint.id}`} className="text-[11px] text-destructive">{validateRequiredEndpointUrl(endpointEditor.baseUrl)}</p> : null}
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={updateEndpoint.isPending || !endpointEditor.name.trim() || Boolean(validateRequiredEndpointUrl(endpointEditor.baseUrl))}>{updateEndpoint.isPending ? 'Saving…' : 'Save'}</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEndpointEditor(null)}>Cancel</Button>
                  </div>
                </form>
              ) : (
                <div key={endpoint.platform} className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] sm:items-center">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{endpoint.name}</p>
                    <code className="mt-1 block truncate text-[11px] text-muted-foreground">{endpoint.baseUrl}</code>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {endpoint.modelCount} model{endpoint.modelCount === 1 ? '' : 's'} · {endpoint.availableKeyCount}/{endpoint.configuredKeyCount} usable credentials
                  </span>
                  <div className="flex items-center gap-2">
                    <StatusIndicator label={endpoint.enabled ? 'Enabled' : 'Disabled'} tone={endpoint.enabled ? (endpoint.availableKeyCount > 0 ? 'positive' : 'warning') : 'neutral'} />
                    <Switch
                      checked={endpoint.enabled}
                      onCheckedChange={(enabled) => toggleEndpoint.mutate({ endpointPlatform: endpoint.platform, enabled })}
                      disabled={toggleEndpoint.isPending}
                      aria-label={`${endpoint.enabled ? 'Disable' : 'Enable'} custom endpoint ${endpoint.name}`}
                    />
                  </div>
                  <Button variant="ghost" size="xs" onClick={() => setEndpointEditor({ platform: endpoint.platform, name: endpoint.name, baseUrl: endpoint.baseUrl ?? '' })}>Edit</Button>
                  <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={() => { if (window.confirm(`Remove custom endpoint "${endpoint.name}"? This also deletes its ${endpoint.modelCount} registered model${endpoint.modelCount === 1 ? '' : 's'}, ${endpoint.configuredKeyCount} stored credential${endpoint.configuredKeyCount === 1 ? '' : 's'}, and routing configuration.`)) deleteEndpoint.mutate(endpoint.platform) }} disabled={deleteEndpoint.isPending} aria-label={`Remove custom endpoint ${endpoint.name}`}>Remove</Button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="panel-card rounded-[var(--radius-panel)] p-5">
          <SectionTitle title="Add a provider key" description="Cloudflare needs an account ID and token. For other providers, paste the key." />
          <form onSubmit={handleSubmit} className="grid gap-3 lg:grid-cols-[240px_1fr_180px_auto] lg:items-end">
            <div className="space-y-1.5">
              <Label className="text-xs" id="provider-platform-label">Platform</Label>
              <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
                <SelectTrigger className="w-full" aria-labelledby="provider-platform-label">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {allPlatforms.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {needsAccountId && (
              <div className="space-y-1.5 lg:col-span-1">
                <Label htmlFor="provider-account-id" className="text-xs">Account ID</Label>
                <Input id="provider-account-id" value={accountId} onChange={e => setAccountId(e.target.value)} placeholder="a1b2c3d4..." className="font-mono text-xs" autoComplete="off" spellCheck={false} />
              </div>
            )}
            <div className={cn('space-y-1.5', needsAccountId ? 'lg:col-span-1' : 'lg:col-span-1')}>
              <Label htmlFor="provider-api-key" className="text-xs">{needsAccountId ? 'API token' : 'API key'}</Label>
              <Input id="provider-api-key" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={needsAccountId ? 'Bearer token' : 'Paste key'} className="font-mono text-xs" autoComplete="new-password" spellCheck={false} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="provider-key-label" className="text-xs">Label</Label>
              <Input id="provider-key-label" value={label} onChange={e => setLabel(e.target.value)} placeholder="optional" maxLength={80} />
            </div>
            <Button type="submit" size="lg" disabled={!platform || !apiKey.trim() || (needsAccountId && !accountId.trim()) || addKey.isPending}>
              {addKey.isPending ? 'Adding...' : 'Add key'}
            </Button>
          </form>
          {addKey.isError ? <InlineNotice tone="critical" className="mt-3">{addKey.error.message}</InlineNotice> : null}
        </section>

        <section className="panel-card rounded-[var(--radius-panel)] p-5">
          <SectionTitle
            title="Bulk import provider keys"
            description="Upload a .txt file with one key per line. Choose a provider from the live target list; blank lines and # comments are ignored."
          />
          <div className="grid gap-3 lg:grid-cols-[240px_1fr_180px_auto] lg:items-end">
            <div className="space-y-1.5">
              <Label className="text-xs" id="provider-import-target-label">Provider target</Label>
              <Select value={importPlatform} onValueChange={(value) => setImportPlatform(value ?? '')}>
                <SelectTrigger className="w-full" aria-labelledby="provider-import-target-label">
                  <SelectValue placeholder="Choose provider" />
                </SelectTrigger>
                <SelectContent>
                  {providerTargets.map(target => (
                    <SelectItem key={target.platform} value={target.platform}>
                      {target.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="provider-import-file" className="text-xs">TXT file</Label>
              <Input id="provider-import-file" ref={importFileRef} type="file" accept=".txt,text/plain" onChange={handleImportFile} className="text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="provider-import-label-prefix" className="text-xs">Label prefix</Label>
              <Input id="provider-import-label-prefix" value={importLabelPrefix} onChange={e => setImportLabelPrefix(e.target.value)} placeholder="optional" maxLength={80} />
            </div>
            <Button
              type="button"
              size="lg"
              disabled={!importPlatform || !selectedImportTarget || !importContents || bulkImport.isPending}
              onClick={() => bulkImport.mutate()}
            >
              {bulkImport.isPending ? 'Importing...' : 'Import keys'}
            </Button>
          </div>
          {providerTargetsError ? <InlineNotice tone="critical" className="mt-3">{providerTargetsQueryError.message} <Button type="button" variant="ghost" size="xs" className="ml-2" onClick={() => refetchProviderTargets()}>Retry</Button></InlineNotice> : null}
          <div className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
            <div className="rounded-[var(--radius-button)] border border-border bg-background px-3 py-2">
              <span className="block text-muted-foreground">Selected target</span>
              <span className="mt-0.5 block font-medium">{selectedImportTarget ? selectedImportTarget.name : 'Pick a provider'}</span>
            </div>
            <div className="rounded-[var(--radius-button)] border border-border bg-background px-3 py-2">
              <span className="block text-muted-foreground">File</span>
              <span className="mt-0.5 block truncate font-medium">{importFileName || 'No file selected'}</span>
            </div>
            <div className="rounded-[var(--radius-button)] border border-border bg-background px-3 py-2">
              <span className="block text-muted-foreground">Lines ready</span>
              <span className="mt-0.5 block font-medium tabular-nums">{importLineCount}</span>
            </div>
          </div>
          {providerTargets.length === 0 && <p className="mt-3 text-xs text-muted-foreground">No provider import targets are available yet. Add or enable a provider endpoint first.</p>}
          {lastImport && (
            <InlineNotice tone="positive" className="mt-3">
              Imported {lastImport.imported} key{lastImport.imported === 1 ? '' : 's'} for {lastImport.providerName}; skipped {lastImport.skipped} duplicate{lastImport.skipped === 1 ? '' : 's'}.
            </InlineNotice>
          )}
          {bulkImport.isError ? <InlineNotice tone="critical" className="mt-3">{bulkImport.error.message}</InlineNotice> : null}
          {importFileError ? <InlineNotice tone="critical" className="mt-3">{importFileError}</InlineNotice> : null}
        </section>

        <section>
          <SectionTitle
            title="Configured providers"
            description={enabledPlatforms > 0 ? `${enabledPlatforms} provider${enabledPlatforms === 1 ? '' : 's'} enabled for routing.` : 'Enable at least one provider to route requests.'}
          />
          {healthError ? <InlineNotice tone="warning" className="mb-3">Credential health is temporarily unavailable: {healthQueryError.message}</InlineNotice> : null}
          {checkAll.isError || checkKey.isError || togglePlatform.isError || toggleProviderKey.isError || toggleEndpoint.isError || deleteKey.isError || deleteEndpoint.isError ? (
            <InlineNotice tone="critical" className="mb-3">{(checkAll.error ?? checkKey.error ?? togglePlatform.error ?? toggleProviderKey.error ?? toggleEndpoint.error ?? deleteKey.error ?? deleteEndpoint.error)?.message ?? 'Could not update provider credentials.'}</InlineNotice>
          ) : null}
          {isLoading ? (
            <LoadingState title="Loading provider keys" description="Checking configured provider credentials…" />
          ) : isError ? (
            <ErrorState title="Could not load provider keys" description={error.message} action={<Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>} />
          ) : keys.length === 0 ? (
            <EmptyState title="No provider keys yet" description="Add a key above, then enable it for routing." action={<Button type="button" variant="outline" size="sm" onClick={() => document.getElementById('provider-platform-label')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>Go to add key</Button>} />
          ) : (
            <div className="space-y-4">
              {grouped.map(group => (
                <div key={group.value} className="panel-card overflow-hidden rounded-[var(--radius-panel)]">
                  <div className="flex flex-col gap-3 border-b border-border bg-card px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-3">
                      <Switch checked={group.keys.some(k => k.enabled)} onCheckedChange={(checked) => togglePlatform.mutate({ platform: group.value, enabled: checked })} disabled={togglePlatform.isPending} aria-label={`${group.keys.some(k => k.enabled) ? 'Disable' : 'Enable'} provider ${group.label}`} />
                      <div>
                        <h3 className="text-sm font-semibold">{group.label}</h3>
                        <p className="text-xs text-muted-foreground tabular-nums">{group.keys.length} key{group.keys.length === 1 ? '' : 's'}</p>
                      </div>
                    </div>
                    <StatusIndicator
                      label={group.endpoint && !group.endpoint.enabled ? 'Endpoint disabled' : group.keys.some(k => k.enabled) ? 'Routing enabled' : 'Paused'}
                      tone={group.endpoint && !group.endpoint.enabled ? 'warning' : group.keys.some(k => k.enabled) ? 'positive' : 'neutral'}
                    />
                  </div>
                  <div className="divide-y divide-border">
                    {group.keys.map(k => {
                      const h = healthKeyMap.get(k.id)
                      const status = k.enabled ? (h?.status ?? k.status) : 'disabled'
                      const lastChecked = h?.lastCheckedAt
                      return (
                        <div key={k.id} className="grid gap-3 px-4 py-3 transition-colors hover:bg-muted/30 sm:grid-cols-[150px_minmax(0,1fr)_auto_auto_auto_auto] sm:items-center">
                          <code className="font-mono text-xs tabular-nums">{k.maskedKey}</code>
                          <div className="min-w-0 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{k.label || 'Unlabeled key'}</span>
                            {k.source === 'oauth' && <span className="ml-2 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-primary">Browser account</span>}
                            <span className="mt-1 block"><StatusIndicator label={statusLabel[status] ?? status} tone={statusTone[status] ?? 'neutral'} /></span>
                          </div>
                          <span className="text-[11px] leading-5 text-muted-foreground tabular-nums">
                            <span className="block" title={formatDateTime(k.lastSuccessAt)}>Success {k.lastSuccessAt ? formatRelativeTime(k.lastSuccessAt) : 'never'}</span>
                            <span className="block" title={formatDateTime(lastChecked)}>Checked {lastChecked ? formatRelativeTime(lastChecked) : 'never'}</span>
                          </span>
                          <Switch
                            checked={k.enabled}
                            onCheckedChange={(enabled) => toggleProviderKey.mutate({ id: k.id, enabled })}
                            disabled={toggleProviderKey.isPending}
                            aria-label={`${k.enabled ? 'Disable' : 'Enable'} key ${k.label || k.maskedKey}`}
                          />
                          <Button variant="ghost" size="xs" onClick={() => checkKey.mutate(k.id)} disabled={checkKey.isPending} aria-label={`Check key ${k.label || k.maskedKey}`}>Check</Button>
                          {k.source === 'oauth' ? (
                            <Button variant="ghost" size="xs" onClick={() => navigate('/oauth')} aria-label={`Manage OAuth account ${k.label || k.maskedKey}`}>Manage account</Button>
                          ) : (
                            <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={() => { if (window.confirm(`Remove provider key "${k.label || k.maskedKey}"?`)) deleteKey.mutate(k.id) }} disabled={deleteKey.isPending} aria-label={`Remove key ${k.label || k.maskedKey}`}>Remove</Button>
                          )}
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
