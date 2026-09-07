import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState, ErrorState, LoadingState, PageHeader, SectionTitle } from '@/components/page-header'
import { MetricCard } from '@/components/metric-card'
import { SetupChecklist } from '@/components/setup-checklist'
import { StatusIndicator, type StatusTone } from '@/components/status-indicator'
import { apiFetch } from '@/lib/api'
import { formatCompactNumber, formatDuration, formatPercent, formatRelativeTime } from '@/lib/format'
import type { AnalyticsSummary, PlatformStats, RequestLog } from '../../../shared/types'

interface HealthPlatform {
  platform: string
  hasProvider: boolean
  totalKeys: number
  healthyKeys: number
  rateLimitedKeys: number
  invalidKeys: number
  errorKeys: number
  unknownKeys: number
  enabledKeys: number
}

interface HealthData {
  platforms: HealthPlatform[]
  keys: Array<{
    id: number
    platform: string
    label: string
    status: string
    enabled: boolean
    lastCheckedAt: string | null
  }>
}

interface RouteEntry {
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
  keyCount: number
  configuredKeyCount: number
  enabledKeyCount: number
  routeableKeyCount: number
  availableKeyCount: number
  activeCooldowns: number
}

interface RecentRequest {
  id: number
  platform: string
  modelId: string
  displayName?: string
  status: RequestLog['status']
  inputTokens: number
  outputTokens: number
  latencyMs: number
  error: string | null
  createdAt: string
}

interface RecentError {
  id: number
  requestId: string
  attempt: number
  isFinal: boolean
  platform: string
  modelId: string
  error: string | null
  latencyMs: number
  createdAt: string
}

function routeStatus(route: RouteEntry): { label: string; tone: StatusTone; reason: string } {
  if (!route.enabled) return { label: 'Disabled', tone: 'neutral', reason: 'Disabled in routing configuration' }
  if (!route.modelEnabled) return { label: 'Disabled', tone: 'neutral', reason: route.skipReason ?? 'Model is disabled' }
  if (!route.eligible) {
    return route.activeCooldowns > 0
      ? { label: 'Cooling down', tone: 'warning', reason: route.skipReason ?? 'Credentials are cooling down' }
      : { label: 'Unavailable', tone: 'critical', reason: route.skipReason ?? 'No healthy enabled credentials' }
  }
  if (route.penalty > 0) return { label: 'Degraded', tone: 'warning', reason: `Recent rate-limit pressure adds ${route.penalty} priority positions` }
  return { label: 'Ready', tone: 'positive', reason: 'Eligible for automatic routing' }
}

function providerStatus(platform: HealthPlatform): { label: string; tone: StatusTone } {
  if (!platform.hasProvider) return { label: 'Provider unavailable', tone: 'critical' }
  if (platform.enabledKeys === 0) return { label: 'Paused', tone: 'neutral' }
  if (platform.invalidKeys + platform.errorKeys > 0) return { label: 'Needs attention', tone: 'critical' }
  if (platform.rateLimitedKeys > 0) return { label: 'Rate-limited', tone: 'warning' }
  if (platform.healthyKeys > 0) return { label: 'Healthy', tone: 'positive' }
  return { label: 'Unchecked', tone: 'neutral' }
}

function requestTone(status: RequestLog['status']): StatusTone {
  if (status === 'success') return 'positive'
  if (status === 'cancelled') return 'neutral'
  return 'critical'
}

function requestStatusLabel(status: RequestLog['status']): string {
  if (status === 'success') return 'Success'
  if (status === 'cancelled') return 'Cancelled'
  return 'Failed'
}

export default function OverviewPage() {
  const navigate = useNavigate()
  const health = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: ({ signal }) => apiFetch('/api/health', { signal }),
    refetchInterval: 30_000,
  })
  const routes = useQuery<RouteEntry[]>({
    queryKey: ['fallback'],
    queryFn: ({ signal }) => apiFetch('/api/fallback', { signal }),
  })
  const summary = useQuery<AnalyticsSummary>({
    queryKey: ['analytics', 'summary', '24h'],
    queryFn: ({ signal }) => apiFetch('/api/analytics/summary?range=24h', { signal }),
  })
  const platformStats = useQuery<PlatformStats[]>({
    queryKey: ['analytics', 'by-platform', '24h'],
    queryFn: ({ signal }) => apiFetch('/api/analytics/by-platform?range=24h', { signal }),
  })
  const recent = useQuery<RecentRequest[]>({
    queryKey: ['analytics', 'recent', '24h', 12],
    queryFn: ({ signal }) => apiFetch('/api/analytics/recent?range=24h&limit=12', { signal }),
  })
  const errors = useQuery<RecentError[]>({
    queryKey: ['analytics', 'errors', '24h'],
    queryFn: ({ signal }) => apiFetch('/api/analytics/errors?range=24h', { signal }),
  })
  const retryAll = () => Promise.all([
    health.refetch(),
    routes.refetch(),
    summary.refetch(),
    platformStats.refetch(),
    recent.refetch(),
    errors.refetch(),
  ])

  const routeEntries = routes.data ?? []
  const configuredRoutes = routeEntries.filter(route => route.configuredKeyCount > 0)
  const readyRoutes = configuredRoutes.filter(route => route.eligible && route.penalty === 0)
  const degradedRoutes = configuredRoutes.filter(route => route.eligible && route.penalty > 0)
  const providerCount = health.data?.platforms.filter(platform => platform.totalKeys > 0).length ?? 0
  const credentialIssues = health.data?.keys.filter(key => key.enabled && ['error', 'invalid', 'rate_limited'].includes(key.status)).length ?? 0
  const quotaLimitedRoutes = configuredRoutes.filter(route => !route.eligible && /quota limit/i.test(route.skipReason ?? '')).length
  const tokenUsage = (summary.data?.totalInputTokens ?? 0) + (summary.data?.totalOutputTokens ?? 0)
  const isInitialLoading = health.isLoading || routes.isLoading || summary.isLoading
  const coreUnavailable = health.isError && routes.isError && summary.isError
  const completedRequests = (summary.data?.successfulRequests ?? 0) + (summary.data?.failedRequests ?? 0)

  return (
    <div>
      <PageHeader
        eyebrow="Control plane"
        title="Overview"
        description="Operational health, routing readiness, and the traffic signals that need attention."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void retryAll()} disabled={health.isFetching || routes.isFetching || summary.isFetching}>
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
            <Button size="sm" onClick={() => navigate('/playground')}>Test a request</Button>
          </>
        }
      />

      <SetupChecklist />
      {coreUnavailable ? (
        <ErrorState title="Dashboard data is unavailable" description="LLMHarbor did not respond to the health, routing, or analytics checks." action={<Button variant="outline" size="sm" onClick={() => void retryAll()}>Retry</Button>} />
      ) : isInitialLoading ? (
        <LoadingState title="Checking LLMHarbor" description="Loading health, routes, and recent traffic…" />
      ) : (
        <div className="space-y-6">
          <section aria-labelledby="overview-health-heading">
            <h2 id="overview-health-heading" className="sr-only">Service health</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <MetricCard
                label="Service"
                value={health.isError ? 'Unavailable' : 'Online'}
                detail={credentialIssues > 0 ? `${credentialIssues} credential issue${credentialIssues === 1 ? '' : 's'}` : 'Control API responding'}
                tone={health.isError ? 'critical' : credentialIssues > 0 ? 'warning' : 'positive'}
              />
              <MetricCard label="Providers" value={providerCount} detail="Configured upstreams" />
              <MetricCard label="Ready routes" value={readyRoutes.length} detail={`${degradedRoutes.length} degraded`} tone={readyRoutes.length > 0 ? 'positive' : 'warning'} />
              <MetricCard
                label="Requests · 24h"
                value={formatCompactNumber(summary.data?.totalRequests ?? 0)}
                detail={completedRequests > 0 ? `${formatPercent(summary.data?.successRate ?? 0)} successful` : 'No completed requests'}
              />
              <MetricCard label="Average latency" value={formatDuration(summary.data?.avgLatencyMs ?? 0)} detail="Completed requests · 24h" />
              <MetricCard
                label="Token usage · 24h"
                value={formatCompactNumber(tokenUsage)}
                detail={quotaLimitedRoutes > 0 ? `${quotaLimitedRoutes} route${quotaLimitedRoutes === 1 ? '' : 's'} at a configured limit` : 'No routes blocked by quota'}
                tone={quotaLimitedRoutes > 0 ? 'warning' : 'default'}
              />
            </div>
          </section>

          <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
            <section className="panel-card min-w-0 overflow-hidden rounded-[var(--radius-panel)]" aria-labelledby="recent-requests-heading">
              <div className="flex items-end justify-between gap-4 border-b border-border px-4 py-3.5">
                <div>
                  <h2 id="recent-requests-heading" className="text-sm font-semibold">Recent requests</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">Most recent routed traffic in the last 24 hours.</p>
                </div>
                <Button variant="ghost" size="xs" onClick={() => navigate('/analytics?view=requests')}>View analytics <ArrowRight aria-hidden="true" /></Button>
              </div>
              {recent.isLoading ? (
                <div className="p-4"><LoadingState title="Loading recent traffic" /></div>
              ) : recent.isError ? (
                <div className="p-4"><ErrorState title="Recent traffic unavailable" description={recent.error.message} action={<Button variant="outline" size="sm" onClick={() => recent.refetch()}>Retry</Button>} /></div>
              ) : (recent.data?.length ?? 0) === 0 ? (
                <div className="p-4"><EmptyState title="No traffic yet" description="Send a Playground request or call the /v1 API to verify routing." /></div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>Route</TableHead>
                      <TableHead className="text-right">Latency</TableHead>
                      <TableHead className="text-right">Tokens</TableHead>
                      <TableHead className="text-right">When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recent.data?.map(request => (
                      <TableRow key={request.id}>
                        <TableCell><StatusIndicator label={requestStatusLabel(request.status)} tone={requestTone(request.status)} /></TableCell>
                        <TableCell>
                          <p className="max-w-64 truncate text-sm font-medium">{request.displayName ?? request.modelId}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{request.platform}</p>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatDuration(request.latencyMs)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCompactNumber(request.inputTokens + request.outputTokens)}</TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground" title={new Date(request.createdAt).toLocaleString()}>{formatRelativeTime(request.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>

            <section className="panel-card min-w-0 rounded-[var(--radius-panel)] p-4" aria-labelledby="provider-health-heading">
              <SectionTitle id="provider-health-heading" title="Provider health" description="Enabled credentials by upstream." action={<Button variant="ghost" size="xs" onClick={() => navigate('/providers')}>Manage</Button>} />
              <div className="space-y-1">
                {(health.data?.platforms ?? []).filter(platform => platform.totalKeys > 0).slice(0, 8).map(platform => {
                  const activeKeys = health.data?.keys.filter(key => key.platform === platform.platform && key.enabled) ?? []
                  const healthyKeys = activeKeys.filter(key => key.status === 'healthy').length
                  const status = providerStatus({ ...platform, healthyKeys,
                    invalidKeys: activeKeys.filter(key => key.status === 'invalid').length,
                    errorKeys: activeKeys.filter(key => key.status === 'error').length,
                    rateLimitedKeys: activeKeys.filter(key => key.status === 'rate_limited').length,
                  })
                  return (
                    <div key={platform.platform} className="flex items-center justify-between gap-4 rounded-[var(--radius-button)] px-2 py-2 hover:bg-muted/40">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{platform.platform}</p>
                        <p className="text-xs text-muted-foreground">{healthyKeys}/{platform.enabledKeys} enabled credentials healthy</p>
                      </div>
                      <StatusIndicator label={status.label} tone={status.tone} />
                    </div>
                  )
                })}
                {(health.data?.platforms.length ?? 0) === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">No provider credentials configured.</p> : null}
              </div>
            </section>
          </div>

          <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
            <section className="panel-card min-w-0 overflow-hidden rounded-[var(--radius-panel)]" aria-labelledby="route-readiness-heading">
              <div className="flex items-end justify-between gap-4 border-b border-border px-4 py-3.5">
                <div>
                  <h2 id="route-readiness-heading" className="text-sm font-semibold">Route readiness</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">Why each configured route will be used or skipped.</p>
                </div>
                <Button variant="ghost" size="xs" onClick={() => navigate('/fallback')}>Edit order <ArrowRight aria-hidden="true" /></Button>
              </div>
              <div className="divide-y divide-border">
                {configuredRoutes.slice(0, 8).map((route, index) => {
                  const status = routeStatus(route)
                  return (
                    <div key={route.modelDbId} className="grid min-w-0 grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
                      <span className="font-mono text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{route.displayName}</p>
                        <p className="truncate text-xs text-muted-foreground">{route.platform}/{route.modelId} · {status.reason}</p>
                      </div>
                      <StatusIndicator label={status.label} tone={status.tone} />
                    </div>
                  )
                })}
              </div>
            </section>

            <section className="panel-card min-w-0 rounded-[var(--radius-panel)] p-4" aria-labelledby="recent-failures-heading">
              <SectionTitle id="recent-failures-heading" title="Recent failures" description="Latest upstream errors in the last 24 hours." action={<Button variant="ghost" size="xs" onClick={() => navigate('/analytics')}>Inspect</Button>} />
              <div className="space-y-2">
                {errors.isLoading ? <LoadingState title="Loading failures" /> : errors.isError ? (
                  <ErrorState title="Failures unavailable" description={errors.error.message} />
                ) : (errors.data?.length ?? 0) === 0 ? (
                  <div className="py-5 text-center"><StatusIndicator label="No failures in this range" tone="positive" /></div>
                ) : errors.data?.slice(0, 5).map(error => (
                  <div key={error.id} className="rounded-[var(--radius-button)] border border-border bg-background px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="truncate text-xs font-medium">{error.platform} · {error.modelId}</p>
                        <StatusIndicator label={error.isFinal === false ? 'Fallback attempt' : 'Request failed'} tone={error.isFinal === false ? 'warning' : 'critical'} />
                      </div>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{formatRelativeTime(error.createdAt)}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{error.error ?? 'Unknown upstream error'}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {(platformStats.data?.length ?? 0) > 0 ? (
            <p className="text-xs text-muted-foreground">
              Most active provider in the last 24 hours: <span className="font-medium text-foreground">{platformStats.data?.[0]?.platform}</span> with {formatCompactNumber(platformStats.data?.[0]?.requests ?? 0)} requests.
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}
