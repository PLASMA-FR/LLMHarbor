import { useQuery } from '@tanstack/react-query'
import { NavLink } from 'react-router-dom'
import { Check, ArrowRight } from 'lucide-react'
import type { ClientKey, ProviderSummary } from '@/lib/contracts'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export function SetupChecklist() {
  const providers = useQuery<ProviderSummary[]>({
    queryKey: ['custom-endpoints'],
    queryFn: ({ signal }) => apiFetch('/api/providers', { signal }),
  })
  const keys = useQuery<ClientKey[]>({
    queryKey: ['client-api-keys'],
    queryFn: ({ signal }) => apiFetch('/api/client-keys', { signal }),
  })
  const routes = useQuery<Array<{ eligible: boolean }>>({
    queryKey: ['fallback'],
    queryFn: ({ signal }) => apiFetch('/api/routing', { signal }),
  })
  if (!providers.data || !keys.data || !routes.data) return null
  const steps = [
    {
      title: 'Connect a provider',
      description: 'Add API credentials or a local endpoint.',
      done: providers.data.some((provider) => provider.enabled && provider.availableKeyCount > 0),
      to: '/providers?add=key',
    },
    {
      title: 'Enable a model',
      description: 'Test a model, then enable its route.',
      done: routes.data.some((route) => route.eligible),
      to: '/models',
    },
    {
      title: 'Create an app key',
      description: 'Save a named client key for your integration.',
      done: keys.data.some((key) => key.enabled && (key.label !== 'Default key' || key.lastUsedAt)),
      to: '/access?create=1',
    },
  ]
  const complete = steps.filter((step) => step.done).length
  if (complete === steps.length) return null
  const next = steps.find((step) => !step.done)!
  return (
    <section
      className="mb-6 overflow-hidden rounded-xl border border-primary/20 bg-card"
      aria-labelledby="setup-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 id="setup-title" className="text-sm font-semibold">
            Get your gateway ready
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {complete} of 3 steps complete. Your next step: {next.title.toLowerCase()}.
          </p>
        </div>
        <Button size="sm" render={<NavLink to={next.to} />}>
          {next.title}
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
      <ol className="grid divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
        {steps.map((step, index) => (
          <li key={step.title} className="flex gap-3 p-5">
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium',
                step.done ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
              )}
            >
              {step.done ? <Check className="size-4" aria-hidden="true" /> : index + 1}
            </span>
            <div>
              <NavLink
                to={step.to}
                className="text-sm font-medium underline-offset-4 hover:text-primary hover:underline"
              >
                {step.title}
              </NavLink>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {step.done ? 'Complete' : step.description}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
