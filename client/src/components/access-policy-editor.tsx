import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink } from 'react-router-dom'
import { apiFetch } from '@/lib/api'
import { notify } from '@/lib/feedback'
import { invalidateRoutingQueries } from '@/lib/query-cache'
import type { PolicySnapshot } from '@/lib/contracts'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState, ErrorState, LoadingState, SectionTitle } from '@/components/page-header'
import { SearchField, Pagination } from '@/components/collection-controls'
import { SectionTabs } from '@/components/section-tabs'
import { ErrorNotice } from '@/components/error-notice'
import { StatusIndicator } from '@/components/status-indicator'

type PolicyPatch = Partial<{
  routes: Array<{ route: string; enabled: boolean }>
  platforms: Array<{ platform: string; enabled: boolean }>
  models: Array<{ modelDbId: number; enabled: boolean }>
}>

export function AccessPolicyEditor({
  clientId,
  legacyScope,
  endpointUnavailable = false,
}: {
  clientId: number
  legacyScope?: string[]
  endpointUnavailable?: boolean
}) {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'providers' | 'models'>('providers')
  const [search, setSearch] = useState('')
  const [provider, setProvider] = useState('all')
  const [page, setPage] = useState(1)
  const query = useQuery<PolicySnapshot>({
    queryKey: ['client-api-key-access-policy', clientId],
    queryFn: ({ signal }) => apiFetch(`/api/client-keys/${clientId}/access-policy`, { signal }),
  })
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: PolicyPatch }) =>
      apiFetch<PolicySnapshot>(`/api/client-keys/${id}/access-policy`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: (policy, variables) => {
      queryClient.setQueryData(['client-api-key-access-policy', variables.id], policy)
      notify(`Access policy saved for ${policy.key.label}.`)
      return invalidateRoutingQueries(queryClient)
    },
  })
  const policy = query.data
  const filteredModels = useMemo(
    () =>
      (policy?.models ?? []).filter(
        (model) =>
          (provider === 'all' || model.platform === provider) &&
          `${model.displayName} ${model.modelId}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [policy?.models, provider, search],
  )
  const filteredProviders = (policy?.platforms ?? []).filter((item) =>
    `${item.name} ${item.platform}`.toLowerCase().includes(search.toLowerCase()),
  )
  const total = tab === 'models' ? filteredModels.length : filteredProviders.length
  const activePage = Math.min(page, Math.max(1, Math.ceil(total / 15)))
  const visibleModels = filteredModels.slice((activePage - 1) * 15, activePage * 15)
  const visibleProviders = filteredProviders.slice((activePage - 1) * 15, activePage * 15)
  const blockedProviders = new Set(
    policy?.platforms
      .filter(
        (item) =>
          !item.enabled ||
          endpointUnavailable ||
          (legacyScope?.length && !legacyScope.includes(item.platform)),
      )
      .map((item) => item.platform),
  )
  function patch(value: PolicyPatch) {
    update.mutate({ id: clientId, patch: value })
  }
  if (query.isLoading) return <LoadingState title="Loading access policy" />
  if (query.isError)
    return (
      <ErrorState
        title="Access policy unavailable"
        description={query.error.message}
        action={
          <Button variant="outline" onClick={() => query.refetch()}>
            Retry
          </Button>
        }
      />
    )
  if (!policy) return null
  return (
    <section className="space-y-5" aria-label="Access policy">
      <div className="panel-card rounded-xl p-5">
        <SectionTitle
          title="API permissions"
          description="Changes save immediately and apply only to this client key."
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {policy.routes.map((route) => (
            <div
              key={route.id}
              className="flex items-center justify-between gap-4 rounded-lg border border-border p-3"
            >
              <div>
                <p className="text-sm font-medium">{route.name}</p>
                <code className="mt-1 block text-xs text-muted-foreground">
                  {route.method} {route.path}
                </code>
              </div>
              <Switch
                checked={route.enabled}
                disabled={update.isPending}
                onCheckedChange={(enabled) => patch({ routes: [{ route: route.id, enabled }] })}
                aria-label={`${route.enabled ? 'Block' : 'Allow'} route ${route.name}`}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="panel-card overflow-hidden rounded-xl">
        <div className="space-y-4 p-5 pb-4">
          <SectionTitle
            title="Provider & model access"
            description="A provider block overrides its model permissions. Newly added providers and models are allowed by default."
          />
          <SectionTabs
            label="Policy scope"
            value={tab}
            onChange={(value) => {
              setTab(value)
              setSearch('')
              setPage(1)
            }}
            items={[
              { value: 'providers', label: 'Providers', count: policy.platforms.length },
              { value: 'models', label: 'Models', count: policy.models.length },
            ]}
          />
          <div className="flex flex-wrap gap-2">
            <SearchField
              value={search}
              onChange={(value) => {
                setSearch(value)
                setPage(1)
              }}
              label={tab === 'models' ? 'Search model policies' : 'Search provider policies'}
              placeholder={tab === 'models' ? 'Search models by name or ID…' : 'Search providers…'}
            />
            {tab === 'models' ? (
              <Select
                value={provider}
                onValueChange={(value) => {
                  setProvider(value ?? 'all')
                  setPage(1)
                }}
              >
                <SelectTrigger aria-label="Filter policies by provider">
                  <SelectValue>
                    {provider === 'all'
                      ? 'All providers'
                      : (policy.platforms.find((item) => item.platform === provider)?.name ?? provider)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All providers</SelectItem>
                  {policy.platforms.map((item) => (
                    <SelectItem key={item.platform} value={item.platform}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              {total} matching {tab}
            </span>
            <div className="flex gap-2">
              {[true, false].map((enabled) => (
                <Button
                  key={String(enabled)}
                  size="xs"
                  variant="outline"
                  disabled={update.isPending || !total}
                  onClick={() =>
                    patch(
                      tab === 'models'
                        ? { models: visibleModels.map((model) => ({ modelDbId: model.modelDbId, enabled })) }
                        : {
                            platforms: visibleProviders.map((item) => ({ platform: item.platform, enabled })),
                          },
                    )
                  }
                >
                  {enabled ? 'Allow this page' : 'Block this page'}
                </Button>
              ))}
            </div>
          </div>
          <ErrorNotice error={update.error} />
        </div>
        {!total ? (
          <div className="p-5 pt-0">
            <EmptyState
              title="No matching policies"
              description="Try a different name or clear your filters."
              action={
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearch('')
                    setProvider('all')
                    setPage(1)
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">{tab === 'providers' ? 'Provider' : 'Model'}</TableHead>
                <TableHead>Effective access</TableHead>
                <TableHead className="pr-5 text-right">Rule</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tab === 'providers'
                ? visibleProviders.map((item) => (
                    <TableRow key={item.platform}>
                      <TableCell className="pl-5">
                        <p className="font-medium">{item.name}</p>
                        <code className="text-xs text-muted-foreground">{item.platform}</code>
                      </TableCell>
                      <TableCell>
                        <StatusIndicator
                          label={
                            blockedProviders.has(item.platform)
                              ? item.enabled
                                ? 'Endpoint restricted'
                                : 'Blocked'
                              : 'Allowed'
                          }
                          tone={blockedProviders.has(item.platform) ? 'neutral' : 'positive'}
                        />
                      </TableCell>
                      <TableCell className="pr-5 text-right">
                        <Switch
                          checked={item.enabled}
                          disabled={update.isPending}
                          onCheckedChange={(enabled) =>
                            patch({ platforms: [{ platform: item.platform, enabled }] })
                          }
                          aria-label={`${item.enabled ? 'Block' : 'Allow'} provider ${item.name}`}
                        />
                      </TableCell>
                    </TableRow>
                  ))
                : visibleModels.map((model) => (
                    <TableRow key={model.modelDbId}>
                      <TableCell className="max-w-[320px] pl-5">
                        <p className="truncate font-medium" title={model.displayName}>
                          {model.displayName}
                        </p>
                        <code
                          className="block truncate text-xs text-muted-foreground"
                          title={`${model.platform}/${model.modelId}`}
                        >
                          {model.platform}/{model.modelId}
                        </code>
                        {!model.catalogEnabled ? (
                          <span className="text-[11px] text-muted-foreground">Catalog disabled</span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <StatusIndicator
                          label={
                            blockedProviders.has(model.platform)
                              ? 'Provider blocked'
                              : model.enabled
                                ? 'Allowed'
                                : 'Blocked'
                          }
                          tone={
                            model.enabled && !blockedProviders.has(model.platform) ? 'positive' : 'neutral'
                          }
                        />
                      </TableCell>
                      <TableCell className="pr-5 text-right">
                        <Switch
                          checked={model.enabled}
                          disabled={update.isPending}
                          onCheckedChange={(enabled) =>
                            patch({ models: [{ modelDbId: model.modelDbId, enabled }] })
                          }
                          aria-label={`${model.enabled ? 'Block' : 'Allow'} model ${model.displayName}`}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
            </TableBody>
          </Table>
        )}
        <Pagination page={activePage} pageSize={15} total={total} onPageChange={setPage} />
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Permissions control access;{' '}
        <NavLink to="/fallback" className="text-primary underline underline-offset-2">
          Routing
        </NavLink>{' '}
        controls which configured models can serve requests.
      </p>
    </section>
  )
}
