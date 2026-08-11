import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { formatCompactNumber, formatPercent } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { PageHeader, EmptyState, ErrorState, LoadingState } from '@/components/page-header'
import { MetricCard } from '@/components/metric-card'
import { InlineNotice, StatusIndicator } from '@/components/status-indicator'
import { cn } from '@/lib/utils'

interface FallbackEntry {
  modelDbId: number
  priority: number
  effectivePriority: number
  penalty: number
  rateLimitHits: number
  enabled: boolean
  modelEnabled: boolean
  eligible: boolean
  skipReason: string | null
  platform: string
  modelId: string
  displayName: string
  intelligenceRank: number
  speedRank: number
  sizeLabel: string
  rpmLimit: number | null
  rpdLimit: number | null
  monthlyTokenBudget: string
  keyCount: number
  configuredKeyCount: number
  enabledKeyCount: number
  routeableKeyCount: number
  availableKeyCount: number
  activeCooldowns: number
}

interface TokenUsageData {
  totalBudget: number
  totalUsed: number
  models: { displayName: string; platform: string; budget: number }[]
}

function TokenUsageBar({ data }: { data: TokenUsageData }) {
  const { totalBudget, totalUsed, models } = data
  const remaining = Math.max(0, totalBudget - totalUsed)
  const remainingPct = totalBudget > 0 ? Math.round((remaining / totalBudget) * 100) : 0
  const usedPct = totalBudget > 0 ? Math.min(100, (totalUsed / totalBudget) * 100) : 0

  return (
    <section className="panel-card rounded-[var(--radius-panel)] p-4 sm:p-5" aria-labelledby="token-budget-title">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium text-muted-foreground">Quota estimate</p>
          <h2 id="token-budget-title" className="mt-1 text-base font-semibold">Monthly token budget</h2>
        </div>
        <span className="text-sm text-muted-foreground tabular-nums"><span className="font-semibold text-foreground">{formatCompactNumber(remaining)}</span> remaining · {remainingPct}% of {formatCompactNumber(totalBudget)}</span>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Estimated monthly token budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usedPct)}>
        <div className={cn('h-full rounded-full', usedPct >= 90 ? 'bg-destructive' : usedPct >= 70 ? 'bg-amber-500' : 'bg-primary')} style={{ width: `${usedPct}%` }} />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-x-5 gap-y-2 text-xs tabular-nums sm:grid-cols-2 lg:grid-cols-3">
        {models.map(model => (
          <div key={`${model.platform}/${model.displayName}`} className="flex min-w-0 items-center gap-2">
            <span className="size-1.5 rounded-full bg-primary/70" aria-hidden="true" />
            <span className="truncate">{model.displayName}</span>
            <span className="flex-1" />
            <span className="font-mono text-muted-foreground">{formatCompactNumber(model.budget)} budget</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-5 text-muted-foreground">Usage is aggregated across routes; per-model values are configured budgets, not measured balances.</p>
    </section>
  )
}

function ModelRow({ entry, index, count, busy, onToggle, onMove }: { entry: FallbackEntry; index: number; count: number; busy: boolean; onToggle: (modelDbId: number, enabled: boolean) => void; onMove: (index: number, direction: -1 | 1) => void }) {
  const status = !entry.enabled
    ? { label: 'Disabled', tone: 'neutral' as const, reason: 'Skipped by configuration' }
    : !entry.modelEnabled
      ? { label: 'Disabled', tone: 'neutral' as const, reason: entry.skipReason ?? 'Model is disabled' }
      : !entry.eligible
        ? {
            label: entry.activeCooldowns > 0 ? 'Cooling down' : 'Unavailable',
            tone: entry.activeCooldowns > 0 ? 'warning' as const : 'critical' as const,
            reason: entry.skipReason ?? 'Not currently eligible for routing',
          }
    : entry.penalty > 0
      ? { label: 'Degraded', tone: 'warning' as const, reason: `Recent rate-limit pressure adds ${entry.penalty} priority points` }
      : { label: 'Ready', tone: 'positive' as const, reason: 'Eligible for routing' }

  return (
    <div className={cn('group grid gap-3 bg-card px-4 py-3.5 transition-colors hover:bg-muted/30 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:items-center', !entry.enabled && 'bg-muted/15')}>
      <div className="flex size-8 items-center justify-center rounded-[var(--radius-button)] border border-border bg-background font-mono text-xs tabular-nums text-muted-foreground">{index + 1}</div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold">{entry.displayName}</span>
          <span className="rounded-[var(--radius-badge)] bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{entry.platform}</span>
          <StatusIndicator label={status.label} tone={status.tone} />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
          <span>{status.reason}</span>
          <span className="font-mono">{entry.platform}/{entry.modelId}</span>
          <span>{entry.availableKeyCount}/{entry.configuredKeyCount} credentials available</span>
          <span>Base priority {entry.priority}</span>
          <span>Effective priority {entry.effectivePriority}</span>
          {entry.activeCooldowns > 0 && <span>{entry.activeCooldowns} cooling down</span>}
          <span>Intel #{entry.intelligenceRank}</span>
          <span>Speed #{entry.speedRank}</span>
          {entry.rpmLimit && <span>{entry.rpmLimit} rpm</span>}
          {entry.rpdLimit && <span>{entry.rpdLimit} rpd</span>}
          <span>{entry.monthlyTokenBudget} tok/mo</span>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-xs" onClick={() => onMove(index, -1)} disabled={busy || index === 0} aria-label={`Move ${entry.displayName} up`}><ArrowUp aria-hidden="true" /></Button>
        <Button variant="ghost" size="icon-xs" onClick={() => onMove(index, 1)} disabled={busy || index === count - 1} aria-label={`Move ${entry.displayName} down`}><ArrowDown aria-hidden="true" /></Button>
      </div>
      <Switch checked={entry.enabled} disabled={busy} onCheckedChange={(checked) => onToggle(entry.modelDbId, checked)} aria-label={`${entry.enabled ? 'Disable' : 'Enable'} ${entry.displayName} in routing`} />
    </div>
  )
}

export default function FallbackPage() {
  const queryClient = useQueryClient()
  const [localEntries, setLocalEntries] = useState<FallbackEntry[] | null>(null)

  const { data: entries = [], isLoading, isError, error, refetch } = useQuery<FallbackEntry[]>({ queryKey: ['fallback'], queryFn: ({ signal }) => apiFetch('/api/fallback', { signal }) })
  const { data: tokenUsage } = useQuery<TokenUsageData>({ queryKey: ['fallback', 'token-usage'], queryFn: ({ signal }) => apiFetch('/api/fallback/token-usage', { signal }) })

  const saveMutation = useMutation({
    mutationFn: (data: { modelDbId: number; priority: number; enabled: boolean }[]) => apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['fallback'] }); setLocalEntries(null) },
  })
  const sortMutation = useMutation({
    mutationFn: (preset: string) => apiFetch(`/api/fallback/sort/${preset}`, { method: 'POST' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['fallback'] }); setLocalEntries(null) },
  })

  const allEntries = localEntries ?? entries
  const displayEntries = allEntries.filter(e => e.configuredKeyCount > 0)
  const unconfiguredPlatforms = [...new Set(allEntries.filter(e => e.configuredKeyCount === 0).map(e => e.platform))]
  const enabledCount = displayEntries.filter(e => e.enabled).length

  function reorderVisible(reorderedVisible: FallbackEntry[]) {
    let visibleIndex = 0
    setLocalEntries(allEntries
      .map(entry => entry.configuredKeyCount > 0 ? (reorderedVisible[visibleIndex++] ?? entry) : entry)
      .map((entry, index) => ({ ...entry, priority: index + 1, effectivePriority: index + 1 + entry.penalty })))
  }

  function handleMove(index: number, direction: -1 | 1) {
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= displayEntries.length) return
    const reordered = [...displayEntries]
    const [entry] = reordered.splice(index, 1)
    if (!entry) return
    reordered.splice(nextIndex, 0, entry)
    reorderVisible(reordered)
  }

  function handleToggle(modelDbId: number, enabled: boolean) {
    setLocalEntries(allEntries.map(e => e.modelDbId === modelDbId ? { ...e, enabled } : e))
  }

  function handleSave() {
    if (!localEntries) return
    saveMutation.mutate(allEntries.map(e => ({ modelDbId: e.modelDbId, priority: e.priority, enabled: e.enabled })))
  }

  function applyPreset(preset: string) {
    if (localEntries && !window.confirm('Discard the unsaved routing edits and apply this preset?')) return
    sortMutation.mutate(preset)
  }

  const hasChanges = localEntries !== null

  return (
    <div>
      <PageHeader
        eyebrow="Automatic routing"
        title="Routing"
        description="Set deterministic fallback priority and see why a route is ready, degraded, or skipped."
        actions={<>
          <Button variant="outline" size="sm" onClick={() => applyPreset('intelligence')} disabled={sortMutation.isPending || saveMutation.isPending}>Prioritize quality</Button>
          <Button variant="outline" size="sm" onClick={() => applyPreset('speed')} disabled={sortMutation.isPending || saveMutation.isPending}>Prioritize speed</Button>
          <Button variant="outline" size="sm" onClick={() => applyPreset('budget')} disabled={sortMutation.isPending || saveMutation.isPending}>Prioritize budget</Button>
        </>}
      />

      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard label="Configured routes" value={displayEntries.length} detail="Routes with credentials" />
          <MetricCard label="Enabled" value={enabledCount} detail={`${displayEntries.filter(entry => entry.enabled && entry.penalty > 0).length} degraded`} tone={enabledCount > 0 ? 'positive' : 'warning'} />
          <MetricCard label="Catalog only" value={unconfiguredPlatforms.length} detail="Providers without credentials" />
        </div>

        {tokenUsage && tokenUsage.totalBudget > 0 && <TokenUsageBar data={tokenUsage} />}

        {(saveMutation.isError || sortMutation.isError) && (
          <InlineNotice tone="critical">
            {(saveMutation.error ?? sortMutation.error)?.message ?? 'Could not update routing order.'}
          </InlineNotice>
        )}

        {isLoading ? (
          <LoadingState title="Loading routing order" description="Fetching enabled models and token budgets…" />
        ) : isError ? (
          <ErrorState title="Could not load routing order" description={error.message} action={<Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>} />
        ) : displayEntries.length === 0 ? (
          <EmptyState title="No models available" description="Add provider keys first, then return here to set the routing order." />
        ) : (
          <>
            <div className="panel-card overflow-hidden rounded-[var(--radius-panel)]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
                <span>Arrows set the stable base order. During rate-limit pressure, the router tries the lowest effective priority first.</span>
                <span>{formatPercent(displayEntries.length ? (enabledCount / displayEntries.length) * 100 : 0, 0)} enabled</span>
              </div>
              <div className="divide-y divide-border">
                {displayEntries.map((entry, index) => <ModelRow key={entry.modelDbId} entry={entry} index={index} count={displayEntries.length} busy={saveMutation.isPending || sortMutation.isPending} onToggle={handleToggle} onMove={handleMove} />)}
              </div>
            </div>

            {hasChanges && (
              <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-panel)] border border-border bg-background/95 p-3 shadow-lg">
                <p className="text-xs text-muted-foreground">Unsaved routing changes</p>
                <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setLocalEntries(null)}>Discard</Button>
                <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>{saveMutation.isPending ? 'Saving...' : 'Save chain'}</Button>
                </div>
              </div>
            )}

            {unconfiguredPlatforms.length > 0 ? <InlineNotice>Catalog providers without enabled credentials are excluded from this routing list: {unconfiguredPlatforms.join(', ')}.</InlineNotice> : null}
          </>
        )}
      </div>
    </div>
  )
}
