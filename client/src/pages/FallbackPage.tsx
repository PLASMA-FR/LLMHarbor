import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { PageHeader, EmptyState } from '@/components/page-header'
import { cn } from '@/lib/utils'

interface FallbackEntry {
  modelDbId: number
  priority: number
  effectivePriority: number
  penalty: number
  rateLimitHits: number
  enabled: boolean
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
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

interface TokenUsageData {
  totalBudget: number
  totalUsed: number
  models: { displayName: string; platform: string; budget: number }[]
}

const platformColors: Record<string, string> = {
  google: '#4285f4', groq: '#f55036', cerebras: '#8b5cf6', sambanova: '#14b8a6', nvidia: '#76b900',
  mistral: '#f59e0b', openrouter: '#ec4899', github: '#6e7b8b', cohere: '#d946ef', cloudflare: '#f38020',
  zhipu: '#06b6d4', ollama: '#0f766e', kilo: '#7c3aed', pollinations: '#a855f7', llm7: '#0ea5e9', huggingface: '#ff9d00',
}

function TokenUsageBar({ data }: { data: TokenUsageData }) {
  const { totalBudget, totalUsed, models } = data
  const remaining = Math.max(0, totalBudget - totalUsed)
  const remainingPct = totalBudget > 0 ? Math.round((remaining / totalBudget) * 100) : 0
  const modelsWithWidth = models.map(m => ({
    ...m,
    remainingTokens: totalBudget > 0 ? (m.budget / totalBudget) * remaining : 0,
    widthPct: totalBudget > 0 ? (m.budget / totalBudget) * (remaining / totalBudget) * 100 : 0,
  }))
  const usedPct = totalBudget > 0 ? (totalUsed / totalBudget) * 100 : 0

  return (
    <section className="panel-card rounded-2xl p-5 sm:p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-primary/80">Budget remaining</p>
          <h2 className="mt-1 text-lg font-semibold tracking-[-0.03em]">Monthly token budget</h2>
        </div>
        <span className="text-sm text-muted-foreground tabular-nums"><span className="font-semibold text-foreground">{formatTokens(remaining)}</span> remaining, {remainingPct}% of {formatTokens(totalBudget)}</span>
      </div>
      <div className="mt-5 flex h-3 overflow-hidden rounded-lg bg-muted ">
        {modelsWithWidth.map((m, i) => <div key={i} title={`${m.displayName} (${m.platform}) - ${formatTokens(m.remainingTokens)} remaining`} style={{ width: `${m.widthPct}%`, backgroundColor: platformColors[m.platform] ?? '#94a3b8' }} />)}
        {totalUsed > 0 && <div title={`Used - ${formatTokens(totalUsed)}`} className="bg-muted-foreground/30" style={{ width: `${usedPct}%` }} />}
      </div>
      <div className="mt-5 grid grid-cols-1 gap-x-5 gap-y-2 text-xs tabular-nums sm:grid-cols-2 lg:grid-cols-3">
        {modelsWithWidth.map((m, i) => (
          <div key={i} className="flex min-w-0 items-center gap-2">
            <span className="size-2 rounded-lg" style={{ backgroundColor: platformColors[m.platform] ?? '#94a3b8' }} />
            <span className="truncate">{m.displayName}</span>
            <span className="flex-1" />
            <span className="font-mono text-muted-foreground">{formatTokens(m.remainingTokens)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function SortableModelRow({ entry, index, onToggle }: { entry: FallbackEntry; index: number; onToggle: (modelDbId: number, enabled: boolean) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.modelDbId })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const color = platformColors[entry.platform] ?? '#94a3b8'

  return (
    <div ref={setNodeRef} style={style} className={cn('group grid gap-3 bg-card px-4 py-4 transition-colors hover:bg-muted/35 sm:grid-cols-[auto_auto_minmax(0,1fr)_auto] sm:items-center', isDragging && 'opacity-50', !entry.enabled && 'opacity-55')}>
      <button {...attributes} {...listeners} className="cursor-grab rounded-xl p-1 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground active:cursor-grabbing" aria-label="Drag to reorder">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" /><circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" /><circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" /></svg>
      </button>
      <div className="flex size-9 items-center justify-center rounded-2xl border border-border bg-background font-mono text-xs tabular-nums text-muted-foreground">{index + 1}</div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="size-2 rounded-lg" style={{ backgroundColor: color }} />
          <span className="truncate text-sm font-semibold">{entry.displayName}</span>
          <span className="rounded-lg bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{entry.platform}</span>
          {entry.penalty > 0 && <span className="rounded-lg bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-300">-{entry.penalty} penalty</span>}
        </div>
        <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground tabular-nums">
          <span>Intel #{entry.intelligenceRank}</span>
          <span>Speed #{entry.speedRank}</span>
          {entry.rpmLimit && <span>{entry.rpmLimit} rpm</span>}
          {entry.rpdLimit && <span>{entry.rpdLimit} rpd</span>}
          <span>{entry.monthlyTokenBudget} tok/mo</span>
        </div>
      </div>
      <Switch checked={entry.enabled} onCheckedChange={(checked) => onToggle(entry.modelDbId, checked)} />
    </div>
  )
}

export default function FallbackPage() {
  const queryClient = useQueryClient()
  const [localEntries, setLocalEntries] = useState<FallbackEntry[] | null>(null)

  const { data: entries = [], isLoading } = useQuery<FallbackEntry[]>({ queryKey: ['fallback'], queryFn: () => apiFetch('/api/fallback') })
  const { data: tokenUsage } = useQuery<TokenUsageData>({ queryKey: ['fallback', 'token-usage'], queryFn: () => apiFetch('/api/fallback/token-usage') })

  const saveMutation = useMutation({
    mutationFn: (data: { modelDbId: number; priority: number; enabled: boolean }[]) => apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['fallback'] }); setLocalEntries(null) },
  })
  const sortMutation = useMutation({
    mutationFn: (preset: string) => apiFetch(`/api/fallback/sort/${preset}`, { method: 'POST' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['fallback'] }); setLocalEntries(null) },
  })

  const allEntries = localEntries ?? entries
  const displayEntries = allEntries.filter(e => e.keyCount > 0)
  const unconfiguredPlatforms = [...new Set(allEntries.filter(e => e.keyCount === 0).map(e => e.platform))]
  const enabledCount = displayEntries.filter(e => e.enabled).length

  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = displayEntries.findIndex(e => e.modelDbId === active.id)
    const newIndex = displayEntries.findIndex(e => e.modelDbId === over.id)
    const reorderedVisible = arrayMove(displayEntries, oldIndex, newIndex)
    const unconfigured = allEntries.filter(e => e.keyCount === 0)
    setLocalEntries([...reorderedVisible.map((e, i) => ({ ...e, priority: i + 1 })), ...unconfigured.map((e, i) => ({ ...e, priority: reorderedVisible.length + i + 1 }))])
  }

  function handleToggle(modelDbId: number, enabled: boolean) {
    setLocalEntries(allEntries.map(e => e.modelDbId === modelDbId ? { ...e, enabled } : e))
  }

  function handleSave() {
    if (!localEntries) return
    saveMutation.mutate(allEntries.map(e => ({ modelDbId: e.modelDbId, priority: e.priority, enabled: e.enabled })))
  }

  const hasChanges = localEntries !== null

  return (
    <div>
      <PageHeader
        eyebrow="Routing order"
        title="Fallback chain"
        description="Put the models in the order LLMHarbor should try them. Disabled or exhausted models are skipped."
        actions={<>
          <Button variant="outline" size="sm" onClick={() => sortMutation.mutate('intelligence')} disabled={sortMutation.isPending}>Best answers</Button>
          <Button variant="outline" size="sm" onClick={() => sortMutation.mutate('speed')} disabled={sortMutation.isPending}>Fastest</Button>
          <Button variant="outline" size="sm" onClick={() => sortMutation.mutate('budget')} disabled={sortMutation.isPending}>Most budget left</Button>
        </>}
      />

      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-[var(--radius-panel)] border border-border bg-card p-4 "><p className="text-xs font-medium text-muted-foreground">Configured models</p><p className="mt-2 text-2xl font-semibold tabular-nums">{displayEntries.length}</p></div>
          <div className="rounded-[var(--radius-panel)] border border-border bg-card p-4 "><p className="text-xs font-medium text-muted-foreground">Enabled</p><p className="mt-2 text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-300">{enabledCount}</p></div>
          <div className="rounded-[var(--radius-panel)] border border-border bg-card p-4 "><p className="text-xs font-medium text-muted-foreground">Hidden providers</p><p className="mt-2 text-2xl font-semibold tabular-nums">{unconfiguredPlatforms.length}</p></div>
        </div>

        {tokenUsage && tokenUsage.totalBudget > 0 && <TokenUsageBar data={tokenUsage} />}

        {isLoading ? (
          <div className="panel-card rounded-[var(--radius-panel)] p-8 text-sm text-muted-foreground">Loading fallback chain...</div>
        ) : displayEntries.length === 0 ? (
          <EmptyState title="No models available" description="Add provider keys first, then return here to set the routing order." />
        ) : (
          <>
            <div className="panel-card overflow-hidden rounded-[var(--radius-panel)]">
              <div className="border-b border-border bg-card px-4 py-3 text-xs font-medium text-muted-foreground">Drag rows to change order</div>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={displayEntries.map(e => e.modelDbId)} strategy={verticalListSortingStrategy}>
                  <div className="divide-y divide-border">
                    {displayEntries.map((entry, index) => <SortableModelRow key={entry.modelDbId} entry={entry} index={index} onToggle={handleToggle} />)}
                  </div>
                </SortableContext>
              </DndContext>
            </div>

            {hasChanges && (
              <div className="sticky bottom-4 z-10 flex justify-end gap-2 rounded-[var(--radius-panel)] border border-border bg-background p-3 ">
                <Button variant="outline" size="sm" onClick={() => setLocalEntries(null)}>Discard</Button>
                <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>{saveMutation.isPending ? 'Saving...' : 'Save chain'}</Button>
              </div>
            )}

            {unconfiguredPlatforms.length > 0 && <p className="text-xs leading-5 text-muted-foreground">Hidden until you add keys: {unconfiguredPlatforms.join(', ')}</p>}
          </>
        )}
      </div>
    </div>
  )
}
