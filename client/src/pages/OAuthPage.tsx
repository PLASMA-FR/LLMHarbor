import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader, SectionTitle, EmptyState, ErrorState, LoadingState } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { InlineNotice, StatusIndicator } from '@/components/status-indicator'

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
  expiresInSeconds: number
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
type ActiveConnection = StartLoginResponse & { providerId: string; expiresAtMs: number }
interface CompleteDeviceResponse {
  pending?: boolean
  account?: OAuthAccount
}

interface CompleteBrowserResponse {
  connected: true
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

interface OAuthInventory {
  models: OAuthModel[]
  limits?: AccountLimit[]
  message?: string
  provider?: string
  automatic?: boolean
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

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
  return normalized === 'localhost'
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function isLoopbackCallbackUrl(value: string) {
  try {
    return isLoopbackHostname(new URL(value).hostname)
  } catch {
    return false
  }
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
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null)
  const [manualCallbackUrl, setManualCallbackUrl] = useState('')
  const pendingPopup = useRef<Window | null>(null)
  const remoteDashboard = !isLoopbackHostname(window.location.hostname)

  const { data: providerData, isLoading: providersLoading, isError: providersError, error: providersQueryError, refetch: refetchProviders } = useQuery<{ providers: OAuthProvider[] }>({ queryKey: ['oauth-providers'], queryFn: ({ signal }) => apiFetch('/api/oauth/providers', { signal }) })
  const { data: accountData, isLoading: accountsLoading, isError: accountsError, error: accountsQueryError, refetch: refetchAccounts } = useQuery<{ accounts: OAuthAccount[] }>({ queryKey: ['oauth-accounts'], queryFn: ({ signal }) => apiFetch('/api/oauth/accounts', { signal }) })
  const providers = providerData?.providers ?? []
  const accounts = accountData?.accounts ?? []

  function invalidateOAuthRoutingState() {
    queryClient.invalidateQueries({ queryKey: ['oauth-accounts'] })
    queryClient.invalidateQueries({ queryKey: ['oauth-models'] })
    queryClient.invalidateQueries({ queryKey: ['custom-endpoints'] })
    queryClient.invalidateQueries({ queryKey: ['keys'] })
    queryClient.invalidateQueries({ queryKey: ['health'] })
    queryClient.invalidateQueries({ queryKey: ['fallback'] })
  }

  useEffect(() => {
    if (activeConnection?.loginMode !== 'browser-oauth') return
    const timer = window.setInterval(() => {
      void refetchAccounts()
      if (pendingPopup.current?.closed) {
        pendingPopup.current = null
        if (!remoteDashboard) {
          setActiveConnection(null)
          queryClient.invalidateQueries({ queryKey: ['oauth-accounts'] })
          queryClient.invalidateQueries({ queryKey: ['custom-endpoints'] })
          queryClient.invalidateQueries({ queryKey: ['keys'] })
          queryClient.invalidateQueries({ queryKey: ['health'] })
          queryClient.invalidateQueries({ queryKey: ['fallback'] })
        }
      }
    }, 1_500)
    return () => window.clearInterval(timer)
  }, [activeConnection?.loginMode, queryClient, refetchAccounts, remoteDashboard])

  useEffect(() => {
    if (!activeConnection) return
    const connectionExpiry = activeConnection.expiresAtMs
    const timer = window.setTimeout(() => {
      if (activeConnection.loginMode === 'browser-oauth') {
        pendingPopup.current?.close()
        pendingPopup.current = null
        setManualCallbackUrl('')
      }
      setActiveConnection(current => current?.expiresAtMs === connectionExpiry ? null : current)
      setConnectionNotice('The authorization window expired. Start the connection again to receive a fresh code.')
    }, Math.max(0, connectionExpiry - Date.now()))
    return () => window.clearTimeout(timer)
  }, [activeConnection])

  const startLogin = useMutation({
    mutationFn: (provider: OAuthProvider) => apiFetch<StartLoginResponse>(`/api/oauth/connect/${provider.id}/start`, { method: 'POST' }),
    onSuccess: (data, provider) => {
      setConnectionNotice(null)
      setActiveConnection({ ...data, providerId: provider.id, expiresAtMs: Date.now() + Math.max(1, data.expiresInSeconds) * 1_000 })
      if (data.loginMode === 'browser-oauth') {
        if (pendingPopup.current && !pendingPopup.current.closed) {
          pendingPopup.current.location.href = data.authUrl
          pendingPopup.current.focus()
        }
      } else {
        window.open(data.authUrl, '_blank', 'noopener,noreferrer')
      }
    },
    onError: () => {
      pendingPopup.current?.close()
      pendingPopup.current = null
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
        setConnectionNotice(null)
        invalidateOAuthRoutingState()
      }
    },
  })

  const completeBrowserLogin = useMutation({
    mutationFn: ({ providerId, callbackUrl }: { providerId: string; callbackUrl: string }) => apiFetch<CompleteBrowserResponse>(`/api/oauth/connect/${providerId}/callback`, {
      method: 'POST',
      body: JSON.stringify({ callbackUrl }),
      timeoutMs: 35_000,
    }),
    onSuccess: () => {
      pendingPopup.current?.close()
      pendingPopup.current = null
      setManualCallbackUrl('')
      setActiveConnection(null)
      setConnectionNotice(null)
      invalidateOAuthRoutingState()
    },
  })

  const updateAccount = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<OAuthAccount> }) => apiFetch<OAuthAccount>(`/api/oauth/accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    onSuccess: (_, variables) => {
      invalidateOAuthRoutingState()
      if (variables.body.enabled === false && variables.id === selectedAccount) setSelectedAccount(null)
    },
  })

  const deleteAccount = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/oauth/accounts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidateOAuthRoutingState()
      setSelectedAccount(null)
    },
  })

  const models = useQuery<OAuthInventory>({
    queryKey: ['oauth-models', selectedAccount],
    queryFn: ({ signal }) => apiFetch(`/api/oauth/accounts/${selectedAccount}/models`, { signal, timeoutMs: 120_000 }),
    enabled: selectedAccount !== null && accounts.some(account => account.id === selectedAccount && account.enabled),
  })

  const refreshModels = useMutation({
    mutationFn: (accountId: number) => apiFetch<OAuthInventory>(`/api/oauth/accounts/${accountId}/models/refresh`, {
      method: 'POST',
      timeoutMs: 120_000,
    }),
    onSuccess: (inventory, accountId) => {
      queryClient.setQueryData(['oauth-models', accountId], inventory)
      queryClient.invalidateQueries({ queryKey: ['oauth-accounts'] })
      queryClient.invalidateQueries({ queryKey: ['custom-endpoints'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  function beginLogin(provider: OAuthProvider) {
    setConnectionNotice(null)
    setManualCallbackUrl('')
    completeBrowserLogin.reset()
    if (provider.loginMode === 'browser-oauth') {
      pendingPopup.current = window.open('about:blank', 'llmharbor-oauth', 'popup,width=620,height=760')
      if (pendingPopup.current) {
        pendingPopup.current.document.title = `Connect ${provider.name}`
        pendingPopup.current.document.body.textContent = 'Preparing secure authorization…'
      }
    }
    startLogin.mutate(provider)
  }

  async function copyDeviceCode() {
    if (!activeConnection || activeConnection.loginMode !== 'device-oauth') return
    try {
      await copyText(activeConnection.userCode)
      setCopyError(null)
      setDeviceCodeCopied(true)
      window.setTimeout(() => setDeviceCodeCopied(false), 1500)
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : 'Could not copy the device code.')
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Browser authentication" title="OAuth accounts" description="Connect supported browser accounts, discover their live model inventory, and monitor provider-reported limit windows." />

      <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
        <div className="panel-card min-w-0 rounded-[var(--radius-panel)] p-5">
          <SectionTitle title="Connect a provider" description="LLMHarbor handles PKCE, loopback callbacks, encrypted credential storage, model discovery, and account-limit telemetry. Browser OAuth must run on the LLMHarbor host, or through a tunnel that makes its loopback callback reachable." />
          {startLogin.error ? <InlineNotice className="mt-4" tone="critical">{startLogin.error.message}</InlineNotice> : null}
          {connectionNotice ? <InlineNotice className="mt-4" tone="warning">{connectionNotice}</InlineNotice> : null}
          {completeBrowserLogin.isSuccess ? <InlineNotice className="mt-4" tone="positive">Account connected. OAuth accounts and routing state are refreshing.</InlineNotice> : null}
          {activeConnection && (
            <div className="mt-4 rounded-[var(--radius-panel)] border border-border bg-muted/40 p-4 text-sm">
              {activeConnection.loginMode === 'browser-oauth' ? (
                <>
                  <p className="font-medium text-foreground">Browser OAuth started</p>
                  <p className="mt-2 text-muted-foreground">If the provider did not open, use this authorization link:</p>
                  <a
                    className="mt-2 block break-all text-xs underline"
                    href={activeConnection.authUrl}
                    target="llmharbor-oauth"
                    rel="noreferrer"
                    onClick={(event) => {
                      event.preventDefault()
                      pendingPopup.current = window.open(activeConnection.authUrl, 'llmharbor-oauth', 'popup,width=620,height=760')
                    }}
                  >
                    {activeConnection.authUrl}
                  </a>
                  <p className="mt-3 break-all text-xs text-muted-foreground">Callback: {activeConnection.callbackUrl}</p>
                  {remoteDashboard && isLoopbackCallbackUrl(activeConnection.callbackUrl) ? (
                    <div className="mt-4 border-t border-border pt-4">
                      <InlineNotice tone="warning">
                        This dashboard is open on another device, but the provider must redirect to localhost. After authorization, the browser may show a connection error. Copy the complete localhost URL from its address bar and paste it below; LLMHarbor will still verify the original state and PKCE challenge.
                      </InlineNotice>
                      <form
                        className="mt-4 space-y-3"
                        onSubmit={(event) => {
                          event.preventDefault()
                          const callbackUrl = manualCallbackUrl.trim()
                          if (callbackUrl) completeBrowserLogin.mutate({ providerId: activeConnection.providerId, callbackUrl })
                        }}
                      >
                        <div>
                          <label className="text-sm font-medium text-foreground" htmlFor="remote-oauth-callback">Returned localhost callback URL</label>
                          <p id="remote-oauth-callback-help" className="mt-1 text-xs leading-5 text-muted-foreground">Paste the full address without editing it. It contains a short-lived authorization code and is cleared after submission.</p>
                        </div>
                        <Input
                          id="remote-oauth-callback"
                          type="url"
                          inputMode="url"
                          autoComplete="off"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          value={manualCallbackUrl}
                          onChange={event => setManualCallbackUrl(event.target.value)}
                          placeholder={`${activeConnection.callbackUrl}?code=…&state=…`}
                          aria-describedby={`remote-oauth-callback-help${completeBrowserLogin.isError ? ' remote-oauth-callback-error' : ''}`}
                          aria-invalid={completeBrowserLogin.isError}
                          disabled={completeBrowserLogin.isPending}
                        />
                        {completeBrowserLogin.isError ? <div id="remote-oauth-callback-error"><InlineNotice tone="critical">{completeBrowserLogin.error.message}</InlineNotice></div> : null}
                        <Button type="submit" className="w-full" disabled={completeBrowserLogin.isPending || manualCallbackUrl.trim().length === 0}>
                          {completeBrowserLogin.isPending ? 'Completing connection…' : 'Complete remote connection'}
                        </Button>
                      </form>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <p className="font-medium text-foreground">Device authorization started</p>
                  <p className="mt-2 text-muted-foreground">Approve this device code with the provider, then return here to complete the connection.</p>
                  <div className="mt-3 flex items-center gap-2 rounded-[var(--radius-button)] border border-border bg-background p-2">
                    <code className="min-w-0 flex-1 px-2 text-center font-mono text-lg tracking-[0.18em] text-foreground">{activeConnection.userCode}</code>
                    <Button type="button" variant="outline" size="sm" onClick={() => void copyDeviceCode()}>{deviceCodeCopied ? 'Copied' : 'Copy'}</Button>
                  </div>
                  <a className="mt-3 block break-all text-xs underline" href={activeConnection.authUrl} target="_blank" rel="noreferrer">{activeConnection.authUrl}</a>
                  <p className="mt-2 text-xs text-muted-foreground">Expires in {Math.round(activeConnection.expiresInSeconds / 60)} minutes.</p>
                  {completeDeviceLogin.data?.pending ? <InlineNotice className="mt-3" tone="warning">The provider has not confirmed approval yet. Wait a moment, then try again.</InlineNotice> : null}
                  {completeDeviceLogin.error ? <InlineNotice className="mt-3" tone="critical">{completeDeviceLogin.error.message}</InlineNotice> : null}
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
              <article key={provider.id} className="min-w-0 rounded-[var(--radius-panel)] border border-border bg-background p-4">
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                  <div className="min-w-0">
                    <h3 className="break-words font-semibold tracking-[-0.02em]">{provider.name}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">{provider.kind}</p>
                  </div>
                  <StatusIndicator label={provider.canConnect ? 'Ready to connect' : 'Unavailable'} tone={provider.canConnect ? 'positive' : 'warning'} />
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
                <p className="mt-4 truncate rounded-[var(--radius-button)] bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">{provider.authorizationUrl}</p>
                <Button className="mt-4 w-full" disabled={startLogin.isPending || !provider.canConnect} onClick={() => beginLogin(provider)} aria-label={`Connect ${provider.name}`}>
                  {provider.canConnect ? (provider.loginMode === 'device-oauth' ? 'Connect with device code' : 'Connect account') : 'Waiting for verified public client'}
                </Button>
              </article>
            ))}
            {!providersLoading && !providersError && providers.length === 0 ? <div className="md:col-span-2"><EmptyState title="No OAuth providers available" description="This server does not currently expose a browser-account integration." /></div> : null}
          </div>
          {copyError ? <InlineNotice className="mt-4" tone="critical">{copyError}</InlineNotice> : null}
        </div>

        <div className="min-w-0 space-y-5">
          <div className="panel-card min-w-0 rounded-[var(--radius-panel)] p-5">
            <SectionTitle title="Connected accounts" description="Each account shows provider-reported model inventory and limit windows. Select an account to inspect its cached models." />
            <div className="mt-5 space-y-3">
              {accountsLoading ? <LoadingState title="Loading connected accounts" /> : accountsError ? <ErrorState title="Could not load accounts" description={accountsQueryError.message} action={<Button variant="outline" size="sm" onClick={() => refetchAccounts()}>Retry</Button>} /> : accounts.length === 0 ? <EmptyState title="No connected accounts" description="Connect a provider account to make its OAuth-backed models available." /> : accounts.map(account => (
                <div key={account.id} className="min-w-0 rounded-[var(--radius-panel)] border border-border bg-background p-4">
                  <button onClick={() => setSelectedAccount(account.id)} disabled={!account.enabled} className="w-full rounded-[var(--radius-button)] text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-65" aria-pressed={selectedAccount === account.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{account.label}</span>
                      <Badge variant="secondary">{account.providerName}</Badge>
                      <Badge variant={account.enabled ? 'default' : 'outline'}>{account.enabled ? 'Enabled' : 'Disabled'}</Badge>
                      {typeof account.modelCount === 'number' && <Badge variant="outline">{account.modelCount} models</Badge>}
                    </div>
                    <code className="mt-2 block truncate rounded-[var(--radius-button)] bg-muted px-3 py-2 text-xs">{account.maskedToken}</code>
                    <p className="mt-2 text-xs text-muted-foreground">Inventory {formatRelativeTime(account.lastDiscoveredAt)} · Token expires {formatDateTime(account.expiresAt)}</p>
                    <LimitBars limits={account.limits} />
                  </button>
                  <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
                    <Input aria-label={`Rename ${account.label}`} value={renaming[account.id] ?? account.label} onChange={event => setRenaming(prev => ({ ...prev, [account.id]: event.target.value }))} maxLength={100} />
                    <Button variant="outline" size="sm" disabled={updateAccount.isPending || !(renaming[account.id] ?? account.label).trim()} onClick={() => updateAccount.mutate({ id: account.id, body: { label: (renaming[account.id] ?? account.label).trim() } })}>Rename</Button>
                    <Button variant="outline" size="sm" disabled={updateAccount.isPending} onClick={() => updateAccount.mutate({ id: account.id, body: { enabled: !account.enabled } })}>{account.enabled ? 'Disable' : 'Enable'}</Button>
                    <Button variant="ghost" size="sm" disabled={deleteAccount.isPending} onClick={() => { if (window.confirm(`Remove OAuth account "${account.label}"?`)) deleteAccount.mutate(account.id) }}>Remove</Button>
                  </div>
                </div>
              ))}
            </div>
            {updateAccount.isError || deleteAccount.isError ? <InlineNotice className="mt-4" tone="critical">{(updateAccount.error ?? deleteAccount.error)?.message ?? 'Could not update the OAuth account.'}</InlineNotice> : null}
          </div>

          {selectedAccount !== null && <div className="panel-card min-w-0 rounded-[var(--radius-panel)] p-5">
            <SectionTitle
              title="Automatic model inventory"
              description="The cached inventory is safe to inspect. Refresh explicitly to contact the provider and reconcile stale model IDs."
              action={<Button variant="outline" size="sm" disabled={refreshModels.isPending || models.isLoading} onClick={() => refreshModels.mutate(selectedAccount)}>{refreshModels.isPending ? 'Refreshing…' : 'Refresh inventory'}</Button>}
            />
            {refreshModels.isError && refreshModels.variables === selectedAccount ? <InlineNotice className="mb-4" tone="critical">{refreshModels.error.message}</InlineNotice> : null}
            {refreshModels.isPending && refreshModels.variables === selectedAccount ? <InlineNotice className="mb-4">Contacting the provider and reconciling its model inventory…</InlineNotice> : null}
            {models.isLoading ? <LoadingState title="Loading cached inventory" /> : models.error ? <ErrorState title="Could not load inventory" description={models.error.message} action={<Button variant="outline" size="sm" onClick={() => models.refetch()}>Retry</Button>} /> : models.data?.message ? <EmptyState title="No inventory available" description={models.data.message} /> : (
              <div className="mt-4 space-y-4">
                <LimitBars limits={models.data?.limits} />
                <div className="max-h-80 divide-y divide-border overflow-y-auto rounded-[var(--radius-panel)] border border-border bg-background">{(models.data?.models ?? []).map(model => (
                  <div key={model.id} className="flex min-w-0 items-center justify-between gap-3 px-3 py-2.5 text-xs">
                    <div className="min-w-0"><p className="truncate font-medium">{model.displayName ?? model.id}</p><code className="mt-0.5 block truncate text-muted-foreground">{model.id}</code></div>
                    {model.contextWindow ? <Badge variant="outline">{Math.round(model.contextWindow / 1000)}K ctx</Badge> : null}
                  </div>
                ))}</div>
              </div>
            )}
          </div>}
        </div>
      </section>
    </div>
  )
}
