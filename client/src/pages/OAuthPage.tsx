import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { invalidateRoutingQueries } from '@/lib/query-cache'
import { copyText } from '@/lib/clipboard'
import { useConfirm, notify } from '@/lib/feedback'
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
  createdAt: string
  lastUsedAt: string | null
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

interface OAuthAccountGroup {
  provider: string
  providerName: string
  accounts: OAuthAccount[]
}

const EMPTY_OAUTH_PROVIDERS: OAuthProvider[] = []
const EMPTY_OAUTH_ACCOUNTS: OAuthAccount[] = []

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

function groupOAuthAccounts(accounts: OAuthAccount[]): OAuthAccountGroup[] {
  const groups = new Map<string, OAuthAccountGroup>()
  for (const account of accounts) {
    const group = groups.get(account.provider)
    if (group) {
      group.accounts.push(account)
    } else {
      groups.set(account.provider, {
        provider: account.provider,
        providerName: account.providerName,
        accounts: [account],
      })
    }
  }

  return [...groups.values()]
    .sort((left, right) => left.providerName.localeCompare(right.providerName))
}

function accountCapacitySummary(limits?: AccountLimit[]) {
  if (!limits || limits.length === 0) return 'Not reported'
  const reported = limits
    .map(limit => limit.usedPercent)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (reported.length === 0) return 'Provider managed'
  return `${Math.round(Math.max(...reported))}% peak usage`
}

function metadataString(account: OAuthAccount, key: string) {
  const value = account.metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function accountDiscriminator(account: OAuthAccount) {
  return metadataString(account, 'cloudaicompanionProject')
    ?? metadataString(account, 'email')
    ?? account.accountHint
    ?? `Account #${account.id}`
}

function accountDisplayName(account: OAuthAccount) {
  const label = account.label.trim()
  for (const separator of [' - ', ': ']) {
    const prefix = `${account.providerName}${separator}`
    if (label.startsWith(prefix) && label.length > prefix.length) return label.slice(prefix.length)
  }
  return label || account.accountHint || `Account #${account.id}`
}

function accountSecondaryLabel(account: OAuthAccount) {
  const discriminator = accountDiscriminator(account)
  return discriminator === accountDisplayName(account) ? `Account #${account.id}` : discriminator
}

function accountNeedsReconnect(account: OAuthAccount) {
  return account.metadata?.oauthNeedsReconnect === true
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
            <div
              className="mt-2 h-2 overflow-hidden rounded-full bg-background"
              role={used === null ? undefined : 'progressbar'}
              aria-label={used === null ? undefined : `${limit.label} usage`}
              aria-valuemin={used === null ? undefined : 0}
              aria-valuemax={used === null ? undefined : 100}
              aria-valuenow={used ?? undefined}
            >
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
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const [selectedAccount, setSelectedAccount] = useState<number | null>(() => { const id = Number(new URLSearchParams(window.location.search).get('account')); return Number.isSafeInteger(id) && id > 0 ? id : null })
  const [renaming, setRenaming] = useState<Record<number, string>>({})
  const [activeConnection, setActiveConnection] = useState<ActiveConnection | null>(null)
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null)
  const [manualCallbackUrl, setManualCallbackUrl] = useState('')
  const [connectionExpanded, setConnectionExpanded] = useState<boolean | null>(null)
  const pendingPopup = useRef<Window | null>(null)
  const remoteDashboard = !isLoopbackHostname(window.location.hostname)

  const { data: providerData, isLoading: providersLoading, isError: providersError, error: providersQueryError, refetch: refetchProviders } = useQuery<{ providers: OAuthProvider[] }>({ queryKey: ['oauth-providers'], queryFn: ({ signal }) => apiFetch('/api/oauth/providers', { signal }) })
  const { data: accountData, isLoading: accountsLoading, isError: accountsError, error: accountsQueryError, refetch: refetchAccounts } = useQuery<{ accounts: OAuthAccount[] }>({ queryKey: ['oauth-accounts'], queryFn: ({ signal }) => apiFetch('/api/oauth/accounts', { signal }) })
  const providers = providerData?.providers ?? EMPTY_OAUTH_PROVIDERS
  const accounts = accountData?.accounts ?? EMPTY_OAUTH_ACCOUNTS
  const accountGroups = useMemo(() => groupOAuthAccounts(accounts), [accounts])
  const enabledAccountCount = accounts.reduce((count, account) => count + (account.enabled ? 1 : 0), 0)
  const selectedAccountRecord = accounts.find(account => account.id === selectedAccount)
    ?? accounts.find(account => account.enabled)
    ?? accounts[0]
    ?? null
  const selectedAccountId = selectedAccountRecord?.id ?? null

  function invalidateOAuthRoutingState() {
    void invalidateRoutingQueries(queryClient)
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
      notify('OAuth account updated.')
      if (variables.body.label !== undefined) {
        setRenaming(current => {
          const next = { ...current }
          delete next[variables.id]
          return next
        })
      }
    },
  })

  const deleteAccount = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/oauth/accounts/${id}`, { method: 'DELETE' }),
    onSuccess: (_, deletedId) => {
      invalidateOAuthRoutingState()
      notify('OAuth account disconnected.')
      setSelectedAccount(current => current === deletedId ? null : current)
    },
  })

  const models = useQuery<OAuthInventory>({
    queryKey: ['oauth-models', selectedAccountId],
    queryFn: ({ signal }) => apiFetch(`/api/oauth/accounts/${selectedAccountId}/models`, { signal, timeoutMs: 120_000 }),
    enabled: selectedAccountId !== null,
  })

  const refreshModels = useMutation({
    mutationFn: (accountId: number) => apiFetch<OAuthInventory>(`/api/oauth/accounts/${accountId}/models/refresh`, {
      method: 'POST',
      timeoutMs: 120_000,
    }),
    onSuccess: (inventory, accountId) => {
      queryClient.setQueryData(['oauth-models', accountId], inventory)
      void invalidateRoutingQueries(queryClient)
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

  const selectedLabelDraft = selectedAccountRecord
    ? (renaming[selectedAccountRecord.id] ?? selectedAccountRecord.label)
    : ''
  const connectionPanelOpen = activeConnection !== null || (connectionExpanded ?? accounts.length === 0)
  const selectedUpdateError = updateAccount.isError && updateAccount.variables?.id === selectedAccountId
    ? updateAccount.error
    : null
  const selectedDeleteError = deleteAccount.isError && deleteAccount.variables === selectedAccountId
    ? deleteAccount.error
    : null

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Browser authentication" title="OAuth accounts" description="Connect supported browser accounts, discover their live model inventory, and monitor provider-reported limit windows." />

      <section className="flex min-w-0 flex-col gap-5">
        <div className="panel-card min-w-0 overflow-hidden rounded-[var(--radius-panel)]">
          <button
            type="button"
            className="flex w-full min-w-0 cursor-pointer items-center justify-between gap-4 px-5 py-4 text-left outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-70"
            aria-expanded={connectionPanelOpen}
            aria-controls="oauth-provider-connections"
            disabled={activeConnection !== null}
            onClick={() => setConnectionExpanded(!connectionPanelOpen)}
          >
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground">Connect another account</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{providers.length} OAuth providers available</span>
            </span>
            <span className="shrink-0 text-xs font-medium text-primary">{activeConnection ? 'Authorization in progress' : connectionPanelOpen ? 'Hide providers' : 'Choose provider'}</span>
          </button>
          {connectionPanelOpen ? <div id="oauth-provider-connections" className="border-t border-border px-5 pb-5">
          <p className="mt-4 text-xs leading-5 text-muted-foreground">Choose a provider and complete its browser or device authorization flow. Credentials remain encrypted on this server.</p>
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
          <div className="mt-5 min-w-0 divide-y divide-border overflow-hidden rounded-[var(--radius-panel)] border border-border bg-background">
            {providersLoading ? (
              <LoadingState title="Loading OAuth providers" description="Checking available browser-account integrations…" />
            ) : providersError ? (
              <ErrorState title="Could not load OAuth providers" description={providersQueryError.message} action={<Button variant="outline" size="sm" onClick={() => refetchProviders()}>Retry</Button>} />
            ) : providers.map(provider => (
              <article key={provider.id} className="flex min-w-0 flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="break-words font-semibold tracking-[-0.02em]">{provider.name}</h3>
                    <Badge variant="outline">{provider.loginMode === 'device-oauth' ? 'Device code' : 'Browser OAuth'}</Badge>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{provider.notes}</p>
                  <p className="mt-1 truncate text-xs text-muted-foreground" title={provider.scopes.join(', ')}>
                    {provider.scopes.length > 0 ? `${provider.scopes.length} requested scopes` : 'No additional scopes'} · {provider.kind}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center lg:min-w-48 lg:justify-end">
                  <StatusIndicator label={provider.canConnect ? 'Available' : 'Unavailable'} tone={provider.canConnect ? 'positive' : 'warning'} />
                  <Button disabled={startLogin.isPending || !provider.canConnect} onClick={() => beginLogin(provider)} aria-label={`Connect ${provider.name}`}>
                    {provider.canConnect ? (provider.loginMode === 'device-oauth' ? 'Get device code' : 'Connect') : 'Unavailable'}
                  </Button>
                </div>
              </article>
            ))}
            {!providersLoading && !providersError && providers.length === 0 ? <EmptyState title="No OAuth providers available" description="This server does not currently expose a browser-account integration." /> : null}
          </div>
          {copyError ? <InlineNotice className="mt-4" tone="critical">{copyError}</InlineNotice> : null}
          </div> : null}
        </div>

        <div className="grid min-w-0 gap-5 2xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)] 2xl:items-start">
          <div className="panel-card min-w-0 rounded-[var(--radius-panel)] p-5" aria-labelledby="connected-accounts-heading">
            <SectionTitle
              id="connected-accounts-heading"
              title="Connected accounts"
              description="Accounts are grouped by provider. Select a row to inspect credentials, quota windows, and model inventory."
              action={<p className="whitespace-nowrap text-xs text-muted-foreground">{enabledAccountCount} enabled · {accounts.length} total</p>}
            />
            <div className="mt-4">
              {accountsLoading ? <LoadingState title="Loading connected accounts" /> : accountsError ? <ErrorState title="Could not load accounts" description={accountsQueryError.message} action={<Button variant="outline" size="sm" onClick={() => refetchAccounts()}>Retry</Button>} /> : accounts.length === 0 ? <EmptyState title="No connected accounts" description="Connect a provider account to make its OAuth-backed models available." /> : (
                <div className="overflow-hidden rounded-[var(--radius-panel)] border border-border bg-background">
                  <div className="hidden grid-cols-[minmax(210px,1.5fr)_110px_70px_120px_120px_16px] gap-3 border-b border-border bg-muted/35 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground lg:grid">
                    <span>Account</span>
                    <span>Status</span>
                    <span>Models</span>
                    <span>Inventory</span>
                    <span>Capacity</span>
                    <span aria-hidden="true" />
                  </div>
                  <div className="divide-y divide-border">
                    {accountGroups.map(group => {
                      const groupEnabledCount = group.accounts.reduce((count, account) => count + (account.enabled ? 1 : 0), 0)
                      return (
                        <section key={group.provider} aria-labelledby={`oauth-provider-${group.provider}`}>
                          <div className="flex min-w-0 items-center justify-between gap-3 bg-muted/25 px-4 py-2.5">
                            <h3 id={`oauth-provider-${group.provider}`} className="truncate text-xs font-semibold text-foreground">{group.providerName}</h3>
                            <span className="shrink-0 text-[11px] text-muted-foreground">{groupEnabledCount}/{group.accounts.length} enabled</span>
                          </div>
                          <ul className="divide-y divide-border" role="list">
                            {group.accounts.map(account => {
                              const reconnectRequired = accountNeedsReconnect(account)
                              const selected = selectedAccountId === account.id
                              return (
                                <li key={account.id}>
                                  <button
                                    type="button"
                                    className={`grid w-full min-w-0 grid-cols-1 gap-2 px-4 py-3 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/30 lg:grid-cols-[minmax(210px,1.5fr)_110px_70px_120px_120px_16px] lg:items-center lg:gap-3 ${selected ? 'bg-primary/[0.02] shadow-[inset_3px_0_0_var(--primary)]' : 'hover:bg-muted/35'}`}
                                    onClick={() => setSelectedAccount(account.id)}
                                    aria-pressed={selected}
                                    aria-controls="oauth-account-details"
                                  >
                                    <span className="min-w-0">
                                      <span className="block truncate text-sm font-medium text-foreground">{accountDisplayName(account)}</span>
                                      <code className="mt-0.5 block truncate text-[11px] text-muted-foreground">{accountSecondaryLabel(account)}</code>
                                    </span>
                                    <span>
                                      <span className="sr-only">Status: </span>
                                      <StatusIndicator
                                        label={reconnectRequired ? 'Reconnect' : account.enabled ? 'Enabled' : 'Disabled'}
                                        tone={reconnectRequired ? 'critical' : account.enabled ? 'positive' : 'neutral'}
                                      />
                                    </span>
                                    <span className="text-xs text-foreground"><span className="sr-only">Models: </span><span aria-hidden="true" className="text-muted-foreground lg:hidden">Models: </span>{account.modelCount ?? '—'}</span>
                                    <span className="truncate text-xs text-muted-foreground"><span className="sr-only">Inventory: </span><span aria-hidden="true" className="lg:hidden">Inventory: </span>{formatRelativeTime(account.lastDiscoveredAt)}</span>
                                    <span className="truncate text-xs text-muted-foreground"><span className="sr-only">Capacity: </span><span aria-hidden="true" className="lg:hidden">Capacity: </span>{accountCapacitySummary(account.limits)}</span>
                                    <span className="hidden text-right text-muted-foreground lg:block" aria-hidden="true">›</span>
                                  </button>
                                </li>
                              )
                            })}
                          </ul>
                        </section>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div id="oauth-account-details" className="panel-card min-w-0 rounded-[var(--radius-panel)] p-5 2xl:sticky 2xl:top-5">
            {selectedAccountRecord ? (
              <>
                <SectionTitle
                  title={accountDisplayName(selectedAccountRecord)}
                  description={`${selectedAccountRecord.providerName} · ${accountDiscriminator(selectedAccountRecord)}`}
                  action={<StatusIndicator
                    label={accountNeedsReconnect(selectedAccountRecord) ? 'Reconnect required' : selectedAccountRecord.enabled ? 'Enabled' : 'Disabled'}
                    tone={accountNeedsReconnect(selectedAccountRecord) ? 'critical' : selectedAccountRecord.enabled ? 'positive' : 'neutral'}
                  />}
                />

                {accountNeedsReconnect(selectedAccountRecord) ? <InlineNotice className="mb-4" tone="critical">This provider marked the credentials for reconnection. Connect the account again below before relying on its routes.</InlineNotice> : null}
                {!selectedAccountRecord.enabled ? <InlineNotice className="mb-4" tone="warning">This account is disabled. Its cached inventory remains available, but live refresh and routing are paused.</InlineNotice> : null}
                {selectedUpdateError || selectedDeleteError ? <InlineNotice className="mb-4" tone="critical">{(selectedUpdateError ?? selectedDeleteError)?.message ?? 'Could not update the OAuth account.'}</InlineNotice> : null}

                <dl className="grid grid-cols-1 gap-x-5 gap-y-3 rounded-[var(--radius-panel)] border border-border bg-muted/20 p-4 text-xs sm:grid-cols-2">
                  <div className="min-w-0"><dt className="text-muted-foreground">Account</dt><dd className="mt-1 truncate font-medium text-foreground" title={accountDiscriminator(selectedAccountRecord)}>{accountDiscriminator(selectedAccountRecord)}</dd></div>
                  <div className="min-w-0"><dt className="text-muted-foreground">Credential</dt><dd className="mt-1 truncate font-mono text-foreground">{selectedAccountRecord.maskedToken}</dd></div>
                  <div><dt className="text-muted-foreground">Last used</dt><dd className="mt-1 font-medium text-foreground">{formatRelativeTime(selectedAccountRecord.lastUsedAt)}</dd></div>
                  <div><dt className="text-muted-foreground">Connected</dt><dd className="mt-1 font-medium text-foreground">{formatDateTime(selectedAccountRecord.createdAt)}</dd></div>
                  <div><dt className="text-muted-foreground">Token expiry</dt><dd className="mt-1 font-medium text-foreground">{formatDateTime(selectedAccountRecord.expiresAt)}</dd></div>
                  <div><dt className="text-muted-foreground">Inventory</dt><dd className="mt-1 font-medium text-foreground">{formatRelativeTime(selectedAccountRecord.lastDiscoveredAt)}</dd></div>
                </dl>

                <form
                  className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const label = selectedLabelDraft.trim()
                    if (label && label !== selectedAccountRecord.label) updateAccount.mutate({ id: selectedAccountRecord.id, body: { label } })
                  }}
                >
                  <div className="min-w-0">
                    <label className="mb-1.5 block text-xs font-medium text-foreground" htmlFor="oauth-account-label">Friendly name</label>
                    <Input id="oauth-account-label" value={selectedLabelDraft} onChange={event => setRenaming(current => ({ ...current, [selectedAccountRecord.id]: event.target.value }))} maxLength={100} />
                  </div>
                  <Button className="sm:mt-[1.625rem]" type="submit" variant="outline" size="sm" disabled={updateAccount.isPending || !selectedLabelDraft.trim() || selectedLabelDraft.trim() === selectedAccountRecord.label}>Save name</Button>
                </form>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" disabled={updateAccount.isPending} onClick={() => {
                    setSelectedAccount(selectedAccountRecord.id)
                    updateAccount.mutate({ id: selectedAccountRecord.id, body: { enabled: !selectedAccountRecord.enabled } })
                  }}>{selectedAccountRecord.enabled ? 'Disable routing' : 'Enable routing'}</Button>
                  <Button variant="destructive" size="sm" disabled={deleteAccount.isPending} onClick={async () => {
                    const confirmed = await confirm({ title: `Disconnect ${selectedAccountRecord.label}?`, description: 'This removes its stored tokens and OAuth-backed routing capacity. Other connected accounts remain available.', confirmLabel: 'Disconnect account' })
                    if (confirmed) deleteAccount.mutate(selectedAccountRecord.id)
                  }}>Disconnect account</Button>
                </div>

                <div className="mt-5 border-t border-border pt-5">
                  <SectionTitle
                    title="Model inventory"
                    description="Cached models and provider-reported limit windows for this account."
                    action={<Button variant="outline" size="sm" disabled={!selectedAccountRecord.enabled || refreshModels.isPending || models.isLoading} onClick={() => refreshModels.mutate(selectedAccountRecord.id)}>{refreshModels.isPending ? 'Refreshing…' : 'Refresh'}</Button>}
                  />
                  {refreshModels.isError && refreshModels.variables === selectedAccountRecord.id ? <InlineNotice className="mb-4" tone="critical">{refreshModels.error.message}</InlineNotice> : null}
                  {refreshModels.isPending && refreshModels.variables === selectedAccountRecord.id ? <InlineNotice className="mb-4">Contacting the provider and reconciling its model inventory…</InlineNotice> : null}
                  {models.isLoading ? <LoadingState title="Loading cached inventory" /> : models.error ? <ErrorState title="Could not load inventory" description={models.error.message} action={<Button variant="outline" size="sm" onClick={() => models.refetch()}>Retry</Button>} /> : models.data?.message ? <EmptyState title="No inventory available" description={models.data.message} /> : (
                    <div className="space-y-4">
                      <LimitBars limits={models.data?.limits ?? selectedAccountRecord.limits} />
                      {(models.data?.models ?? []).length === 0 ? <EmptyState title={selectedAccountRecord.modelCount ? `${selectedAccountRecord.modelCount} models reported` : 'No models discovered'} description={selectedAccountRecord.modelCount ? 'Refresh to reconcile the provider inventory and load its current model details.' : 'Refresh this account after the provider exposes a model inventory.'} /> : (
                        <div className="max-h-80 divide-y divide-border overflow-y-auto rounded-[var(--radius-panel)] border border-border bg-background">{(models.data?.models ?? []).map(model => (
                          <div key={model.id} className="flex min-w-0 items-center justify-between gap-3 px-3 py-2.5 text-xs">
                            <div className="min-w-0"><p className="truncate font-medium">{model.displayName ?? model.id}</p><code className="mt-0.5 block truncate text-muted-foreground">{model.id}</code></div>
                            {model.contextWindow ? <Badge variant="outline">{Math.round(model.contextWindow / 1000)}K ctx</Badge> : null}
                          </div>
                        ))}</div>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : <EmptyState title="Select an account" description="Connected OAuth accounts and their operational details will appear here." />}
          </div>
        </div>
      </section>
    </div>
  )
}
