import { useId, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from 'recharts'
import { apiFetch } from '@/lib/api'
import { formatCompactNumber, formatDuration, formatPercent, formatRelativeTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader, EmptyState, ErrorState, LoadingState } from '@/components/page-header'
import { MetricCard } from '@/components/metric-card'
import { StatusIndicator } from '@/components/status-indicator'
import type { AnalyticsSummary, PlatformStats, TimelinePoint } from '../../../shared/types'

type TimeRange = '24h' | '7d' | '30d' | 'alltime'

interface ModelStats {
  displayName: string
  platform: string
  requests: number
  cancelledRequests: number
  successRate: number
  avgLatencyMs: number
  totalInputTokens: number
  totalOutputTokens: number
}

interface ErrorEntry {
  id: number | string
  requestId?: string
  attempt?: number
  isFinal?: boolean
  platform: string
  error: string
  createdAt: string
}

interface ErrorBucket {
  platform?: string
  category?: string
  count: number
}

interface ErrorDistribution {
  byCategory: ErrorBucket[]
  byPlatform: ErrorBucket[]
  detailed: ErrorEntry[]
}

function Panel({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const titleId = useId()
  return (
    <section className="panel-card min-w-0 overflow-hidden rounded-[var(--radius-panel)]" aria-labelledby={titleId}>
      <div className="border-b border-border bg-card px-4 py-3.5">
        <h2 id={titleId} className="text-sm font-semibold tracking-[-0.01em]">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="min-w-0 p-4">{children}</div>
    </section>
  )
}

const axisStyle = { fontSize: 11, fill: 'var(--muted-foreground)' } as const
const gridStyle = 'var(--border)'
const primaryFill = 'var(--chart-4)'
const timeRanges: Array<{ value: TimeRange; label: string }> = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'alltime', label: 'All time' },
]

export default function AnalyticsPage() {
  const [range, setRange] = useState<TimeRange>('7d')

  const { data: summary, isLoading: summaryLoading, isError: summaryError, error: summaryQueryError, refetch: refetchSummary } = useQuery({
    queryKey: ['analytics', 'summary', range],
    queryFn: ({ signal }) => apiFetch<AnalyticsSummary>(`/api/analytics/summary?range=${range}`, { signal }),
  })

  const { data: byPlatform = [], isLoading: platformLoading, isError: platformError, error: platformQueryError, refetch: refetchPlatforms } = useQuery({
    queryKey: ['analytics', 'by-platform', range],
    queryFn: ({ signal }) => apiFetch<PlatformStats[]>(`/api/analytics/by-platform?range=${range}`, { signal }),
  })

  const { data: timeline = [], isLoading: timelineLoading, isError: timelineError, error: timelineQueryError, refetch: refetchTimeline } = useQuery({
    queryKey: ['analytics', 'timeline', range],
    queryFn: ({ signal }) => apiFetch<TimelinePoint[]>(`/api/analytics/timeline?range=${range}`, { signal }),
  })

  const { data: byModel = [], isLoading: modelLoading, isError: modelError, error: modelQueryError, refetch: refetchModels } = useQuery({
    queryKey: ['analytics', 'by-model', range],
    queryFn: ({ signal }) => apiFetch<ModelStats[]>(`/api/analytics/by-model?range=${range}`, { signal }),
  })

  const { data: errors = [], isLoading: errorsLoading, isError: errorsError, error: errorsQueryError, refetch: refetchErrors } = useQuery({
    queryKey: ['analytics', 'errors', range],
    queryFn: ({ signal }) => apiFetch<ErrorEntry[]>(`/api/analytics/errors?range=${range}`, { signal }),
  })

  const { data: errorDist, isLoading: errorDistLoading, isError: errorDistError, error: errorDistQueryError, refetch: refetchErrorDistribution } = useQuery({
    queryKey: ['analytics', 'error-distribution', range],
    queryFn: ({ signal }) => apiFetch<ErrorDistribution>(`/api/analytics/error-distribution?range=${range}`, { signal }),
  })

  const analyticsError = summaryError ? summaryQueryError : platformError ? platformQueryError : timelineError ? timelineQueryError : modelError ? modelQueryError : errorsError ? errorsQueryError : errorDistError ? errorDistQueryError : null
  const completedCount = summary ? summary.successfulRequests + summary.failedRequests : 0
  const failureCount = summary?.failedRequests ?? 0

  const refetchAll = () => Promise.all([
    refetchSummary(),
    refetchPlatforms(),
    refetchTimeline(),
    refetchModels(),
    refetchErrors(),
    refetchErrorDistribution(),
  ])

  return (
    <div>
      <PageHeader
        eyebrow="Observability"
        title="Analytics"
        description="Request volume, reliability, latency, token use, and upstream failures without vanity metrics."
        actions={
          <div className="flex gap-1 rounded-[var(--radius-input)] border border-border bg-card p-1" role="group" aria-label="Analytics time range">
            {timeRanges.map(({ value, label }) => (
              <Button
                key={value}
                variant={range === value ? 'secondary' : 'ghost'}
                size="xs"
                aria-pressed={range === value}
                onClick={() => setRange(value)}
              >
                {label}
              </Button>
            ))}
          </div>
        }
      />

      <div className="space-y-6">
        {analyticsError ? <ErrorState title="Some analytics could not load" description={analyticsError.message} action={<Button variant="outline" size="sm" onClick={() => void refetchAll()}>Retry all</Button>} /> : null}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
          <MetricCard label="Requests" value={summaryLoading ? '…' : formatCompactNumber(summary?.totalRequests ?? 0)} detail="Total routed" />
          <MetricCard
            label="Success rate"
            value={summaryLoading ? '…' : completedCount > 0 ? formatPercent(summary?.successRate ?? 0) : '—'}
            detail={completedCount > 0 ? `${summary?.successfulRequests ?? 0} successful` : 'No completed requests'}
            tone={completedCount === 0 ? 'default' : (summary?.successRate ?? 0) < 95 ? 'warning' : 'positive'}
          />
          <MetricCard label="Failures" value={summaryLoading ? '…' : failureCount} detail="Completed with error" tone={failureCount > 0 ? 'critical' : 'positive'} />
          <MetricCard label="Cancelled" value={summaryLoading ? '…' : formatCompactNumber(summary?.cancelledRequests ?? 0)} detail="Client disconnected" />
          <MetricCard label="Average latency" value={summaryLoading ? '…' : formatDuration(summary?.avgLatencyMs ?? 0)} detail="End-to-end" />
          <MetricCard label="Input tokens" value={summaryLoading ? '…' : formatCompactNumber(summary?.totalInputTokens ?? 0)} detail="Prompt usage" />
          <MetricCard label="Output tokens" value={summaryLoading ? '…' : formatCompactNumber(summary?.totalOutputTokens ?? 0)} detail="Completion usage" />
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Panel title="Requests by provider" description="Where routed traffic completed.">
            {platformLoading ? (
              <LoadingState title="Loading provider requests" />
            ) : byPlatform.length === 0 ? (
              <EmptyState title="No requests in this range" description="Send traffic through Playground or the public API to populate provider analytics." />
            ) : (
              <div>
              <p className="sr-only">{byPlatform.map(item => `${item.platform}: ${item.requests} requests`).join('; ')}</p>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart accessibilityLayer title="Requests by provider" desc="Bar chart of completed request volume for each routed provider. Use the arrow keys to inspect provider values." data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="requests" fill="var(--primary)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              </div>
            )}
          </Panel>

          <Panel title="Average latency by provider" description="End-to-end completion time.">
            {platformLoading ? (
              <LoadingState title="Loading latency" />
            ) : byPlatform.length === 0 ? (
              <EmptyState title="No latency data yet" description="Latency appears after routed requests complete." />
            ) : (
              <div>
              <p className="sr-only">{byPlatform.map(item => `${item.platform}: ${Math.round(item.avgLatencyMs)} milliseconds average latency`).join('; ')}</p>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart accessibilityLayer title="Average latency by provider" desc="Bar chart of average end-to-end latency in milliseconds for each provider. Use the arrow keys to inspect provider values." data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis unit="ms" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="avgLatencyMs" name="Latency (ms)" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              </div>
            )}
          </Panel>

          <div className="lg:col-span-2">
            <Panel title="Requests over time" description="Successful, failed, and client-cancelled requests in the selected range.">
              {timelineLoading ? (
                <LoadingState title="Loading timeline" />
              ) : timeline.length === 0 ? (
                <EmptyState title="No timeline data" description="Requests will appear here grouped by outcome." />
              ) : (
                <div>
                <p className="sr-only">{timeline.map(item => `${item.timestamp}: ${item.successCount} successful, ${item.failureCount} failed, ${item.cancelledCount} cancelled`).join('; ')}</p>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart accessibilityLayer title="Requests over time" desc="Line chart of successful, failed, and client-cancelled requests over the selected time range. Use the arrow keys to inspect each interval." data={timeline} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis dataKey="timestamp" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                    <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    <Line type="monotone" dataKey="successCount" name="Success" stroke={primaryFill} strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="failureCount" name="Failures" stroke="var(--destructive)" strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="cancelledCount" name="Cancelled" stroke="var(--muted-foreground)" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
                </div>
              )}
            </Panel>
          </div>

          <div className="lg:col-span-2">
            <Panel title="Model breakdown" description="Volume, reliability, latency, and tokens by routed model.">
              {modelLoading ? (
                <LoadingState title="Loading model breakdown" />
              ) : byModel.length === 0 ? (
                <EmptyState title="No model breakdown yet" description="Per-model usage appears after traffic has been routed." />
              ) : (
                <div className="max-h-[360px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">Model</TableHead>
                        <TableHead>Provider</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        <TableHead className="text-right">Success</TableHead>
                        <TableHead className="text-right">Latency</TableHead>
                        <TableHead className="text-right">In tokens</TableHead>
                        <TableHead className="text-right pr-4">Out tokens</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byModel.map((m, i) => {
                        const completed = Math.max(0, m.requests - m.cancelledRequests)
                        return <TableRow key={`${m.platform}:${m.displayName}:${i}`}>
                          <TableCell className="pl-4 text-sm font-medium">{m.displayName}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{m.platform}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.requests}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            <StatusIndicator
                              label={completed > 0 ? formatPercent(m.successRate) : '—'}
                              tone={completed === 0 ? 'neutral' : m.successRate >= 95 ? 'positive' : m.successRate >= 80 ? 'warning' : 'critical'}
                            />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatDuration(m.avgLatencyMs)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatCompactNumber(m.totalInputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums pr-4">{formatCompactNumber(m.totalOutputTokens)}</TableCell>
                        </TableRow>
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          <Panel title="Error types" description="Failure categories to investigate first.">
            {errorDistLoading ? (
              <LoadingState title="Loading error categories" />
            ) : !errorDist?.byCategory?.length ? (
              <EmptyState title="No categorized errors" description="Failures are categorized here when they occur." />
            ) : (
              <div className="space-y-2">
                {errorDist.byCategory.map(bucket => {
                  const quotaRelated = bucket.category?.toLowerCase().includes('rate') || bucket.category?.toLowerCase().includes('quota')
                  return (
                    <div key={bucket.category ?? 'Other'} className="flex items-center justify-between gap-4 rounded-[var(--radius-button)] border border-border bg-background px-3 py-2.5">
                      <StatusIndicator label={bucket.category ?? 'Other'} tone={quotaRelated ? 'warning' : 'critical'} />
                      <span className="font-mono text-sm tabular-nums">{bucket.count}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </Panel>

          <Panel title="Errors by provider" description="Upstreams generating failed requests.">
            {errorDistLoading ? (
              <LoadingState title="Loading error distribution" />
            ) : !errorDist?.byPlatform?.length ? (
              <EmptyState title="No provider errors" description="Provider errors will appear here when upstream calls fail." />
            ) : (
              <div>
              <p className="sr-only">{errorDist.byPlatform.map(item => `${item.platform}: ${item.count} failures`).join('; ')}</p>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart accessibilityLayer title="Errors by provider" desc="Bar chart of failed request counts for each upstream provider. Use the arrow keys to inspect provider values." data={errorDist.byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="count" fill="var(--destructive)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              </div>
            )}
          </Panel>

          <div className="lg:col-span-2">
          <Panel title="Recent errors" description="Latest sanitized upstream failures.">
            {errorsLoading ? (
              <LoadingState title="Loading recent errors" />
            ) : errors.length === 0 ? (
              <EmptyState title="No recent errors" description="Failed upstream calls will appear here with their sanitized message." />
            ) : (
              <div className="max-h-[240px] overflow-y-auto -mx-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Provider</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead className="text-right pr-4">Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {errors.slice(0, 20).map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="pl-4 text-xs">{e.platform}</TableCell>
                        <TableCell>
                          <StatusIndicator
                            label={e.isFinal ? 'Final failure' : `Fallback attempt ${e.attempt ?? ''}`.trim()}
                            tone={e.isFinal ? 'critical' : 'warning'}
                          />
                        </TableCell>
                        <TableCell className="text-xs max-w-[200px] truncate" title={e.error}>{e.error}</TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground tabular-nums pr-4">
                          <span title={new Date(e.createdAt).toLocaleString()}>{formatRelativeTime(e.createdAt)}</span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
          </div>
        </div>
      </div>
    </div>
  )
}
