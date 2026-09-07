import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink } from 'react-router-dom'
import { ArrowDown, ArrowUp, ArrowUpToLine, Save } from 'lucide-react'
import { ApiError, apiFetch, apiRequest } from '@/lib/api'
import { useConfirm, notify } from '@/lib/feedback'
import { invalidateRoutingQueries } from '@/lib/query-cache'
import { formatCompactNumber } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { PageHeader, EmptyState, LoadingState, ErrorState } from '@/components/page-header'
import { ErrorNotice } from '@/components/error-notice'
import { SearchField, Pagination } from '@/components/collection-controls'
import { StatusIndicator, InlineNotice } from '@/components/status-indicator'
import { UnsavedChanges } from '@/components/unsaved-changes'
import { cn } from '@/lib/utils'

interface RouteEntry {
  modelDbId: number
  priority: number
  effectivePriority: number
  enabled: boolean
  modelEnabled: boolean
  eligible: boolean
  skipReason: string | null
  platform: string
  modelId: string
  displayName: string
  configuredKeyCount: number
  availableKeyCount: number
  penalty: number
  activeCooldowns: number
}
interface Draft {
  entries: RouteEntry[]
  etag: string | null
  baseline: string
}
const signature = (entries: RouteEntry[]) =>
  JSON.stringify(entries.map((entry) => [entry.modelDbId, entry.enabled]))

export default function RoutingPage() {
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [budgetsOpen, setBudgetsOpen] = useState(false)
  const query = useQuery({
    queryKey: ['routing-editor'],
    queryFn: ({ signal }) => apiRequest<RouteEntry[]>('/api/routing', { signal }),
  })
  const budget = useQuery<{
    totalBudget: number
    totalUsed: number
    models: Array<{ displayName: string; platform: string; budget: number }>
  }>({
    queryKey: ['fallback', 'token-usage'],
    queryFn: ({ signal }) => apiFetch('/api/routing/token-usage', { signal }),
    enabled: budgetsOpen,
  })
  const changed = draft !== null && signature(draft.entries) !== draft.baseline
  const entries = changed ? draft.entries : (query.data?.data ?? [])
  const configured = entries.filter((entry) => entry.configuredKeyCount > 0)
  const filtered = configured.filter((entry) =>
    `${entry.displayName} ${entry.modelId} ${entry.platform}`.toLowerCase().includes(search.toLowerCase()),
  )
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / 15)))
  const save = useMutation({
    mutationFn: (value: Draft) =>
      apiFetch('/api/routing', {
        method: 'PUT',
        headers: value.etag ? { 'If-Match': value.etag } : undefined,
        body: JSON.stringify(
          value.entries.map((entry, index) => ({
            modelDbId: entry.modelDbId,
            priority: index + 1,
            enabled: entry.enabled,
          })),
        ),
      }),
    onSuccess: async () => {
      await invalidateRoutingQueries(queryClient)
      setDraft(null)
      notify('Routing order saved.')
    },
  })
  function update(entries: RouteEntry[]) {
    const base = changed
      ? draft
      : {
          entries: query.data?.data ?? [],
          etag: query.data?.etag ?? null,
          baseline: signature(query.data?.data ?? []),
        }
    setDraft({ ...base!, entries: entries.map((entry, index) => ({ ...entry, priority: index + 1 })) })
  }
  const preset = useMutation({
    mutationFn: (name: string) => apiFetch<{ order: number[] }>(`/api/routing/presets/${name}`),
    onSuccess: (result) => {
      const byId = new Map(entries.map((entry) => [entry.modelDbId, entry]))
      update(
        result.order.flatMap((id) => {
          const entry = byId.get(id)
          return entry ? [entry] : []
        }),
      )
      setPage(1)
      notify('Preset applied to the draft. Save to use this order.')
    },
  })
  function move(id: number, direction: -1 | 1 | 'top') {
    const visibleIndex = configured.findIndex((entry) => entry.modelDbId === id)
    const targetIndex = direction === 'top' ? 0 : visibleIndex + direction
    if (targetIndex < 0 || targetIndex >= configured.length) return
    const reordered = [...configured]
    const [entry] = reordered.splice(visibleIndex, 1)
    reordered.splice(targetIndex, 0, entry)
    let index = 0
    update(entries.map((item) => (item.configuredKeyCount > 0 ? reordered[index++] : item)))
    if (!search) setPage(Math.floor(targetIndex / 15) + 1)
  }
  async function discard() {
    if (
      await confirm({
        title: 'Discard routing changes?',
        description: 'The saved routing configuration will remain in use.',
        confirmLabel: 'Discard changes',
      })
    ) {
      setDraft(null)
      save.reset()
    }
  }
  const busy = save.isPending || preset.isPending
  return (
    <div className="space-y-5">
      <UnsavedChanges active={changed && !save.isPending} />
      <PageHeader
        title="Routing"
        description="Set the order in which eligible models are tried. Changes stay in draft until you save."
        actions={
          <Button
            disabled={!changed || busy}
            onClick={() => {
              if (draft) save.mutate(draft)
            }}
          >
            <Save aria-hidden="true" />
            {save.isPending ? 'Saving…' : 'Save order'}
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
        <span>
          <strong className="font-mono text-foreground">
            {configured.filter((entry) => entry.enabled).length}
          </strong>{' '}
          enabled routes
        </span>
        <span>
          <strong className="font-mono text-foreground">
            {configured.filter((entry) => entry.eligible).length}
          </strong>{' '}
          currently ready
        </span>
        <span className="ml-auto text-xs">{changed ? 'Unsaved draft' : 'Saved configuration'}</span>
      </div>
      {query.isLoading ? (
        <LoadingState title="Loading routing order" />
      ) : query.isError ? (
        <ErrorState
          description={query.error.message}
          action={
            <Button variant="outline" onClick={() => query.refetch()}>
              Retry
            </Button>
          }
        />
      ) : !configured.length ? (
        <EmptyState
          title="Connect a provider to configure routing"
          description="Once credentials are available, its models appear here. You can also enable an individual route from Models."
          action={<Button render={<NavLink to="/providers" />}>Connect provider</Button>}
        />
      ) : (
        <>
          <div className="panel-card overflow-hidden rounded-xl">
            <div className="space-y-3 border-b border-border p-5">
              <div className="flex flex-wrap gap-3">
                <SearchField
                  value={search}
                  onChange={(value) => {
                    setSearch(value)
                    setPage(1)
                  }}
                  label="Search routing models"
                  placeholder="Find a model in the chain…"
                />
                <div className="flex flex-wrap items-center gap-1">
                  <span className="mr-1 text-xs text-muted-foreground">Draft preset:</span>
                  {['intelligence', 'speed', 'budget'].map((name) => (
                    <Button
                      key={name}
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => preset.mutate(name)}
                    >
                      {name[0].toUpperCase() + name.slice(1)}
                    </Button>
                  ))}
                </div>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                Use arrows to reorder. Rate-limit penalties can temporarily change the effective order.{' '}
                {search
                  ? 'Clear search to move one position, or use Move to top.'
                  : 'Only providers with configured credentials are shown.'}
              </p>
            </div>
            <div className="divide-y divide-border">
              {filtered.slice((currentPage - 1) * 15, currentPage * 15).map((entry) => {
                const position = configured.findIndex((item) => item.modelDbId === entry.modelDbId)
                const saved = query.data?.data.find((item) => item.modelDbId === entry.modelDbId)
                const pendingToggle = changed && saved?.enabled !== entry.enabled
                return (
                  <div
                    key={entry.modelDbId}
                    className={cn(
                      'flex flex-wrap items-center gap-3 px-5 py-3.5',
                      !entry.enabled && 'bg-muted/25',
                    )}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted font-mono text-xs text-muted-foreground">
                      {position + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" title={entry.displayName}>
                        {entry.displayName}
                      </p>
                      <p
                        className="mt-1 truncate text-xs text-muted-foreground"
                        title={`${entry.platform}/${entry.modelId}`}
                      >
                        {entry.platform} · {entry.availableKeyCount}/{entry.configuredKeyCount} credentials
                        usable
                      </p>
                      {pendingToggle ? (
                        <p className="mt-1 text-xs text-primary">
                          Save to {entry.enabled ? 'enable' : 'disable'} this route.
                        </p>
                      ) : entry.enabled && !entry.eligible ? (
                        <p className="mt-1 text-xs text-muted-foreground">{entry.skipReason}</p>
                      ) : entry.penalty > 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Rate-limit penalty: +{entry.penalty} priority positions
                        </p>
                      ) : null}
                    </div>
                    <StatusIndicator
                      label={
                        pendingToggle
                          ? 'Draft change'
                          : !entry.enabled
                            ? 'Off'
                            : !entry.modelEnabled
                              ? 'Catalog off'
                              : entry.eligible
                                ? 'Ready'
                                : 'Unavailable'
                      }
                      tone={
                        pendingToggle
                          ? 'info'
                          : !entry.enabled
                            ? 'neutral'
                            : entry.eligible
                              ? 'positive'
                              : 'warning'
                      }
                    />
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy || position === 0}
                        onClick={() => move(entry.modelDbId, 'top')}
                        aria-label={`Move ${entry.displayName} to top`}
                      >
                        <ArrowUpToLine aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy || position === 0 || Boolean(search)}
                        onClick={() => move(entry.modelDbId, -1)}
                        aria-label={`Move ${entry.displayName} up`}
                      >
                        <ArrowUp aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy || position === configured.length - 1 || Boolean(search)}
                        onClick={() => move(entry.modelDbId, 1)}
                        aria-label={`Move ${entry.displayName} down`}
                      >
                        <ArrowDown aria-hidden="true" />
                      </Button>
                      <Switch
                        checked={entry.enabled}
                        disabled={busy}
                        onCheckedChange={(enabled) =>
                          update(
                            entries.map((item) =>
                              item.modelDbId === entry.modelDbId ? { ...item, enabled } : item,
                            ),
                          )
                        }
                        aria-label={`${entry.enabled ? 'Disable' : 'Enable'} ${entry.displayName} in routing`}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
            {!filtered.length ? (
              <EmptyState
                title="No matching routes"
                description="Clear the search to see the routing chain."
                action={
                  <Button variant="outline" onClick={() => setSearch('')}>
                    Clear search
                  </Button>
                }
              />
            ) : null}
            <Pagination page={currentPage} pageSize={15} total={filtered.length} onPageChange={setPage} />
          </div>
          <ErrorNotice error={save.error ?? preset.error} />
          {save.error instanceof ApiError && save.error.code === 'routing_conflict' ? (
            <Button
              variant="outline"
              onClick={async () => {
                if (
                  await confirm({
                    title: 'Reload the current routing order?',
                    description:
                      'Your local draft will be discarded so you can work from the latest saved configuration.',
                    confirmLabel: 'Reload current order',
                  })
                ) {
                  setDraft(null)
                  save.reset()
                  await query.refetch()
                }
              }}
            >
              Reload current order
            </Button>
          ) : null}
          {changed ? (
            <div className="sticky bottom-4 z-30 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-popover p-4 text-popover-foreground shadow-lg">
              <p className="text-sm">Unsaved routing changes</p>
              <div className="flex gap-2">
                <Button variant="outline" disabled={busy} onClick={() => void discard()}>
                  Discard
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    if (draft) save.mutate(draft)
                  }}
                >
                  {save.isPending ? 'Saving…' : 'Save order'}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
      <details
        className="panel-card rounded-xl"
        onToggle={(event) => setBudgetsOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer p-5 text-sm font-medium">
          Usage & configured budget estimates
        </summary>
        <div className="space-y-4 border-t border-border p-5">
          <ErrorNotice error={budget.error} />
          <p className="text-sm text-muted-foreground">
            This month:{' '}
            <strong className="font-mono text-foreground">
              {formatCompactNumber(budget.data?.totalUsed ?? 0)}
            </strong>{' '}
            tokens used. Configured estimates:{' '}
            <strong className="font-mono text-foreground">
              {formatCompactNumber(budget.data?.totalBudget ?? 0)}
            </strong>
            .
          </p>
          <InlineNotice>
            Budget values are configured estimates, not provider-reported balances. Account quotas can be
            shared across models.
          </InlineNotice>
          <div className="grid gap-2 sm:grid-cols-2">
            {budget.data?.models.map((model) => (
              <p
                key={`${model.platform}/${model.displayName}`}
                className="flex justify-between gap-3 text-xs"
              >
                <span>{model.displayName}</span>
                <span className="font-mono text-muted-foreground">{formatCompactNumber(model.budget)}</span>
              </p>
            ))}
          </div>
        </div>
      </details>
    </div>
  )
}
