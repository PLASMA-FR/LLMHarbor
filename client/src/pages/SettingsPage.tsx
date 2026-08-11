import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { apiFetch, apiUrl } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader, SectionTitle, EmptyState, ErrorState, LoadingState } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { InlineNotice } from '@/components/status-indicator'
import { cn } from '@/lib/utils'
import type { DetectedFreeModel, FreeModelUpdaterProviderOption, FreeModelUpdaterStatus } from '../../../shared/types'

interface ClientApiKey { id: number; label: string; key?: string; maskedKey: string; enabled: boolean; createdAt: string; lastUsedAt: string | null; localEndpointId?: number | null }
interface LocalEndpointKey { id: number; label: string; maskedKey: string; enabled: boolean; localEndpointId: number; createdAt?: string; lastUsedAt?: string | null }
interface LocalEndpoint { id: number; name: string; slug: string; basePath: string; enabled: boolean; providerScopes: string[]; domains: string[]; keys: LocalEndpointKey[] }
interface PolicyRoute { id: string; method: string; path: string; name: string; description: string; enabled: boolean }
interface PolicyPlatform { platform: string; name: string; baseUrl: string | null; timeoutMs: number | null; source: 'built-in' | 'custom' | 'catalog'; enabled: boolean }
interface PolicyModel { modelDbId: number; platform: string; modelId: string; displayName: string; contextWindow: number | null; catalogEnabled: boolean; enabled: boolean }
interface AccessPolicySnapshot { key: ClientApiKey; routes: PolicyRoute[]; platforms: PolicyPlatform[]; models: PolicyModel[] }
interface FullBackupPayload {
  format: 'llmharbor.full-instance-backup.v1'
  exportedAt: string
  includes: string[]
  manifest?: {
    providerApiKeys?: number
    localProxyKeys?: number
    localProxyKeyUsageRows?: number
    oauthAccounts?: number
    requestRows?: number
  }
  security: { containsSecrets: boolean; note: string }
  database: { filename: string; encoding: 'base64'; bytes: number; sha256: string; content: string }
}
interface BackupImportResult {
  success: boolean
  staged: boolean
  previousBackupPath: string | null
  restoredPath: string
  restartedDatabase: boolean
  restartRequired: boolean
}

type BackupImportInput =
  | { kind: 'database'; file: File }
  | { kind: 'legacy-json'; payload: FullBackupPayload }

type PolicyPatch = Partial<{
  routes: Array<{ route: string; enabled: boolean }>
  platforms: Array<{ platform: string; enabled: boolean }>
  models: Array<{ modelDbId: number; enabled: boolean }>
}>

function policyTone(enabled: boolean) {
  return enabled ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-rose-500/25 bg-rose-500/5'
}

function formatContextWindow(value: number | null) {
  if (!value) return null
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1)).toString()}M ctx`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K ctx`
  return `${value} ctx`
}

function formatBytes(value?: number) {
  if (!value) return '0 B'
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

const RESTORE_CONFIRMATION = 'RESTORE_LLMHARBOR_BACKUP'
const MAX_LEGACY_BACKUP_JSON_BYTES = 32 * 1024 * 1024

function PolicyStateBadge({ enabled }: { enabled: boolean }) {
  return (
    <Badge variant={enabled ? 'default' : 'secondary'} className={cn('shrink-0', enabled ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-background' : 'bg-rose-500/10 text-rose-700 dark:text-rose-200')}>
      {enabled ? 'Allowed' : 'Blocked'}
    </Badge>
  )
}

function SummaryTile({ label, value, detail, tone = 'default' }: { label: string; value: string | number; detail: string; tone?: 'default' | 'good' | 'warn' }) {
  return (
    <div className={cn(
      'panel-card min-w-0 rounded-[var(--radius-panel)] p-4',
      tone === 'good' && 'border-emerald-500/20 bg-emerald-500/5',
      tone === 'warn' && 'border-amber-500/25 bg-amber-500/10',
    )}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-[-0.04em] tabular-nums">{value}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  )
}

function PolicyActionButton({ children, onClick, disabled, variant = 'outline' }: { children: string; onClick: () => void; disabled?: boolean; variant?: 'default' | 'outline' }) {
  return (
    <Button type="button" variant={variant} size="sm" className="shrink-0 rounded-[var(--radius-button)] whitespace-nowrap" disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  )
}

export default function SettingsPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(() => {
    const keyParam = new URLSearchParams(window.location.search).get('key')
    const keyId = Number.parseInt(keyParam ?? '', 10)
    return Number.isNaN(keyId) ? null : keyId
  })
  const [modelSearch, setModelSearch] = useState('')
  const [platformFilter, setPlatformFilter] = useState('all')
  const [showBlockedOnly, setShowBlockedOnly] = useState(false)
  const [freeUpdaterIntervalDraft, setFreeUpdaterIntervalDraft] = useState<string | null>(null)
  const [manualRefreshActive, setManualRefreshActive] = useState(false)
  const [backupStatus, setBackupStatus] = useState<string | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)
  const [backupFileName, setBackupFileName] = useState('')
  const backupFileRef = useRef<HTMLInputElement | null>(null)
  const lastUpdaterRunRef = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    if (!location.hash) return
    const target = document.getElementById(location.hash.slice(1))
    if (!target) return
    const frame = window.requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }))
    return () => window.cancelAnimationFrame(frame)
  }, [location.hash])

  const { data: clientKeys = [], isLoading: clientKeysLoading, isError: clientKeysError, error: clientKeysQueryError, refetch: refetchClientKeys } = useQuery<ClientApiKey[]>({
    queryKey: ['client-api-keys'],
    queryFn: ({ signal }) => apiFetch('/api/settings/api-keys', { signal }),
  })

  const { data: endpointData } = useQuery<{ endpoints: LocalEndpoint[] }>({
    queryKey: ['local-endpoints'],
    queryFn: ({ signal }) => apiFetch('/api/settings/local-endpoints', { signal }),
  })

  const activeKeyId = clientKeys.some(key => key.id === selectedKeyId) ? selectedKeyId : clientKeys[0]?.id ?? null
  const selectedKey = useMemo(() => clientKeys.find(key => key.id === activeKeyId) ?? null, [clientKeys, activeKeyId])

  const { data: policy, isLoading: policyLoading, isError: policyError, error: policyQueryError, refetch: refetchPolicy } = useQuery<AccessPolicySnapshot>({
    queryKey: ['client-api-key-access-policy', activeKeyId],
    queryFn: ({ signal }) => apiFetch(`/api/settings/api-keys/${activeKeyId}/access-policy`, { signal }),
    enabled: activeKeyId !== null,
  })

  const patchPolicy = useMutation({
    mutationFn: ({ keyId, patch }: { keyId: number; patch: PolicyPatch }) => apiFetch<AccessPolicySnapshot>(`/api/settings/api-keys/${keyId}/access-policy`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['client-api-key-access-policy', variables.keyId] })
      queryClient.invalidateQueries({ queryKey: ['client-api-keys'] })
    },
  })

  const { data: freeUpdaterStatus, isLoading: freeUpdaterStatusLoading, isError: freeUpdaterStatusError, error: freeUpdaterStatusQueryError, refetch: refetchFreeUpdaterStatus } = useQuery<FreeModelUpdaterStatus>({
    queryKey: ['free-model-updater-status'],
    queryFn: ({ signal }) => apiFetch('/api/settings/free-model-updater/status', { signal }),
    refetchInterval: query => {
      const status = query.state.data
      if (manualRefreshActive || status?.status === 'running') return 2_000
      return status?.enabled ? 30_000 : false
    },
  })

  const { data: freeUpdaterProviderData, isLoading: freeUpdaterProvidersLoading, isError: freeUpdaterProvidersError, error: freeUpdaterProvidersQueryError, refetch: refetchFreeUpdaterProviders } = useQuery<{ providers: FreeModelUpdaterProviderOption[] }>({
    queryKey: ['free-model-updater-providers'],
    queryFn: ({ signal }) => apiFetch('/api/settings/free-model-updater/providers', { signal }),
  })

  const { data: detectedFreeModels = [], isFetching: detectingFreeModels } = useQuery<DetectedFreeModel[]>({
    queryKey: ['free-model-updater-detected-models', freeUpdaterStatus?.selectedProviders ?? []],
    queryFn: ({ signal }) => apiFetch('/api/settings/free-model-updater/detected-models', { signal }),
    staleTime: 60_000,
    refetchInterval: manualRefreshActive || freeUpdaterStatus?.status === 'running' ? 5_000 : false,
  })

  useEffect(() => {
    const latest = freeUpdaterStatus?.lastRunAt
    if (lastUpdaterRunRef.current !== undefined && latest && latest !== lastUpdaterRunRef.current) {
      queryClient.invalidateQueries({ queryKey: ['free-model-updater-detected-models'] })
      queryClient.invalidateQueries({ queryKey: ['free-model-updater-providers'] })
    }
    lastUpdaterRunRef.current = latest
  }, [freeUpdaterStatus?.lastRunAt, queryClient])

  const enableFreeUpdater = useMutation({
    mutationFn: (refreshIntervalHours: number) => apiFetch<FreeModelUpdaterStatus>('/api/settings/free-model-updater/enable', {
      method: 'POST',
      body: JSON.stringify({ refreshIntervalHours }),
    }),
    onSuccess: () => setFreeUpdaterIntervalDraft(null),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['free-model-updater-status'] }),
  })

  const disableFreeUpdater = useMutation({
    mutationFn: () => apiFetch<FreeModelUpdaterStatus>('/api/settings/free-model-updater/disable', { method: 'POST' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['free-model-updater-status'] }),
  })

  const refreshFreeModels = useMutation({
    mutationFn: () => apiFetch('/api/settings/free-model-updater/refresh-now', { method: 'POST', timeoutMs: 300_000 }),
    onMutate: () => {
      setManualRefreshActive(true)
      void queryClient.invalidateQueries({ queryKey: ['free-model-updater-status'] })
    },
    onSettled: () => {
      setManualRefreshActive(false)
      queryClient.invalidateQueries({ queryKey: ['free-model-updater-status'] })
      queryClient.invalidateQueries({ queryKey: ['free-model-updater-detected-models'] })
      queryClient.invalidateQueries({ queryKey: ['free-model-updater-providers'] })
      queryClient.invalidateQueries({ queryKey: ['client-api-key-access-policy'] })
    },
  })

  const updateFreeUpdaterProviders = useMutation({
    mutationFn: (selectedProviders: string[]) => apiFetch('/api/settings/free-model-updater/providers', {
      method: 'PUT',
      body: JSON.stringify({ selectedProviders }),
    }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['free-model-updater-status'] })
      queryClient.invalidateQueries({ queryKey: ['free-model-updater-providers'] })
      queryClient.invalidateQueries({ queryKey: ['free-model-updater-detected-models'] })
    },
  })

  const importBackup = useMutation({
    mutationFn: (input: BackupImportInput) => input.kind === 'database'
      ? apiFetch<BackupImportResult>('/api/settings/backup/import/database', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-LLMHarbor-Restore-Confirmation': RESTORE_CONFIRMATION,
          },
          body: input.file,
          timeoutMs: 300_000,
        })
      : apiFetch<BackupImportResult>('/api/settings/backup/import', {
          method: 'POST',
          body: JSON.stringify({ format: input.payload.format, confirm: RESTORE_CONFIRMATION, database: input.payload.database }),
          timeoutMs: 300_000,
        }),
    onSuccess: (result) => {
      setBackupError(null)
      setBackupStatus(`Backup verified and staged. Restart LLMHarbor to activate it. The current database remains active until restart; a pre-import backup was ${result.previousBackupPath ? `saved at ${result.previousBackupPath}` : 'not needed'}.`)
    },
    onError: (error) => {
      setBackupStatus(null)
      setBackupError(error instanceof Error ? error.message : String(error))
    },
  })

  const totalEndpoints = endpointData?.endpoints.length ?? 0
  const legacyDomains = endpointData?.endpoints.reduce((sum, endpoint) => sum + endpoint.domains.length, 0) ?? 0
  const blockedRoutes = policy?.routes.filter(route => !route.enabled).length ?? 0
  const allowedRoutes = policy?.routes.filter(route => route.enabled).length ?? 0
  const blockedProviders = policy?.platforms.filter(platform => !platform.enabled).length ?? 0
  const allowedProviders = policy ? policy.platforms.length - blockedProviders : 0
  const blockedModels = policy?.models.filter(model => !model.enabled).length ?? 0
  const allowedModels = policy ? policy.models.length - blockedModels : 0
  const totalBlocked = blockedRoutes + blockedProviders + blockedModels
  const freeUpdaterProviders = freeUpdaterProviderData?.providers ?? []
  const selectedFreeUpdaterProviders = freeUpdaterProviders.filter(provider => provider.selected).map(provider => provider.platform)
  const freeUpdaterActionError = enableFreeUpdater.error ?? disableFreeUpdater.error ?? refreshFreeModels.error ?? updateFreeUpdaterProviders.error
  const providerOptions = useMemo(() => Array.from(new Set(policy?.models.map(model => model.platform) ?? [])).sort((a, b) => a.localeCompare(b)), [policy?.models])
  const visibleModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase()
    return (policy?.models ?? [])
      .filter(model => platformFilter === 'all' || model.platform === platformFilter)
      .filter(model => !showBlockedOnly || !model.enabled)
      .filter(model => !query || `${model.modelId} ${model.displayName} ${model.platform}`.toLowerCase().includes(query))
      .slice(0, 160)
  }, [modelSearch, platformFilter, policy?.models, showBlockedOnly])
  const freeUpdaterBusy = (freeUpdaterStatus?.status === 'running') || enableFreeUpdater.isPending || disableFreeUpdater.isPending || refreshFreeModels.isPending || updateFreeUpdaterProviders.isPending
  const canRefreshFreeUpdater = selectedFreeUpdaterProviders.length > 0 && !freeUpdaterBusy
  const canEnableFreeUpdater = selectedFreeUpdaterProviders.length > 0 && !freeUpdaterBusy
  const freeUpdaterInterval = freeUpdaterIntervalDraft ?? String(freeUpdaterStatus?.refreshIntervalHours ?? 6)

  function updatePolicy(patch: PolicyPatch) {
    if (!activeKeyId) return
    patchPolicy.mutate({ keyId: activeKeyId, patch })
  }

  function chooseKey(keyId: number) {
    setSelectedKeyId(keyId)
    navigate(`/settings?key=${keyId}#access-policies`, { replace: true })
  }

  function setAllRoutes(enabled: boolean) {
    if (!policy) return
    updatePolicy({ routes: policy.routes.map(route => ({ route: route.id, enabled })) })
  }

  function setAllPlatforms(enabled: boolean) {
    if (!policy) return
    updatePolicy({ platforms: policy.platforms.map(platform => ({ platform: platform.platform, enabled })) })
  }

  function setVisibleModels(enabled: boolean) {
    if (!visibleModels.length) return
    updatePolicy({ models: visibleModels.map(model => ({ modelDbId: model.modelDbId, enabled })) })
  }

  function setFreeUpdaterProvider(platform: string, selected: boolean) {
    const next = new Set(selectedFreeUpdaterProviders.map(String))
    if (selected) next.add(platform)
    else {
      if (freeUpdaterStatus?.enabled && next.size === 1 && next.has(platform)) return
      next.delete(platform)
    }
    updateFreeUpdaterProviders.mutate(Array.from(next).sort((a, b) => a.localeCompare(b)))
  }

  function setAllFreeUpdaterProviders(selected: boolean) {
    if (!selected && freeUpdaterStatus?.enabled) return
    updateFreeUpdaterProviders.mutate(selected ? freeUpdaterProviders.map(provider => provider.platform) : [])
  }

  function saveFreeUpdaterInterval() {
    const parsed = Number.parseInt(freeUpdaterInterval, 10)
    enableFreeUpdater.mutate(Number.isFinite(parsed) ? Math.min(24, Math.max(1, parsed)) : 6)
  }

  function toggleFreeUpdater(enabled: boolean) {
    if (enabled) {
      saveFreeUpdaterInterval()
    } else {
      disableFreeUpdater.mutate()
    }
  }

  function downloadBackup() {
    const anchor = document.createElement('a')
    anchor.href = apiUrl('/api/settings/backup/export/database')
    anchor.download = ''
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setBackupError(null)
    setBackupStatus('Secure SQLite backup download started. Keep the matching credential-encryption key separately.')
  }

  async function handleBackupFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setBackupFileName(file.name)
    setBackupStatus(null)
    setBackupError(null)
    try {
      const legacyJson = file.name.toLowerCase().endsWith('.json') || file.type === 'application/json'
      if (legacyJson) {
        if (file.size > MAX_LEGACY_BACKUP_JSON_BYTES) {
          throw new Error(`Legacy JSON imports are limited to ${formatBytes(MAX_LEGACY_BACKUP_JSON_BYTES)} in the dashboard. Use the streamed .db backup format for larger instances.`)
        }
        const payload = JSON.parse(await file.text()) as FullBackupPayload
        if (payload.format !== 'llmharbor.full-instance-backup.v1' || payload.database?.encoding !== 'base64') {
          throw new Error('Choose an LLMHarbor .db backup or legacy backup JSON file.')
        }
        const keyCount = payload.manifest?.localProxyKeys ?? 'unknown number of'
        const ok = window.confirm(`Stage ${file.name} for restore? After the next LLMHarbor restart it will replace provider and OAuth credentials, analytics, policies, and ${keyCount} local proxy key record(s). The matching credential-encryption key must already be installed.`)
        if (!ok) return
        importBackup.mutate({ kind: 'legacy-json', payload })
        return
      }
      if (file.size === 0) throw new Error('The SQLite backup is empty.')
      const ok = window.confirm(`Stage ${file.name} for restore? After the next LLMHarbor restart it will replace credentials, analytics, routing, and access policies. The matching credential-encryption key must already be installed.`)
      if (!ok) return
      importBackup.mutate({ kind: 'database', file })
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : String(error))
    } finally {
      if (backupFileRef.current) backupFileRef.current.value = ''
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Settings"
        title="Local API access controls"
        description="Give every app its own route, provider, and model policy. One local /v1 endpoint, many isolated permissions."
        actions={
          <Button variant="outline" onClick={() => navigate('/keys')}>
            Manage keys
          </Button>
        }
      />

      <nav className="nav-scroll -mt-2 flex gap-1 overflow-x-auto border-b border-border pb-3" aria-label="Settings sections">
        <a href="#backup-restore" className="shrink-0 rounded-[var(--radius-button)] px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">Backup & restore</a>
        <a href="#free-model-updater" className="shrink-0 rounded-[var(--radius-button)] px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">Free model updater</a>
        <a href="#access-policies" className="shrink-0 rounded-[var(--radius-button)] px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">Access policies</a>
      </nav>

      <section id="backup-restore" className="panel-card scroll-mt-24 rounded-[var(--radius-panel)] p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <SectionTitle
            title="Database backup"
            description="Export or stage the SQLite state: encrypted provider and OAuth credentials, analytics, routing policies, and hash-only local key records with their limits and usage."
            action={<Badge variant="secondary">Sensitive</Badge>}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={downloadBackup} disabled={importBackup.isPending}>
              Export backup
            </Button>
            <Button type="button" variant="outline" onClick={() => backupFileRef.current?.click()} disabled={importBackup.isPending}>
              {importBackup.isPending ? 'Verifying…' : 'Import backup'}
            </Button>
            <Input
              ref={backupFileRef}
              className="hidden"
              type="file"
              accept=".db,.sqlite,.json,application/vnd.sqlite3,application/octet-stream,application/json"
              onChange={handleBackupFile}
            />
          </div>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <SummaryTile label="Backup contents" value="SQLite" detail="Encrypted credentials, catalog, analytics, access policies, and key hashes." tone="warn" />
          <SummaryTile label="Local proxy keys" value={clientKeys.length} detail="Existing secrets keep working after restore, but cannot be recovered from the export." />
          <SummaryTile label="Activation" value="Restart" detail="Imports are verified and staged; active traffic keeps using the current database." />
        </div>
        <div className="mt-4 rounded-[var(--radius-panel)] border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-100">
          Keep exports private. The credential-encryption key is deliberately excluded: preserve the matching <code>llmharbor.db.key</code> separately with mode 600, or restore under the same <code>ENCRYPTION_KEY</code>. An import with a mismatched key is rejected before activation.
        </div>
        {backupFileName && !backupStatus && !backupError && (
          <p className="mt-3 text-xs text-muted-foreground">Selected file: {backupFileName}</p>
        )}
        {backupStatus && (
          <div className="mt-4 rounded-[var(--radius-panel)] border border-emerald-500/20 bg-emerald-500/8 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-200" role="status">
            {backupStatus}
          </div>
        )}
        {backupError && (
          <div className="mt-4 rounded-[var(--radius-panel)] border border-rose-500/25 bg-rose-500/8 px-3 py-2 text-sm text-rose-700 dark:text-rose-200" role="alert">
            {backupError}
          </div>
        )}
      </section>

      <section id="free-model-updater" className="panel-card scroll-mt-24 rounded-[var(--radius-panel)] p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <SectionTitle
            title="Free model updater"
            description="Disabled by default. Select ready providers, then optionally let LLMHarbor discover free/free-tier models, probe them, and keep the local catalog fresh."
            action={<Badge variant="secondary">Beta</Badge>}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Label htmlFor="free-updater-interval" className="text-xs text-muted-foreground">Interval (hours)</Label>
            <Input
              id="free-updater-interval"
              className="h-9 w-24"
              type="number"
              min={1}
              max={24}
              value={freeUpdaterInterval}
              onChange={event => setFreeUpdaterIntervalDraft(event.target.value)}
            />
            <Switch
              checked={freeUpdaterStatus?.enabled ?? false}
              onCheckedChange={toggleFreeUpdater}
              disabled={freeUpdaterBusy || (!(freeUpdaterStatus?.enabled ?? false) && !canEnableFreeUpdater)}
              aria-label={(freeUpdaterStatus?.enabled ?? false) ? 'Disable free model updater' : 'Enable free model updater'}
            />
            {(freeUpdaterStatus?.enabled ?? false) && freeUpdaterIntervalDraft !== null && freeUpdaterIntervalDraft !== String(freeUpdaterStatus?.refreshIntervalHours ?? 6) ? (
              <Button type="button" variant="outline" size="sm" disabled={freeUpdaterBusy} onClick={saveFreeUpdaterInterval}>
                {enableFreeUpdater.isPending ? 'Saving…' : 'Save interval'}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canRefreshFreeUpdater}
              onClick={() => refreshFreeModels.mutate()}
            >
              {refreshFreeModels.isPending ? 'Refreshing…' : 'Refresh selected'}
            </Button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryTile label="Status" value={manualRefreshActive ? 'running' : freeUpdaterStatusLoading ? 'loading' : freeUpdaterStatus?.status ?? 'idle'} detail={freeUpdaterStatus?.enabled ? 'Background refresh enabled.' : 'Background refresh disabled.'} />
          <SummaryTile label="Selected" value={freeUpdaterStatus?.selectedProviderCount ?? selectedFreeUpdaterProviders.length} detail="Only these providers are fetched." tone={selectedFreeUpdaterProviders.length ? 'good' : 'warn'} />
          <SummaryTile label="Detected" value={freeUpdaterStatus?.detectedCount ?? detectedFreeModels.length} detail="Candidates from the latest selected-provider refresh." />
          <SummaryTile label="Last run" value={freeUpdaterStatus?.lastRunAt ? new Date(freeUpdaterStatus.lastRunAt).toLocaleString() : 'Never'} detail="Most recent updater cycle." />
        </div>

        <div className="mt-5 rounded-[var(--radius-panel)] border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-100">
          <strong>Beta safeguard:</strong> the updater stays off until you opt in. Built-in providers appear only when a usable upstream key is enabled. Custom endpoints are opt-in, user-declared free/local catalogs. Review provider quotas before enabling background refresh.
        </div>

        <div className="mt-5 rounded-[var(--radius-panel)] border border-border bg-background p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium">Provider selection</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Refresh selected fetches only the providers selected here. Built-in providers appear only when they have a usable enabled key. Custom endpoints remain opt-in and are treated as user-declared free/local catalogs; every listed model is probed before it is marked verified.
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button type="button" size="sm" variant="outline" disabled={freeUpdaterBusy || freeUpdaterProviders.length === 0} onClick={() => setAllFreeUpdaterProviders(true)}>Select all</Button>
              <Button type="button" size="sm" variant="outline" disabled={freeUpdaterBusy || selectedFreeUpdaterProviders.length === 0 || Boolean(freeUpdaterStatus?.enabled)} onClick={() => setAllFreeUpdaterProviders(false)}>Clear</Button>
            </div>
          </div>
          <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {freeUpdaterProvidersLoading ? (
              <div className="md:col-span-2 xl:col-span-3"><LoadingState title="Loading ready providers" description="Checking enabled keys and custom endpoints…" /></div>
            ) : freeUpdaterProvidersError ? (
              <div className="md:col-span-2 xl:col-span-3"><ErrorState title="Could not load updater providers" description={freeUpdaterProvidersQueryError.message} action={<Button variant="outline" size="sm" onClick={() => refetchFreeUpdaterProviders()}>Retry</Button>} /></div>
            ) : freeUpdaterProviders.length === 0 ? (
              <EmptyState title="No ready providers" description="Add or enable an API key for a supported free-tier provider, or create/enable a custom OpenAI-compatible endpoint. The beta updater only shows providers it can actually refresh." />
            ) : freeUpdaterProviders.map(provider => (
              <div key={provider.platform} className={cn('rounded-[var(--radius-panel)] border p-3 transition-colors', provider.selected ? 'border-primary bg-primary/5' : 'border-border bg-card')}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{provider.name}</p>
                    <code className="mt-1 block truncate text-[11px] text-muted-foreground">{provider.platform}</code>
                  </div>
                  <Switch checked={provider.selected} disabled={freeUpdaterBusy || Boolean(freeUpdaterStatus?.enabled && provider.selected && selectedFreeUpdaterProviders.length === 1)} onCheckedChange={checked => setFreeUpdaterProvider(provider.platform, checked)} aria-label={`${provider.selected ? 'Deselect' : 'Select'} ${provider.name} for free model refresh`} />
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Badge variant="secondary">{provider.source}</Badge>
                  <Badge variant="outline">{provider.detectionPolicy}</Badge>
                  {provider.hasEnabledKey ? <Badge variant="default">key ready</Badge> : <Badge variant="secondary">custom/local</Badge>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {freeUpdaterStatus?.errorMessage && (
          <div className="mt-4 rounded-[var(--radius-panel)] border border-rose-500/25 bg-rose-500/8 px-3 py-2 text-sm text-rose-700 dark:text-rose-200" role="alert">
            {freeUpdaterStatus.errorMessage}
          </div>
        )}

        {freeUpdaterStatusError && (
          <div className="mt-4">
            <ErrorState title="Could not load updater status" description={freeUpdaterStatusQueryError.message} action={<Button variant="outline" size="sm" onClick={() => refetchFreeUpdaterStatus()}>Retry</Button>} />
          </div>
        )}

        {freeUpdaterActionError && (
          <div className="mt-4 rounded-[var(--radius-panel)] border border-rose-500/25 bg-rose-500/8 px-3 py-2 text-sm text-rose-700 dark:text-rose-200" role="alert">
            {freeUpdaterActionError.message}
          </div>
        )}

        <div className="mt-5 rounded-[var(--radius-panel)] border border-border bg-background p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Detected free models preview</p>
            <Badge variant="secondary">{detectingFreeModels ? 'Loading…' : `${detectedFreeModels.length} candidates`}</Badge>
          </div>
          <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
            {detectedFreeModels.length === 0 ? (
              <EmptyState title="No preview yet" description={selectedFreeUpdaterProviders.length === 0 ? 'Select one or more ready providers before refreshing.' : 'Refresh selected providers to load free/free-tier candidates. Nothing is fetched from unselected providers.'} />
            ) : detectedFreeModels.slice(0, 80).map(model => (
              <div key={`${model.platform}:${model.modelId}`} className="rounded-xl border border-border bg-card px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{model.displayName}</span>
                  <Badge variant="outline">{model.platform}</Badge>
                  <Badge variant="secondary">{model.detectionMethod}</Badge>
                  <Badge variant={model.verificationStatus === 'verified' ? 'default' : 'secondary'}>{model.verificationStatus}</Badge>
                </div>
                <code className="mt-1 block truncate text-muted-foreground">{model.modelId}</code>
                {model.lastError && <p className="mt-1 text-rose-600 dark:text-rose-300">{model.lastError}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="access-policies" className="grid min-w-0 max-w-full scroll-mt-24 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-labelledby="access-policies-title">
        <div className="sm:col-span-2 xl:col-span-4">
          <h2 id="access-policies-title" className="text-base font-semibold">Client access policies</h2>
          <p className="mt-1 text-sm text-muted-foreground">Choose a local API key, then constrain its OpenAI-compatible routes, providers, and models.</p>
        </div>
        <SummaryTile label="Client keys" value={clientKeys.length} detail="Per app, agent, laptop, or experiment." />
        <SummaryTile label="Routes allowed" value={`${allowedRoutes}/${policy?.routes.length ?? 0}`} detail="OpenAI-compatible surface area." tone={blockedRoutes ? 'warn' : 'good'} />
        <SummaryTile label="Providers allowed" value={`${allowedProviders}/${policy?.platforms.length ?? 0}`} detail="Whole endpoint families for this key." tone={blockedProviders ? 'warn' : 'good'} />
        <SummaryTile label="Model blocks" value={blockedModels} detail="Explicit per-key catalog denies." tone={blockedModels ? 'warn' : 'default'} />
      </section>

      <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(260px,0.72fr)_minmax(0,1.28fr)]">
        <aside className="min-w-0 space-y-4 xl:sticky xl:top-28 xl:self-start">
          <div className="panel-card rounded-[var(--radius-panel)] p-5">
            <SectionTitle title="Choose a local key" description="Policies are isolated. Blocking a provider here will not affect other apps." />
            {clientKeysLoading ? (
              <LoadingState title="Loading client keys" />
            ) : clientKeysError ? (
              <ErrorState title="Could not load client keys" description={clientKeysQueryError.message} action={<Button variant="outline" size="sm" onClick={() => refetchClientKeys()}>Retry</Button>} />
            ) : clientKeys.length === 0 ? (
              <EmptyState
                title="No local API keys"
                description="Create a client key on the Keys page, then return here to set route, provider, and model policy."
                action={<Button onClick={() => navigate('/keys')}>Create a key</Button>}
              />
            ) : (
              <div className="mt-4 space-y-2">
                {clientKeys.map(key => (
                  <button
                    key={key.id}
                    type="button"
                    onClick={() => chooseKey(key.id)}
                    className={cn(
                      'w-full rounded-[var(--radius-panel)] border p-3 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/30',
                      activeKeyId === key.id ? 'border-primary bg-primary/10' : 'border-border bg-background hover:bg-muted/60',
                    )}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{key.label}</p>
                        <code className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">{key.maskedKey}</code>
                      </div>
                      <Badge variant={key.enabled ? 'default' : 'secondary'}>{key.enabled ? 'On' : 'Off'}</Badge>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {key.lastUsedAt ? `Last used ${new Date(key.lastUsedAt).toLocaleString()}` : 'Ready for route, provider, and model policy'}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="panel-card rounded-[var(--radius-panel)] p-5">
            <SectionTitle title="Compatibility surface" description="The router keeps the default /v1 path and host mappings. New segmentation happens through per-key policy." />
            <div className="grid gap-2 text-sm">
              <div className="flex justify-between gap-3 rounded-xl bg-background px-3 py-2"><span className="text-muted-foreground">Endpoint rows</span><span className="font-medium tabular-nums">{totalEndpoints}</span></div>
              <div className="flex justify-between gap-3 rounded-xl bg-background px-3 py-2"><span className="text-muted-foreground">Host mappings</span><span className="font-medium tabular-nums">{legacyDomains}</span></div>
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-100">
                Custom local endpoint creation is closed. Create one client key per app, then scope it here.
              </div>
            </div>
          </div>
        </aside>

        <div className="space-y-5 min-w-0">
          {!selectedKey ? (
            <EmptyState title="Select a key" description="Choose a local client key to edit its access policy." />
          ) : policyLoading ? (
            <LoadingState title="Loading access policy" description="Resolving route, provider, and model rules…" />
          ) : policyError ? (
            <ErrorState title="Could not load access policy" description={policyQueryError.message} action={<Button variant="outline" size="sm" onClick={() => refetchPolicy()}>Retry</Button>} />
          ) : !policy ? (
            <EmptyState title="Policy unavailable" description="The selected key could not be loaded." />
          ) : (
            <>
              {patchPolicy.isError ? <InlineNotice tone="critical">{patchPolicy.error.message}</InlineNotice> : null}
              <section className="panel-card rounded-[var(--radius-panel)] p-5">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-primary/80">Active policy</p>
                    <h2 className="mt-1 truncate text-xl font-semibold tracking-[-0.035em]">{policy.key.label}</h2>
                    <code className="mt-2 block truncate rounded-xl bg-muted/70 px-3 py-2 font-mono text-xs text-muted-foreground">{policy.key.maskedKey}</code>
                  </div>
                  <div className="grid min-w-0 max-w-full gap-2 text-xs sm:grid-cols-3 lg:min-w-[460px]">
                    <div className="rounded-[var(--radius-button)] border border-border bg-background p-3"><span className="block text-muted-foreground">Base URL</span><code className="mt-1 block truncate font-mono">/v1</code></div>
                    <div className="rounded-[var(--radius-button)] border border-border bg-background p-3"><span className="block text-muted-foreground">Providers</span><span className="mt-1 block truncate font-medium tabular-nums">{allowedProviders}/{policy.platforms.length} allowed</span></div>
                    <div className="rounded-[var(--radius-button)] border border-border bg-background p-3"><span className="block text-muted-foreground">Models</span><span className="mt-1 block truncate font-medium tabular-nums">{allowedModels}/{policy.models.length} allowed</span></div>
                  </div>
                </div>
                <div className="mt-5 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <p className="text-sm leading-6 text-muted-foreground">
                    {totalBlocked === 0
                      ? 'This key can call every available route, provider, and catalog model.'
                      : `This key has ${totalBlocked.toLocaleString()} active policy block${totalBlocked === 1 ? '' : 's'} across routes, providers, and models.`}
                  </p>
                  <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap md:justify-end">
                    <PolicyActionButton disabled={patchPolicy.isPending} onClick={() => setAllRoutes(true)}>Open routes</PolicyActionButton>
                    <PolicyActionButton disabled={patchPolicy.isPending} onClick={() => setAllPlatforms(true)}>Allow providers</PolicyActionButton>
                    <PolicyActionButton disabled={patchPolicy.isPending || visibleModels.length === 0} onClick={() => setVisibleModels(true)}>Allow visible models</PolicyActionButton>
                  </div>
                </div>
              </section>

              <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="panel-card min-w-0 rounded-[var(--radius-panel)] p-5">
                  <SectionTitle
                    title="Route access"
                    description="Keep the proxy surface small for untrusted tools. Denied routes fail with a 403 before routing."
                    action={<PolicyActionButton disabled={patchPolicy.isPending} onClick={() => setAllRoutes(true)}>Allow all</PolicyActionButton>}
                  />
                  <div className="space-y-3">
                    {policy.routes.map(route => (
                      <div key={route.id} className={cn('min-w-0 rounded-[var(--radius-panel)] border p-4 transition-colors', policyTone(route.enabled))}>
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-medium">{route.name}</p>
                              <Badge variant="outline">{route.method}</Badge>
                            </div>
                            <code className="mt-2 block font-mono text-xs text-muted-foreground">{route.path}</code>
                            <p className="mt-2 text-xs leading-5 text-muted-foreground">{route.description}</p>
                          </div>
                          <Switch checked={route.enabled} onCheckedChange={(enabled) => updatePolicy({ routes: [{ route: route.id, enabled }] })} disabled={patchPolicy.isPending} aria-label={`${route.enabled ? 'Block' : 'Allow'} route ${route.name}`} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="panel-card min-w-0 rounded-[var(--radius-panel)] p-5">
                  <SectionTitle
                    title="Provider endpoints"
                    description="Block whole upstream families while leaving the key valid for approved providers."
                    action={<PolicyActionButton disabled={patchPolicy.isPending} onClick={() => setAllPlatforms(true)}>Allow all</PolicyActionButton>}
                  />
                  <div className="max-h-[440px] space-y-2 overflow-y-auto pr-1">
                    {policy.platforms.map(provider => (
                      <div key={provider.platform} className={cn('min-w-0 rounded-[var(--radius-panel)] border p-3 transition-colors', provider.enabled ? 'border-border bg-background' : 'border-rose-500/25 bg-rose-500/5')}>
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="truncate text-sm font-medium">{provider.name}</p>
                              <Badge variant="outline">{provider.source}</Badge>
                            </div>
                            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{provider.platform}</p>
                            {provider.baseUrl && <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{provider.baseUrl}</p>}
                          </div>
                          <div className="flex shrink-0 items-center gap-3">
                            <PolicyStateBadge enabled={provider.enabled} />
                            <Switch checked={provider.enabled} onCheckedChange={(enabled) => updatePolicy({ platforms: [{ platform: provider.platform, enabled }] })} disabled={patchPolicy.isPending} aria-label={`${provider.enabled ? 'Block' : 'Allow'} provider ${provider.name}`} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </section>

              <section className="panel-card rounded-[var(--radius-panel)] p-5">
                <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-end 2xl:justify-between">
                  <SectionTitle title="Model scope" description="Fine tune the catalog visible to this key. Explicit blocked model requests fail before any upstream call." />
                  <div className="grid w-full min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(180px,1fr)_minmax(140px,180px)_max-content] 2xl:max-w-[620px]">
                    <div className="grid gap-1">
                      <Label htmlFor="client-key-model-search" className="text-xs text-muted-foreground">Search</Label>
                      <Input id="client-key-model-search" type="search" value={modelSearch} onChange={event => setModelSearch(event.target.value)} placeholder="gpt, gemini, llama…" />
                    </div>
                    <div className="grid gap-1">
                      <Label className="text-xs text-muted-foreground">Provider</Label>
                      <Select value={platformFilter} onValueChange={value => setPlatformFilter(value ?? 'all')}>
                        <SelectTrigger className="w-full" aria-label="Filter models by provider"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All providers</SelectItem>
                          {providerOptions.map(platform => <SelectItem key={platform} value={platform}>{platform}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button type="button" className="h-10 w-full self-end whitespace-nowrap sm:col-span-2 lg:col-span-1 lg:w-auto" variant={showBlockedOnly ? 'default' : 'outline'} onClick={() => setShowBlockedOnly(prev => !prev)}>
                      {showBlockedOnly ? 'Show all models' : 'Blocked only'}
                    </Button>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-panel)] border border-border bg-background p-3">
                  <p className="text-sm text-muted-foreground">
                    Showing <span className="font-medium text-foreground tabular-nums">{visibleModels.length}</span> of <span className="font-medium text-foreground tabular-nums">{policy.models.length}</span> models. <span className="font-medium text-foreground tabular-nums">{allowedModels}</span> currently allowed.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <PolicyActionButton disabled={patchPolicy.isPending || visibleModels.length === 0} onClick={() => setVisibleModels(true)}>Allow visible</PolicyActionButton>
                    <PolicyActionButton disabled={patchPolicy.isPending || visibleModels.length === 0} onClick={() => setVisibleModels(false)} variant="outline">Block visible</PolicyActionButton>
                  </div>
                </div>

                <div className="mt-4 max-h-[620px] space-y-2 overflow-y-auto pr-1">
                  {visibleModels.length === 0 ? (
                    <EmptyState title="No matching models" description="Adjust the provider filter or search query." />
                  ) : visibleModels.map(model => {
                    const contextLabel = formatContextWindow(model.contextWindow)
                    return (
                      <div key={model.modelDbId} className={cn('rounded-[var(--radius-panel)] border p-3 transition-colors', model.enabled ? 'border-border bg-background' : 'border-rose-500/25 bg-rose-500/5')}>
                        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="truncate text-sm font-medium">{model.displayName}</p>
                              <Badge variant="outline">{model.platform}</Badge>
                              {contextLabel && <Badge variant="secondary">{contextLabel}</Badge>}
                              {!model.catalogEnabled && <Badge variant="secondary">Catalog off</Badge>}
                            </div>
                            <code className="mt-1 block truncate font-mono text-xs text-muted-foreground">{model.modelId}</code>
                          </div>
                          <div className="flex shrink-0 items-center justify-between gap-3 md:justify-end">
                            <PolicyStateBadge enabled={model.enabled} />
                            <Switch checked={model.enabled} onCheckedChange={(enabled) => updatePolicy({ models: [{ modelDbId: model.modelDbId, enabled }] })} disabled={patchPolicy.isPending} aria-label={`${model.enabled ? 'Block' : 'Allow'} model ${model.displayName}`} />
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                {(policy.models.length > visibleModels.length) && (
                  <p className="mt-3 text-xs text-muted-foreground">Showing {visibleModels.length} filtered models out of {policy.models.length}. Use search or provider filters to narrow the catalog.</p>
                )}
              </section>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
