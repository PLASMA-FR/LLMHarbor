import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, NavLink, useLocation, useSearchParams, useNavigate } from 'react-router-dom'
import { Download, RefreshCw, Square, Upload } from 'lucide-react'
import type {
  DetectedFreeModel,
  FreeModelUpdaterProviderOption,
  FreeModelUpdaterStatus,
} from '../../../shared/types'
import { apiFetch, apiUrl } from '@/lib/api'
import { notify, useConfirm } from '@/lib/feedback'
import { invalidateRoutingQueries } from '@/lib/query-cache'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { PageHeader, SectionTitle, LoadingState, EmptyState } from '@/components/page-header'
import { SectionTabs } from '@/components/section-tabs'
import { ErrorNotice } from '@/components/error-notice'
import { InlineNotice, StatusIndicator } from '@/components/status-indicator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SearchField, Pagination } from '@/components/collection-controls'

function DiscoverySettings() {
  const queryClient = useQueryClient()
  const [hours, setHours] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const previous = useRef<string | null>(null)
  const status = useQuery<FreeModelUpdaterStatus>({
    queryKey: ['free-model-updater-status'],
    queryFn: ({ signal }) => apiFetch('/api/discovery/status', { signal }),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 2000 : 30_000),
  })
  const options = useQuery<{ providers: FreeModelUpdaterProviderOption[] }>({
    queryKey: ['free-model-updater-providers'],
    queryFn: ({ signal }) => apiFetch('/api/discovery/providers', { signal }),
  })
  const detected = useQuery<DetectedFreeModel[]>({
    queryKey: ['free-model-updater-detected-models'],
    queryFn: ({ signal }) => apiFetch('/api/discovery/detected-models', { signal }),
    refetchInterval: status.data?.status === 'running' ? 3000 : false,
  })
  const refreshQueries = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['free-model-updater-status'] }),
      queryClient.invalidateQueries({ queryKey: ['free-model-updater-providers'] }),
      queryClient.invalidateQueries({ queryKey: ['free-model-updater-detected-models'] }),
      invalidateRoutingQueries(queryClient),
    ])
  useEffect(() => {
    const next = status.data?.status ?? null
    if (previous.current === 'running' && next === 'idle') {
      notify('Model discovery finished.')
      void invalidateRoutingQueries(queryClient)
      void queryClient.invalidateQueries({ queryKey: ['free-model-updater-detected-models'] })
    }
    previous.current = next
  }, [status.data?.status, queryClient])
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      apiFetch('/api/discovery/' + path, {
        method: path === 'providers' ? 'PUT' : 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    onSuccess: (_data, variables) => {
      if (variables.path === 'enable') setHours(null)
      if (variables.path === 'refresh') notify('Discovery started. You can keep using the dashboard.')
      return refreshQueries()
    },
  })
  const providers = options.data?.providers ?? []
  const selected = providers.filter((provider) => provider.selected).map((provider) => provider.platform)
  const running = status.data?.status === 'running'
  const interval = hours ?? String(status.data?.refreshIntervalHours ?? 6)
  const intervalValid = Number.isInteger(Number(interval)) && Number(interval) >= 1 && Number(interval) <= 24
  const filtered = (detected.data ?? []).filter((model) =>
    `${model.displayName} ${model.modelId} ${model.platform}`.toLowerCase().includes(search.toLowerCase()),
  )
  const activePage = Math.min(page, Math.max(1, Math.ceil(filtered.length / 15)))
  return (
    <div className="space-y-5">
      <section className="panel-card rounded-xl p-5">
        <SectionTitle
          title="Model discovery"
          description="Discover and verify models from selected providers. Probes can consume provider quota."
          action={
            <StatusIndicator
              label={running ? 'Refreshing' : status.data?.enabled ? 'Scheduled' : 'Manual only'}
              tone={running ? 'warning' : status.data?.enabled ? 'positive' : 'neutral'}
            />
          }
        />
        <div className="flex flex-wrap items-end gap-4 border-y border-border py-4">
          <div className="flex items-center gap-3">
            <Switch
              checked={status.data?.enabled ?? false}
              disabled={action.isPending || running || !selected.length}
              onCheckedChange={(enabled) =>
                action.mutate({
                  path: enabled ? 'enable' : 'disable',
                  ...(enabled ? { body: { refreshIntervalHours: Number(interval) } } : {}),
                })
              }
              aria-label="Automatic model discovery"
            />
            <span className="text-sm">Automatic discovery</span>
          </div>
          <form
            className="ml-auto flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              action.mutate({ path: 'enable', body: { refreshIntervalHours: Number(interval) } })
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="discovery-hours" className="text-xs">
                Every (hours)
              </Label>
              <Input
                id="discovery-hours"
                className="w-20"
                type="number"
                min={1}
                max={24}
                step={1}
                value={interval}
                onChange={(event) => setHours(event.target.value)}
                disabled={action.isPending || running}
                required
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              type="submit"
              disabled={
                !status.data?.enabled || !intervalValid || hours === null || action.isPending || running
              }
            >
              Save interval
            </Button>
          </form>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Last refresh: {formatRelativeTime(status.data?.lastRunAt ?? null)}
            {status.data?.nextRunAt ? ` · Next: ${formatDateTime(status.data.nextRunAt)}` : ''}
          </p>
          {running ? (
            <Button
              variant="outline"
              disabled={action.isPending}
              onClick={() => action.mutate({ path: 'cancel' })}
            >
              <Square aria-hidden="true" />
              Stop refresh
            </Button>
          ) : (
            <Button
              disabled={!selected.length || action.isPending}
              onClick={() => action.mutate({ path: 'refresh' })}
            >
              <RefreshCw aria-hidden="true" />
              Refresh selected
            </Button>
          )}
        </div>
        <div className="mt-4">
          <ErrorNotice error={status.error ?? action.error} />
          {status.data?.errorMessage ? (
            <InlineNotice tone="critical">{status.data.errorMessage}</InlineNotice>
          ) : null}
        </div>
      </section>
      <section className="panel-card rounded-xl p-5">
        <SectionTitle
          title="Selected providers"
          description="Custom endpoints are treated as your own free/local catalogs. Select only the providers you want discovery to contact."
        />
        <ErrorNotice error={options.error} />
        {options.isLoading ? (
          <LoadingState title="Loading providers" />
        ) : !providers.length ? (
          <EmptyState
            title="Connect a provider first"
            description="Add usable API credentials or a custom endpoint to make discovery available."
            action={<Button render={<NavLink to="/providers" />}>Open Providers</Button>}
          />
        ) : (
          <div className="divide-y divide-border">
            {providers.map((provider) => (
              <div key={provider.platform} className="flex items-center justify-between gap-4 py-3">
                <div>
                  <p className="text-sm font-medium">{provider.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {provider.source === 'custom' ? 'Custom endpoint' : 'Provider API'}
                  </p>
                </div>
                <Switch
                  checked={provider.selected}
                  disabled={
                    action.isPending ||
                    running ||
                    Boolean(status.data?.enabled && provider.selected && selected.length === 1)
                  }
                  onCheckedChange={(checked) =>
                    action.mutate({
                      path: 'providers',
                      body: {
                        selectedProviders: checked
                          ? [...selected, provider.platform]
                          : selected.filter((platform) => platform !== provider.platform),
                      },
                    })
                  }
                  aria-label={`${provider.selected ? 'Deselect' : 'Select'} ${provider.name} for discovery`}
                />
              </div>
            ))}
          </div>
        )}
        {status.data?.enabled ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Keep at least one provider selected while automatic discovery is enabled.
          </p>
        ) : null}
      </section>
      <section className="panel-card overflow-hidden rounded-xl">
        <div className="p-5">
          <SectionTitle
            title="Discovered models"
            description="Only verified new models become available for automatic routing."
          />
          <SearchField
            label="Search discovered models"
            value={search}
            onChange={(value) => {
              setSearch(value)
              setPage(1)
            }}
            placeholder="Find a discovered model…"
          />
          <div className="mt-3">
            <ErrorNotice error={detected.error} />
          </div>
        </div>
        {!filtered.length ? (
          <div className="px-5 pb-5">
            <EmptyState
              title={search ? 'No matching models' : 'No discovery results yet'}
              description="Select a provider and run a refresh to populate this list."
            />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Model</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead className="pr-5">Verification</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.slice((activePage - 1) * 15, activePage * 15).map((model) => (
                <TableRow key={`${model.platform}/${model.modelId}`}>
                  <TableCell className="max-w-sm pl-5">
                    <p className="truncate font-medium" title={model.displayName}>
                      {model.displayName}
                    </p>
                    <code className="block truncate text-xs text-muted-foreground" title={model.modelId}>
                      {model.modelId}
                    </code>
                  </TableCell>
                  <TableCell className="text-xs">{model.platform}</TableCell>
                  <TableCell className="pr-5">
                    <StatusIndicator
                      label={model.verificationStatus}
                      tone={model.verificationStatus === 'verified' ? 'positive' : 'neutral'}
                    />
                    {model.lastError ? (
                      <p className="mt-1 max-w-xs text-xs text-muted-foreground">{model.lastError}</p>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Pagination page={activePage} pageSize={15} total={filtered.length} onPageChange={setPage} />
      </section>
    </div>
  )
}

function BackupSettings() {
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<unknown>(null)
  const [result, setResult] = useState<string | null>(null)
  const status = useQuery<{
    databaseBytes: number
    pendingRestore: boolean
    stagedAt: string | null
    maxBackupBytes: number
  }>({ queryKey: ['backup-status'], queryFn: ({ signal }) => apiFetch('/api/backups/status', { signal }) })
  const restore = useMutation({
    mutationFn: (file: File) =>
      apiFetch<{ previousBackupPath?: string }>('/api/backups/import/database', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-LLMHarbor-Restore-Confirmation': 'RESTORE_LLMHARBOR_BACKUP',
        },
        body: file,
        timeoutMs: 300_000,
      }),
    onSuccess: () => {
      setResult('Backup verified and staged. Restart LLMHarbor to activate it.')
      notify('Backup staged. Restart to activate the restore.')
      return queryClient.invalidateQueries({ queryKey: ['backup-status'] })
    },
  })
  const legacyRestore = useMutation({
    mutationFn: (body: unknown) =>
      apiFetch('/api/backups/import', { method: 'POST', body: JSON.stringify(body), timeoutMs: 300_000 }),
    onSuccess: () => {
      setResult('Legacy backup verified and staged. Restart LLMHarbor to activate it.')
      return queryClient.invalidateQueries({ queryKey: ['backup-status'] })
    },
  })
  const busy = restore.isPending || legacyRestore.isPending
  async function chooseFile(file: File) {
    setError(null)
    setResult(null)
    restore.reset()
    legacyRestore.reset()
    try {
      if (!file.size) throw new Error('The backup file is empty.')
      const legacy = file.name.toLowerCase().endsWith('.json')
      if (legacy && file.size > 32 * 1024 * 1024)
        throw new Error('Use a streamed .db backup for files larger than 32 MB.')
      if (status.data && file.size > status.data.maxBackupBytes)
        throw new Error('This file exceeds the server backup limit.')
      if (
        !(await confirm({
          title: 'Stage this backup for restore?',
          description: `${file.name} will replace this instance’s credentials, models, access policies and history after the next restart. A recovery copy of the active database will be kept. The matching encryption key must already be installed.`,
          confirmLabel: 'Verify & stage restore',
        }))
      )
        return
      if (legacy) {
        const body = JSON.parse(await file.text()) as { format?: string; database?: unknown }
        if (body.format !== 'llmharbor.full-instance-backup.v1' || !body.database)
          throw new Error('Choose an LLMHarbor backup file.')
        legacyRestore.mutate({
          format: body.format,
          database: body.database,
          confirm: 'RESTORE_LLMHARBOR_BACKUP',
        })
      } else restore.mutate(file)
    } catch (caught) {
      setError(caught)
    }
  }
  return (
    <div className="max-w-4xl space-y-5">
      {status.data?.pendingRestore ? (
        <InlineNotice tone="warning">
          A verified restore is staged
          {status.data.stagedAt ? ` from ${formatDateTime(status.data.stagedAt)}` : ''}. Restart LLMHarbor to
          activate it. Current traffic still uses the active database.
        </InlineNotice>
      ) : null}
      <section className="panel-card rounded-xl p-6">
        <SectionTitle
          title="Download an instance backup"
          description="Save a consistent SQLite snapshot of credentials, models, routing, access policies and request history."
        />
        <p className="mb-5 text-sm text-muted-foreground">
          Current database:{' '}
          {status.data ? `${(status.data.databaseBytes / 1024 / 1024).toFixed(1)} MB` : 'Checking…'}
        </p>
        <Button render={<a href={apiUrl('/api/backups/export/database')} download />}>
          <Download aria-hidden="true" />
          Download backup
        </Button>
        <div className="mt-5 rounded-lg bg-muted/50 p-4 text-sm leading-6 text-muted-foreground">
          Keep the matching <code>llmharbor.db.key</code> or <code>ENCRYPTION_KEY</code> separately. The
          backup excludes this encryption key, and it is required to recover stored provider credentials.
        </div>
      </section>
      <section className="panel-card rounded-xl p-6">
        <SectionTitle
          title="Restore an instance"
          description="Upload an LLMHarbor .db backup or a legacy .json export. The server verifies it before staging a replacement."
        />
        <div className="rounded-xl border border-dashed border-border p-6 text-center">
          <Upload className="mx-auto mb-3 size-6 text-muted-foreground" aria-hidden="true" />
          <p className="mb-4 text-sm text-muted-foreground">Choose the backup you want to restore.</p>
          <Button variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Verifying backup…' : 'Choose backup file'}
          </Button>
          <Input
            ref={fileRef}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-label="Backup file"
            accept=".db,.sqlite,.json"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void chooseFile(file)
            }}
          />
        </div>
        <div className="mt-4 space-y-3">
          <ErrorNotice error={error ?? restore.error ?? legacyRestore.error ?? status.error} />
          {result ? <InlineNotice tone="positive">{result}</InlineNotice> : null}
        </div>
      </section>
    </div>
  )
}

export default function InstanceSettingsPage() {
  const location = useLocation()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const section =
    location.hash === '#backup-restore' || params.get('section') === 'backup' ? 'backup' : 'discovery'
  if (params.has('key') || location.hash === '#access-policies')
    return <Navigate to={'/access' + location.search} replace />
  return (
    <div>
      <PageHeader title="Settings" description="Manage model discovery and instance backups." />
      <div className="mb-6">
        <SectionTabs
          label="Settings sections"
          value={section}
          onChange={(value) => navigate(`/settings?section=${value}`)}
          items={[
            { value: 'discovery', label: 'Model discovery' },
            { value: 'backup', label: 'Backup & restore' },
          ]}
        />
      </div>
      {section === 'backup' ? <BackupSettings /> : <DiscoverySettings />}
    </div>
  )
}
