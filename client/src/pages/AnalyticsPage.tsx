import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from 'recharts'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader, EmptyState, ErrorState, LoadingState } from '@/components/page-header'

type TimeRange = '24h' | '7d' | '30d' | 'alltime'

interface AnalyticsSummary {
  totalRequests: number
  successRate: number
  totalInputTokens: number
  totalOutputTokens: number
  avgLatencyMs: number
  estimatedCostSavings: string | number
}

interface PlatformStats {
  platform: string
  requests: number
  avgLatencyMs: number
}

interface TimelinePoint {
  timestamp: string
  successCount: number
  failureCount: number
}

interface ModelStats {
  displayName: string
  platform: string
  requests: number
  successRate: number
  avgLatencyMs: number
  totalInputTokens: number
  totalOutputTokens: number
}

interface ErrorEntry {
  id: number | string
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

function formatTokens(n?: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function Stat({ label, value, className }: { label: string; value: string | number; className?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-4 ">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <p className={`mt-2 text-2xl font-semibold tracking-[-0.04em] tabular-nums ${className ?? ''}`}>{value}</p>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel-card overflow-hidden rounded-2xl">
      <div className="border-b border-border bg-card px-5 py-4">
        <h3 className="text-sm font-semibold tracking-[-0.01em]">{title}</h3>
      </div>
      <div className="p-5">{children}</div>
    </div>
  )
}

const axisStyle = { fontSize: 11, fill: 'var(--muted-foreground)' } as const
const gridStyle = 'var(--border)'
const primaryFill = 'var(--foreground)'
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
    queryFn: () => apiFetch<AnalyticsSummary>(`/api/analytics/summary?range=${range}`),
  })

  const { data: byPlatform = [], isLoading: platformLoading, isError: platformError, error: platformQueryError } = useQuery({
    queryKey: ['analytics', 'by-platform', range],
    queryFn: () => apiFetch<PlatformStats[]>(`/api/analytics/by-platform?range=${range}`),
  })

  const { data: timeline = [], isLoading: timelineLoading, isError: timelineError, error: timelineQueryError } = useQuery({
    queryKey: ['analytics', 'timeline', range],
    queryFn: () => apiFetch<TimelinePoint[]>(`/api/analytics/timeline?range=${range}`),
  })

  const { data: byModel = [], isLoading: modelLoading, isError: modelError, error: modelQueryError } = useQuery({
    queryKey: ['analytics', 'by-model', range],
    queryFn: () => apiFetch<ModelStats[]>(`/api/analytics/by-model?range=${range}`),
  })

  const { data: errors = [], isLoading: errorsLoading, isError: errorsError, error: errorsQueryError } = useQuery({
    queryKey: ['analytics', 'errors', range],
    queryFn: () => apiFetch<ErrorEntry[]>(`/api/analytics/errors?range=${range}`),
  })

  const { data: errorDist, isLoading: errorDistLoading, isError: errorDistError, error: errorDistQueryError } = useQuery({
    queryKey: ['analytics', 'error-distribution', range],
    queryFn: () => apiFetch<ErrorDistribution>(`/api/analytics/error-distribution?range=${range}`),
  })

  const analyticsError = summaryError ? summaryQueryError : platformError ? platformQueryError : timelineError ? timelineQueryError : modelError ? modelQueryError : errorsError ? errorsQueryError : errorDistError ? errorDistQueryError : null

  return (
    <div>
      <PageHeader
        eyebrow="Observability"
        title="Analytics"
        description="Request volume, latency, token use, savings, and provider errors in one place."
        actions={
          <div className="flex gap-1 rounded-[var(--radius-input)] border border-border bg-card p-1 ">
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
        {analyticsError && (
          <ErrorState title="Some analytics could not load" description={analyticsError.message} action={<Button variant="outline" size="sm" onClick={() => refetchSummary()}>Retry summary</Button>} />
        )}

        {/* Summary stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Requests" value={summaryLoading ? '…' : summary?.totalRequests ?? 0} />
          <Stat label="Success rate" value={summaryLoading ? '…' : `${summary?.successRate ?? 0}%`} />
          <Stat label="Input tokens" value={summaryLoading ? '…' : formatTokens(summary?.totalInputTokens)} />
          <Stat label="Output tokens" value={summaryLoading ? '…' : formatTokens(summary?.totalOutputTokens)} />
          <Stat label="Avg latency" value={summaryLoading ? '…' : `${summary?.avgLatencyMs ?? 0} ms`} />
          <Stat label="Est. savings" value={summaryLoading ? '…' : `$${summary?.estimatedCostSavings ?? '0.00'}`} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Panel title="Requests by provider">
            {platformLoading ? (
              <LoadingState title="Loading provider requests" />
            ) : byPlatform.length === 0 ? (
              <EmptyState title="No requests in this range" description="Send traffic through Playground or the public API to populate provider analytics." />
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="requests" fill="var(--primary)" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title="Avg latency by provider">
            {platformLoading ? (
              <LoadingState title="Loading latency" />
            ) : byPlatform.length === 0 ? (
              <EmptyState title="No latency data yet" description="Latency appears after routed requests complete." />
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis unit="ms" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="avgLatencyMs" name="Latency (ms)" fill="var(--accent)" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <div className="lg:col-span-2">
            <Panel title="Requests over time">
              {timelineLoading ? (
                <LoadingState title="Loading timeline" />
              ) : timeline.length === 0 ? (
                <EmptyState title="No timeline data" description="Requests will appear here grouped by success and failure." />
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={timeline} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis dataKey="timestamp" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                    <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    <Line type="monotone" dataKey="successCount" name="Success" stroke={primaryFill} strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="failureCount" name="Failures" stroke="var(--destructive)" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>

          <div className="lg:col-span-2">
            <Panel title="Model breakdown">
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
                      {byModel.map((m, i) => (
                        <TableRow key={i}>
                          <TableCell className="pl-4 text-sm font-medium">{m.displayName}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{m.platform}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.requests}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.successRate}%</TableCell>
                          <TableCell className="text-right tabular-nums">{m.avgLatencyMs} ms</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(m.totalInputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums pr-4">{formatTokens(m.totalOutputTokens)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          <Panel title="Errors by provider">
            {errorDistLoading ? (
              <LoadingState title="Loading error distribution" />
            ) : !errorDist?.byPlatform?.length ? (
              <EmptyState title="No provider errors" description="Provider errors will appear here when upstream calls fail." />
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={errorDist.byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="count" fill="var(--destructive)" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title="Recent errors">
            {errorsLoading ? (
              <LoadingState title="Loading recent errors" />
            ) : errors.length === 0 ? (
              <EmptyState title="No recent errors" description="Failed upstream calls will appear here with their full message." />
            ) : (
              <div className="max-h-[240px] overflow-y-auto -mx-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Provider</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead className="text-right pr-4">Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {errors.slice(0, 20).map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="pl-4 text-xs">{e.platform}</TableCell>
                        <TableCell className="text-xs max-w-[200px] truncate" title={e.error}>{e.error}</TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground tabular-nums pr-4">
                          {new Date(e.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
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
  )
}
