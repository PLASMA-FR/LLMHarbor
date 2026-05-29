import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader, SectionTitle, EmptyState } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'

interface OAuthProvider {
  id: string
  name: string
  kind: string
  scopes: string[]
  supportsDiscovery: boolean
  loginMode: 'browser-oauth'
  authorizationUrl: string
  callbackPath: string
  configured: boolean
  canConnect: boolean
  notes: string
}

interface StartLoginResponse {
  authUrl: string
  callbackUrl: string
  loginMode: 'browser-oauth'
}

interface AccountLimit {
  label: string
  usedPercent: number | null
  resetAfterSeconds: number | null
  resetAt: number | null
}

interface OAuthAccount {
  id: number
  provider: string
  providerName: string
  label: string
  accountHint: string | null
  maskedToken: string
  enabled: boolean
  expiresAt: string | null
  lastDiscoveredAt: string | null
  limits?: AccountLimit[]
  modelCount?: number | null
  metadata?: Record<string, unknown>
}

interface OAuthModel {
  id: string
  displayName?: string
  contextWindow?: number | null
  visibility?: string | null
}

function formatReset(limit: AccountLimit) {
  if (typeof limit.resetAfterSeconds === 'number') {
    if (limit.resetAfterSeconds < 90) return `resets in ${limit.resetAfterSeconds}s`
    if (limit.resetAfterSeconds < 7200) return `resets in ${Math.round(limit.resetAfterSeconds / 60)}m`
    return `resets in ${Math.round(limit.resetAfterSeconds / 3600)}h`
  }
  if (typeof limit.resetAt === 'number') return `resets ${new Date(limit.resetAt * 1000).toLocaleString()}`
  return 'provider managed'
}

function LimitBars({ limits }: { limits?: AccountLimit[] }) {
  if (!limits || limits.length === 0) {
    return <p className="mt-3 text-xs text-muted-foreground">Limits refresh automatically when model inventory is discovered.</p>
  }
  return (
    <div className="mt-3 space-y-2">
      {limits.map((limit, index) => {
        const used = typeof limit.usedPercent === 'number' ? Math.max(0, Math.min(100, limit.usedPercent)) : null
        const tone = used === null ? 'bg-muted-foreground/35' : used > 85 ? 'bg-destructive' : used > 60 ? 'bg-amber-500' : 'bg-emerald-500'
        return (
          <div key={`${limit.label}-${index}`} className="rounded-xl border border-border bg-muted/40 p-3">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="font-medium text-foreground">{limit.label}</span>
              <span className="text-muted-foreground">{used === null ? 'active' : `${used}% used`}</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-background">
              <div className={`h-full rounded-full ${tone}`} style={{ width: `${used ?? 100}%`, opacity: used === null ? 0.35 : 1 }} />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">{formatReset(limit)}</p>
          </div>
        )
      })}
    </div>
  )
}

export default function OAuthPage() {
  const queryClient = useQueryClient()
  const [selectedAccount, setSelectedAccount] = useState<number | null>(null)
  const [renaming, setRenaming] = useState<Record<number, string>>({})
  const [activeConnection, setActiveConnection] = useState<StartLoginResponse | null>(null)

  const { data: providerData } = useQuery<{ providers: OAuthProvider[] }>({ queryKey: ['oauth-providers'], queryFn: () => apiFetch('/api/oauth/providers') })
  const { data: accountData } = useQuery<{ accounts: OAuthAccount[] }>({ queryKey: ['oauth-accounts'], queryFn: () => apiFetch('/api/oauth/accounts') })
  const providers = providerData?.providers ?? []
  const accounts = accountData?.accounts ?? []

  const startLogin = useMutation({
    mutationFn: (provider: OAuthProvider) => apiFetch<StartLoginResponse>(`/api/oauth/connect/${provider.id}/start`, { method: 'POST' }),
    onSuccess: (data) => {
      setActiveConnection(data)
      window.location.href = data.authUrl
    },
  })

  const updateAccount = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<OAuthAccount> }) => apiFetch<OAuthAccount>(`/api/oauth/accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['oauth-accounts'] }),
  })

  const deleteAccount = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/oauth/accounts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['oauth-accounts'] })
      setSelectedAccount(null)
    },
  })

  const models = useQuery<{ models: OAuthModel[]; limits?: AccountLimit[]; message?: string }>({
    queryKey: ['oauth-models', selectedAccount],
    queryFn: () => apiFetch(`/api/oauth/accounts/${selectedAccount}/models`),
    enabled: selectedAccount !== null,
  })

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="OAuth" title="Connected AI accounts" description="Use browser accounts as first-class provider capacity. LLMHarbor discovers supported models and account limits from the provider instead of guessing stale model IDs." />

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
        <div className="panel-card rounded-2xl p-5 sm:p-6">
          <SectionTitle title="Connect a provider" description="LLMHarbor handles PKCE, loopback callbacks, encrypted credential storage, model discovery, and account-limit telemetry. No CLI handoff or raw token paste boxes." />
          {startLogin.error && <p className="mt-4 rounded-2xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{startLogin.error.message}</p>}
          {activeConnection && (
            <div className="mt-4 rounded-2xl border border-border bg-muted/60 p-4 text-sm">
              <p className="font-medium text-foreground">Browser OAuth started</p>
              <p className="mt-2 text-muted-foreground">If the provider did not open, use this authorization link:</p>
              <a className="mt-2 block break-all text-xs underline" href={activeConnection.authUrl}>{activeConnection.authUrl}</a>
              <p className="mt-3 break-all text-xs text-muted-foreground">Callback: {activeConnection.callbackUrl}</p>
            </div>
          )}
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {providers.map(provider => (
              <article key={provider.id} className="rounded-2xl border border-border bg-background p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-semibold tracking-[-0.02em]">{provider.name}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">{provider.kind}</p>
                  </div>
                  <Badge>{provider.supportsDiscovery ? 'Auto inventory' : 'Browser OAuth'}</Badge>
                </div>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{provider.notes}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {provider.scopes.slice(0, 4).map(scope => <Badge key={scope} variant="outline">{scope}</Badge>)}
                </div>
                <p className="mt-4 truncate rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">{provider.authorizationUrl}</p>
                <Button className="mt-4 w-full" disabled={startLogin.isPending || !provider.canConnect} onClick={() => startLogin.mutate(provider)}>
                  {provider.canConnect ? 'Connect account' : 'Waiting for verified public client'}
                </Button>
              </article>
            ))}
          </div>
        </div>

        <div className="space-y-5">
          <div className="panel-card rounded-2xl p-5 sm:p-6">
            <SectionTitle title="Connected accounts" description="Each account shows provider-reported model inventory and limit windows. Select an account to refresh its models." />
            <div className="mt-5 space-y-3">
              {accounts.length === 0 ? <EmptyState title="No connected accounts" description="Connect a provider account to make its OAuth-backed models available." /> : accounts.map(account => (
                <div key={account.id} className="rounded-2xl border border-border bg-background p-4">
                  <button onClick={() => setSelectedAccount(account.id)} className="w-full text-left">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{account.label}</span>
                      <Badge variant="secondary">{account.providerName}</Badge>
                      <Badge variant={account.enabled ? 'default' : 'outline'}>{account.enabled ? 'Enabled' : 'Disabled'}</Badge>
                      {typeof account.modelCount === 'number' && <Badge variant="outline">{account.modelCount} models</Badge>}
                    </div>
                    <code className="mt-2 block truncate rounded-xl bg-muted px-3 py-2 text-xs">{account.maskedToken}</code>
                    <LimitBars limits={account.limits} />
                  </button>
                  <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
                    <Input value={renaming[account.id] ?? account.label} onChange={event => setRenaming(prev => ({ ...prev, [account.id]: event.target.value }))} />
                    <Button variant="outline" size="sm" onClick={() => updateAccount.mutate({ id: account.id, body: { label: renaming[account.id] ?? account.label } })}>Rename</Button>
                    <Button variant="outline" size="sm" onClick={() => updateAccount.mutate({ id: account.id, body: { enabled: !account.enabled } })}>{account.enabled ? 'Disable' : 'Enable'}</Button>
                    <Button variant="ghost" size="sm" onClick={() => deleteAccount.mutate(account.id)}>Remove</Button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {selectedAccount !== null && <div className="panel-card rounded-2xl p-5 sm:p-6">
            <SectionTitle title="Automatic model inventory" description="This list is refreshed from the selected account. Unsupported stale model IDs are removed from routing." />
            {models.isLoading ? <p className="mt-4 text-sm text-muted-foreground">Refreshing provider inventory...</p> : models.error ? <p className="mt-4 text-sm text-destructive">{models.error.message}</p> : models.data?.message ? <p className="mt-4 text-sm text-muted-foreground">{models.data.message}</p> : (
              <div className="mt-4 space-y-4">
                <LimitBars limits={models.data?.limits} />
                <div className="flex flex-wrap gap-2">{(models.data?.models ?? []).map(model => <Badge key={model.id} variant="outline">{model.displayName ?? model.id}</Badge>)}</div>
              </div>
            )}
          </div>}
        </div>
      </section>
    </div>
  )
}
