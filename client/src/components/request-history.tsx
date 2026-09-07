import { useDeferredValue, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useSearchParams, NavLink } from 'react-router-dom'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import type { ClientKey, PageResult, RequestRecord } from '@/lib/contracts'
import { apiFetch } from '@/lib/api'
import { formatCompactNumber, formatDateTime, formatDuration, formatRelativeTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SearchField } from '@/components/collection-controls'
import { EmptyState, LoadingState } from '@/components/page-header'
import { ErrorNotice } from '@/components/error-notice'
import { StatusIndicator, InlineNotice } from '@/components/status-indicator'
import { CodeBlock } from '@/components/code-block'

function Outcome({ status }: { status: RequestRecord['status'] }) {
  return (
    <StatusIndicator
      label={status === 'success' ? 'Success' : status === 'cancelled' ? 'Cancelled' : 'Failed'}
      tone={status === 'success' ? 'positive' : status === 'cancelled' ? 'neutral' : 'critical'}
    />
  )
}

export function RequestHistory() {
  const [params, setParams] = useSearchParams()
  const search = params.get('q') ?? ''
  const deferredSearch = useDeferredValue(search)
  const status = params.get('status') ?? 'all'
  const client = params.get('client') ?? 'all'
  const [cursors, setCursors] = useState<string[]>([''])
  const [selected, setSelected] = useState<number | null>(null)
  const keys = useQuery<ClientKey[]>({
    queryKey: ['client-api-keys'],
    queryFn: ({ signal }) => apiFetch('/api/client-keys', { signal }),
  })
  const query = new URLSearchParams({ limit: '25' })
  if (cursors.at(-1)) query.set('cursor', cursors.at(-1)!)
  if (deferredSearch) query.set('q', deferredSearch)
  if (status !== 'all') query.set('status', status)
  if (client !== 'all') query.set('clientKeyId', client)
  const history = useQuery<PageResult<RequestRecord>>({
    queryKey: ['request-history', query.toString()],
    queryFn: ({ signal }) => apiFetch('/api/requests?' + query, { signal }),
    placeholderData: keepPreviousData,
  })
  const trace = useQuery<{ request: RequestRecord; attempts: RequestRecord[]; completeTrace: boolean }>({
    queryKey: ['request-detail', selected],
    queryFn: ({ signal }) => apiFetch(`/api/requests/${selected}`, { signal }),
    enabled: selected !== null,
  })
  function filter(name: string, value: string) {
    setCursors([''])
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (value && value !== 'all') next.set(name, value)
        else next.delete(name)
        next.set('view', 'requests')
        return next
      },
      { replace: true },
    )
  }
  return (
    <div className="space-y-4">
      <div className="panel-card overflow-hidden rounded-xl">
        <div className="flex flex-wrap gap-3 p-5">
          <SearchField
            value={search}
            onChange={(value) => filter('q', value)}
            label="Search request history"
            placeholder="Request ID, trace ID or model…"
          />
          <Select value={status} onValueChange={(value) => filter('status', value ?? 'all')}>
            <SelectTrigger aria-label="Filter requests by outcome">
              <SelectValue>
                {status === 'all'
                  ? 'All outcomes'
                  : status === 'error'
                    ? 'Failed'
                    : status === 'success'
                      ? 'Success'
                      : 'Cancelled'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All outcomes</SelectItem>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="error">Failed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
          <Select value={client} onValueChange={(value) => filter('client', value ?? 'all')}>
            <SelectTrigger aria-label="Filter requests by client key">
              <SelectValue>
                {client === 'all'
                  ? 'All client keys'
                  : (keys.data?.find((key) => String(key.id) === client)?.label ?? 'Client key')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All client keys</SelectItem>
              {keys.data?.map((key) => (
                <SelectItem key={key.id} value={String(key.id)}>
                  {key.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            aria-label="Refresh request history"
            disabled={history.isFetching}
            onClick={() => history.refetch()}
          >
            <RefreshCw className={history.isFetching ? 'animate-spin' : ''} aria-hidden="true" />
          </Button>
        </div>
        <div className="px-5">
          <ErrorNotice error={history.error ?? keys.error} />
        </div>
        {history.isLoading ? (
          <LoadingState title="Loading request history" />
        ) : !history.data?.data.length ? (
          <div className="p-5 pt-0">
            <EmptyState
              title={
                search || status !== 'all' || client !== 'all' ? 'No matching requests' : 'No requests yet'
              }
              description="Routed requests appear here after completion. Prompts and responses are not stored."
              action={
                <Button variant="outline" render={<NavLink to="/playground" />}>
                  Send a test request
                </Button>
              }
            />
          </div>
        ) : (
          <div aria-busy={history.isFetching}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Outcome</TableHead>
                  <TableHead>Model / provider</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="pr-5">
                    <span className="sr-only">Trace</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.data.data.map((request) => (
                  <TableRow key={request.id}>
                    <TableCell className="pl-5">
                      <Outcome status={request.status} />
                    </TableCell>
                    <TableCell className="max-w-[240px]">
                      <p className="truncate text-sm font-medium" title={request.displayName}>
                        {request.displayName}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{request.platform}</p>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {request.clientKeyLabel ??
                        (request.clientKeyId ? `Key #${request.clientKeyId}` : 'Legacy request')}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatDuration(request.latencyMs)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatCompactNumber(request.inputTokens + request.outputTokens)}
                    </TableCell>
                    <TableCell
                      className="text-xs text-muted-foreground"
                      title={formatDateTime(request.createdAt)}
                    >
                      {formatRelativeTime(request.createdAt)}
                    </TableCell>
                    <TableCell className="pr-5">
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => setSelected(request.id)}
                        aria-label={`Inspect request ${request.id}`}
                      >
                        Inspect
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <nav
          className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3"
          aria-label="Request history pagination"
        >
          <span className="text-xs text-muted-foreground" role="status">
            Page {cursors.length} · {history.data?.data.length ?? 0} requests
            {history.isFetching ? ' · Updating…' : ''}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={cursors.length === 1 || history.isFetching}
              onClick={() => setCursors((values) => values.slice(0, -1))}
            >
              <ChevronLeft aria-hidden="true" />
              Newer
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!history.data?.pagination.hasMore || history.isFetching}
              onClick={() => {
                const cursor = history.data?.pagination.nextCursor
                if (cursor) setCursors((values) => [...values, cursor])
              }}
            >
              Older
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </nav>
      </div>
      <Modal
        open={selected !== null}
        onOpenChange={(value) => {
          if (!value) setSelected(null)
        }}
        title="Request trace"
        description="Inspect the final result and the provider attempts that led to it."
        className="max-w-3xl"
      >
        {trace.isLoading ? (
          <LoadingState title="Loading trace" />
        ) : trace.isError ? (
          <ErrorNotice error={trace.error} />
        ) : trace.data ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Outcome status={trace.data.request.status} />
              <span className="text-xs text-muted-foreground">
                {formatDateTime(trace.data.request.createdAt)} ·{' '}
                {formatDuration(trace.data.request.latencyMs)}
              </span>
            </div>
            <CodeBlock code={trace.data.request.requestId ?? `Request #${selected}`} label="Request ID" />
            {!trace.data.completeTrace ? (
              <InlineNotice>
                Detailed traces are available for new requests. This older record contains only its final
                outcome.
              </InlineNotice>
            ) : null}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trace.data.attempts.map((attempt) => (
                  <TableRow key={attempt.id}>
                    <TableCell className="text-xs">
                      {attempt.isFinal ? 'Final result' : `Attempt ${attempt.attempt}`}
                    </TableCell>
                    <TableCell className="max-w-[220px] break-words font-mono text-[11px]">
                      {attempt.platform}/{attempt.modelId}
                    </TableCell>
                    <TableCell>
                      <Outcome status={attempt.status} />
                    </TableCell>
                    <TableCell className="max-w-xs text-xs leading-5 text-muted-foreground">
                      {attempt.error ?? `${attempt.inputTokens + attempt.outputTokens} tokens`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
