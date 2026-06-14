import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader, SectionTitle, EmptyState, ErrorState, LoadingState } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'

interface OAuthProvider {
  id: string
  name: string
  kind: string
  scopes: string[]
  supportsDiscovery: boolean
  loginMode: 'browser-oauth' | 'device-oauth'
  authorizationUrl: string
  callbackPath: string
  configured: boolean
  canConnect: boolean
  notes: string
}

interface BrowserStartLoginResponse {
  authUrl: string
  callbackUrl: string
  loginMode: 'browser-oauth'
}

interface DeviceStartLoginResponse {
  authUrl: string
  state: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresInSeconds: number
  intervalSeconds: number
  loginMode: 'device-oauth'
}

type StartLoginResponse = BrowserStartLoginResponse | DeviceStartLoginResponse
type ActiveConnection = StartLoginResponse & { providerId: string }
interface CompleteDeviceResponse {
  pending?: boolean
  account?: OAuthAccount
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
  const [activeConnection, setActiveConnection] = useState<ActiveConnection | null>(null)

  const { data: providerData, isLoading: providersLoading, isError: providersError, error: providersQueryError, refetch: refetchProviders } = useQuery<{ providers: OAuthProvider[] }>({ queryKey: ['oauth-providers'], queryFn: () => apiFetch('/api/oauth/providers') })
  const { data: accountData, isLoading: accountsLoading, isError: accountsError, error: accountsQueryError, refetch: refetchAccounts } = useQuery<{ accounts: OAuthAccount[] }>({ queryKey: ['oauth-accounts'], queryFn: () => apiFetch('/api/oauth/accounts') })
  const providers = providerData?.providers ?? []
  const accounts = accountData?.accounts ?? []

  const startLogin = useMutation({
    mutationFn: (provider: OAuthProvider) => apiFetch<StartLoginResponse>(`/api/oauth/connect/${provider.id}/start`, { method: 'POST' }),
    onSuccess: (data, provider) => {
      setActiveConnection({ ...data, providerId: provider.id })
      if (data.loginMode === 'browser-oauth') {
        window.location.href = data.authUrl
      } else {
        window.open(data.authUrl, '_blank', 'noopener,noreferrer')
      }
    },
  })

  const completeDeviceLogin = useMutation({
    mutationFn: ({ providerId, state }: { providerId: string; state: string }) => apiFetch<CompleteDeviceResponse>(`/api/oauth/connect/${providerId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ state }),
    }),
    onSuccess: (data) => {
      if (data.account) {
        setActiveConnection(null)
        queryClient.invalidateQueries({ queryKey: ['oauth-accounts'] })
      }
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

      <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
        <div className="panel-card min-w-0 rounded-2xl p-5 sm:p-6">
          <SectionTitle title="Connect a provider" description="LLMHarbor handles PKCE, loopback callbacks, encrypted credential storage, model discovery, and account-limit telemetry. No CLI handoff or raw token paste boxes." />
          {startLogin.error && <p className="mt-4 rounded-2xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">{startLogin.error.message}</p>}
          {activeConnection && (
            <div className="mt-4 rounded-2xl border border-border bg-muted/60 p-4 text-sm">
              {activeConnection.loginMode === 'browser-oauth' ? (
                <>
                  <p className="font-medium text-foreground">Browser OAuth started</p>
                  <p className="mt-2 text-muted-foreground">If the provider did not open, use this authorization link:</p>
                  <a className="mt-2 block break-all text-xs underline" href={activeConnection.authUrl}>{activeConnection.authUrl}</a>
                  <p className="mt-3 break-all text-xs text-muted-foreground">Callback: {activeConnection.callbackUrl}</p>
                </>
              ) : (
                <>
                  <p className="font-medium text-foreground">Device authorization started</p>
                  <p className="mt-2 text-muted-foreground">Approve this device code with the provider, then return here to complete the connection.</p>
                  <div className="mt-3 rounded-xl border border-border bg-background px-3 py-3 text-center font-mono text-lg tracking-[0.18em] text-foreground">{activeConnection.userCode}</div>
                  <a className="mt-3 block break-all text-xs underline" href={activeConnection.authUrl} target="_blank" rel="noreferrer">{activeConnection.authUrl}</a>
                  <p className="mt-2 text-xs text-muted-foreground">Expires in {Math.round(activeConnection.expiresInSeconds / 60)} minutes.</p>
                  {completeDeviceLogin.data?.pending && <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">The provider has not confirmed the approval yet. Wait a moment, then try again.</p>}
                  {completeDeviceLogin.error && <p className="mt-3 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">{completeDeviceLogin.error.message}</p>}
                  <Button className="mt-4 w-full" disabled={completeDeviceLogin.isPending} onClick={() => completeDeviceLogin.mutate({ providerId: activeConnection.providerId, state: activeConnection.state })}>
                    {completeDeviceLogin.isPending ? 'Checking approval...' : 'I approved the device code'}
                  </Button>
                </>
              )}
            </div>
          )}
          <div className="mt-5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
            {providersLoading ? (
              <div className="md:col-span-2"><LoadingState title="Loading OAuth providers" description="Checking available browser-account integrations…" /></div>
            ) : providersError ? (
              <div className="md:col-span-2"><ErrorState title="Could not load OAuth providers" description={providersQueryError.message} action={<Button variant="outline" size="sm" onClick={() => refetchProviders()}>Retry</Button>} /></div>
            ) : providers.map(provider => (
              <article key={provider.id} className="min-w-0 rounded-2xl border border-border bg-background p-4">
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                  <div className="min-w-0">
                    <h3 className="break-words font-semibold tracking-[-0.02em]">{provider.name}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">{provider.kind}</p>
                  </div>
                  <Badge>{provider.supportsDiscovery ? 'Auto inventory' : 'Browser OAuth'}</Badge>
                </div>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{provider.notes}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {provider.scopes.slice(0, 4).map(scope => (
                    <Badge
                      key={scope}
                      variant="outline"
                      className="min-w-0 max-w-full truncate"
                      style={{ flexShrink: 1 }}
                      title={scope}
                    >
                      {scope}
                    </Badge>
                  ))}
                </div>
                <p className="mt-4 truncate rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">{provider.authorizationUrl}</p>
                <Button className="mt-4 w-full" disabled={startLogin.isPending || !provider.canConnect} onClick={() => startLogin.mutate(provider)} aria-label={`Connect ${provider.name}`}>
                  {provider.canConnect ? (provider.loginMode === 'device-oauth' ? 'Connect with device code' : 'Connect account') : 'Waiting for verified public client'}
                </Button>
              </article>
            ))}
          </div>
        </div>

        <div className="min-w-0 space-y-5">
          <div className="panel-card min-w-0 rounded-2xl p-5 sm:p-6">
            <SectionTitle title="Connected accounts" description="Each account shows provider-reported model inventory and limit windows. Select an account to refresh its models." />
            <div className="mt-5 space-y-3">
              {accountsLoading ? <LoadingState title="Loading connected accounts" /> : accountsError ? <ErrorState title="Could not load accounts" description={accountsQueryError.message} action={<Button variant="outline" size="sm" onClick={() => refetchAccounts()}>Retry</Button>} /> : accounts.length === 0 ? <EmptyState title="No connected accounts" description="Connect a provider account to make its OAuth-backed models available." /> : accounts.map(account => (
                <div key={account.id} className="min-w-0 rounded-2xl border border-border bg-background p-4">
                  <button onClick={() => setSelectedAccount(account.id)} className="w-full rounded-2xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/40" aria-pressed={selectedAccount === account.id}>
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
                    <Input aria-label={`Rename ${account.label}`} value={renaming[account.id] ?? account.label} onChange={event => setRenaming(prev => ({ ...prev, [account.id]: event.target.value }))} />
                    <Button variant="outline" size="sm" onClick={() => updateAccount.mutate({ id: account.id, body: { label: renaming[account.id] ?? account.label } })}>Rename</Button>
                    <Button variant="outline" size="sm" onClick={() => updateAccount.mutate({ id: account.id, body: { enabled: !account.enabled } })}>{account.enabled ? 'Disable' : 'Enable'}</Button>
                    <Button variant="ghost" size="sm" onClick={() => { if (window.confirm(`Remove OAuth account "${account.label}"?`)) deleteAccount.mutate(account.id) }}>Remove</Button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {selectedAccount !== null && <div className="panel-card min-w-0 rounded-2xl p-5 sm:p-6">
            <SectionTitle title="Automatic model inventory" description="This list is refreshed from the selected account. Unsupported stale model IDs are removed from routing." />
            {models.isLoading ? <LoadingState title="Refreshing provider inventory" /> : models.error ? <ErrorState title="Inventory refresh failed" description={models.error.message} /> : models.data?.message ? <EmptyState title="No inventory available" description={models.data.message} /> : (
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
