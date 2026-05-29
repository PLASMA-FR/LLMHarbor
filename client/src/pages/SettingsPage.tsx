import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader, SectionTitle, EmptyState } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'

interface ClientKeyLimits { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null }
interface LocalEndpointKey { id: number; label: string; key?: string; maskedKey: string; enabled: boolean; localEndpointId: number; limits: ClientKeyLimits }
interface LocalEndpoint { id: number; name: string; slug: string; basePath: string; enabled: boolean; providerScopes: string[]; domains: string[]; keys: LocalEndpointKey[] }

type LimitKey = keyof ClientKeyLimits
const LIMIT_FIELDS: Array<{ key: LimitKey; label: string }> = [
  { key: 'rpm', label: 'RPM' },
  { key: 'rpd', label: 'RPD' },
  { key: 'tpm', label: 'TPM' },
  { key: 'tpd', label: 'TPD' },
]
const EMPTY_LIMIT_DRAFT: Record<LimitKey, string> = { rpm: '', rpd: '', tpm: '', tpd: '' }
function draftToLimits(draft: Record<LimitKey, string>): ClientKeyLimits {
  return LIMIT_FIELDS.reduce((acc, field) => {
    const value = draft[field.key].trim()
    acc[field.key] = value ? Number(value) : null
    return acc
  }, { rpm: null, rpd: null, tpm: null, tpd: null } as ClientKeyLimits)
}
function limitSummary(limits: ClientKeyLimits) {
  const parts = LIMIT_FIELDS.map(field => limits[field.key] ? `${field.label} ${limits[field.key]}` : null).filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Unlimited'
}

const PROVIDER_HINTS = ['openai', 'google', 'openrouter', 'anthropic', 'github', 'groq', 'mistral', 'cohere']

function splitList(value: string) {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

export default function SettingsPage() {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [providers, setProviders] = useState('')
  const [initialDomain, setInitialDomain] = useState('')
  const [domainDrafts, setDomainDrafts] = useState<Record<number, string>>({})
  const [keyLabels, setKeyLabels] = useState<Record<number, string>>({})
  const [keyLimitDrafts, setKeyLimitDrafts] = useState<Record<number, Record<LimitKey, string>>>({})
  const [createdKey, setCreatedKey] = useState<LocalEndpointKey | null>(null)

  const { data } = useQuery<{ endpoints: LocalEndpoint[] }>({ queryKey: ['local-endpoints'], queryFn: () => apiFetch('/api/settings/local-endpoints') })
  const endpoints = data?.endpoints ?? []
  const totalDomains = useMemo(() => endpoints.reduce((sum, endpoint) => sum + endpoint.domains.length, 0), [endpoints])
  const totalKeys = useMemo(() => endpoints.reduce((sum, endpoint) => sum + endpoint.keys.length, 0), [endpoints])

  const createEndpoint = useMutation({
    mutationFn: () => apiFetch<LocalEndpoint>('/api/settings/local-endpoints', {
      method: 'POST',
      body: JSON.stringify({ name: name || slug, slug, providerScopes: splitList(providers), domains: splitList(initialDomain) }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['local-endpoints'] })
      setName('')
      setSlug('')
      setProviders('')
      setInitialDomain('')
    },
  })

  const updateEndpoint = useMutation({
    mutationFn: ({ endpoint, body }: { endpoint: LocalEndpoint; body: Partial<LocalEndpoint> }) => apiFetch<LocalEndpoint>(`/api/settings/local-endpoints/${endpoint.id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['local-endpoints'] }),
  })

  const addDomain = useMutation({
    mutationFn: ({ endpoint, domain }: { endpoint: LocalEndpoint; domain: string }) => apiFetch<LocalEndpoint>(`/api/settings/local-endpoints/${endpoint.id}/domains`, {
      method: 'POST',
      body: JSON.stringify({ domain }),
    }),
    onSuccess: (_, variables) => {
      setDomainDrafts(prev => ({ ...prev, [variables.endpoint.id]: '' }))
      queryClient.invalidateQueries({ queryKey: ['local-endpoints'] })
    },
  })

  const removeDomain = useMutation({
    mutationFn: ({ endpoint, domain }: { endpoint: LocalEndpoint; domain: string }) => apiFetch(`/api/settings/local-endpoints/${endpoint.id}/domains/${encodeURIComponent(domain)}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['local-endpoints'] }),
  })

  const createKey = useMutation({
    mutationFn: (endpoint: LocalEndpoint) => apiFetch<LocalEndpointKey>(`/api/settings/local-endpoints/${endpoint.id}/keys`, {
      method: 'POST',
      body: JSON.stringify({ label: keyLabels[endpoint.id] || `${endpoint.name} key`, limits: draftToLimits(keyLimitDrafts[endpoint.id] ?? EMPTY_LIMIT_DRAFT) }),
    }),
    onSuccess: (key) => {
      setCreatedKey(key)
      setKeyLabels(prev => ({ ...prev, [key.localEndpointId]: '' }))
      setKeyLimitDrafts(prev => ({ ...prev, [key.localEndpointId]: EMPTY_LIMIT_DRAFT }))
      queryClient.invalidateQueries({ queryKey: ['local-endpoints'] })
    },
  })

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Settings" title="Endpoint control plane" description="Create production-ready local endpoints, attach custom domains, scope providers, and issue dedicated client keys without touching upstream provider secrets." />

      <section className="grid gap-4 md:grid-cols-3">
        <div className="panel-card rounded-2xl p-4"><p className="text-xs text-muted-foreground">Endpoints</p><p className="mt-1 text-2xl font-semibold">{endpoints.length}</p></div>
        <div className="panel-card rounded-2xl p-4"><p className="text-xs text-muted-foreground">Custom domains</p><p className="mt-1 text-2xl font-semibold">{totalDomains}</p></div>
        <div className="panel-card rounded-2xl p-4"><p className="text-xs text-muted-foreground">Dedicated keys</p><p className="mt-1 text-2xl font-semibold">{totalKeys}</p></div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.2fr)]">
        <div className="panel-card rounded-2xl p-5 sm:p-6">
          <SectionTitle title="New local endpoint" description="Use a sub-endpoint when an app should only see one provider group, domain, or key set." />
          <div className="mt-5 grid gap-4">
            <div className="grid gap-2"><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="OpenAI work endpoint" /></div>
            <div className="grid gap-2"><Label>Slug</Label><Input value={slug} onChange={e => setSlug(e.target.value)} placeholder="openai-work" /></div>
            <div className="grid gap-2"><Label>Provider scopes</Label><Input value={providers} onChange={e => setProviders(e.target.value)} placeholder="openai, openrouter" /></div>
            <div className="flex flex-wrap gap-1.5">{PROVIDER_HINTS.map(provider => <button key={provider} type="button" onClick={() => setProviders(prev => splitList(prev).includes(provider) ? prev : [...splitList(prev), provider].join(', '))} className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted">{provider}</button>)}</div>
            <div className="grid gap-2"><Label>Initial custom domains</Label><Input value={initialDomain} onChange={e => setInitialDomain(e.target.value)} placeholder="api.example.com, openai.localhost:3001" /></div>
            <Button onClick={() => createEndpoint.mutate()} disabled={createEndpoint.isPending || !slug}>{createEndpoint.isPending ? 'Creating...' : 'Create endpoint'}</Button>
            {createEndpoint.error && <p className="text-sm text-destructive">{createEndpoint.error.message}</p>}
          </div>
        </div>

        <div className="space-y-5">
          {createdKey?.key && <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm"><p className="font-semibold">Copy this key now. It will only be shown once.</p><code className="mt-2 block truncate rounded-xl bg-background px-3 py-2 text-xs">{createdKey.key}</code></div>}
          {endpoints.length === 0 ? <EmptyState title="No endpoints" description="The default endpoint will appear after server initialization." /> : endpoints.map(endpoint => (
            <article key={endpoint.id} className="panel-card rounded-2xl p-5 sm:p-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold tracking-[-0.03em]">{endpoint.name}</h2>
                    <Badge variant="outline">{endpoint.basePath}</Badge>
                    {endpoint.id === 1 && <Badge>Default</Badge>}
                    <Badge variant={endpoint.enabled ? 'default' : 'secondary'}>{endpoint.enabled ? 'Enabled' : 'Disabled'}</Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">Provider scopes: {endpoint.providerScopes.join(', ') || 'all providers'}</p>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>{endpoint.enabled ? 'Accepting traffic' : 'Paused'}</span>
                  <Switch checked={endpoint.enabled} onCheckedChange={(enabled) => updateEndpoint.mutate({ endpoint, body: { enabled } })} />
                </div>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-2">
                <div className="rounded-2xl border border-border bg-background p-4">
                  <p className="font-medium">Custom domains</p>
                  <p className="mt-1 text-xs text-muted-foreground">Point these hosts at LLMHarbor and route them to this endpoint.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {endpoint.domains.length === 0 ? <span className="text-sm text-muted-foreground">No custom domains yet.</span> : endpoint.domains.map(domain => (
                      <Badge key={domain} variant="outline" className="gap-2">{domain}<button onClick={() => removeDomain.mutate({ endpoint, domain })} aria-label={`Remove ${domain}`}>×</button></Badge>
                    ))}
                  </div>
                  <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
                    <Input value={domainDrafts[endpoint.id] ?? ''} onChange={e => setDomainDrafts(prev => ({ ...prev, [endpoint.id]: e.target.value }))} placeholder="api.yourdomain.com" />
                    <Button variant="outline" onClick={() => addDomain.mutate({ endpoint, domain: domainDrafts[endpoint.id] ?? '' })} disabled={!(domainDrafts[endpoint.id] ?? '').trim()}>Add domain</Button>
                  </div>
                </div>

                <div className="rounded-2xl border border-border bg-background p-4">
                  <p className="font-medium">Dedicated local keys</p>
                  <p className="mt-1 text-xs text-muted-foreground">Issue keys per app. Revoke one app without rotating the default endpoint.</p>
                  <div className="mt-3 space-y-2">
                    {endpoint.keys.length === 0 ? <span className="text-sm text-muted-foreground">No keys on this endpoint.</span> : endpoint.keys.map(key => (
                      <div key={key.id} className="rounded-xl bg-muted px-3 py-2 text-xs">
                        <code className="block truncate">{key.label}: {key.maskedKey}</code>
                        <span className="mt-1 block text-muted-foreground">{limitSummary(key.limits)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
                    <Input value={keyLabels[endpoint.id] ?? ''} onChange={e => setKeyLabels(prev => ({ ...prev, [endpoint.id]: e.target.value }))} placeholder="Production app key" />
                    <Button variant="outline" onClick={() => createKey.mutate(endpoint)}>Create key</Button>
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-4">
                    {LIMIT_FIELDS.map(field => (
                      <div key={field.key} className="grid gap-1">
                        <Label className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{field.label}</Label>
                        <Input
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={(keyLimitDrafts[endpoint.id] ?? EMPTY_LIMIT_DRAFT)[field.key]}
                          onChange={e => setKeyLimitDrafts(prev => ({
                            ...prev,
                            [endpoint.id]: {
                              ...(prev[endpoint.id] ?? EMPTY_LIMIT_DRAFT),
                              [field.key]: e.target.value.replace(/[^0-9]/g, ''),
                            },
                          }))}
                          placeholder="∞"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
