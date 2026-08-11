import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: string
  title: string
  description?: string
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('mb-6 flex min-w-0 max-w-full flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0 max-w-full sm:max-w-3xl">
        {eyebrow ? <p className="mb-1.5 text-xs font-medium text-muted-foreground">{eyebrow}</p> : null}
        <h1 className="break-words text-balance text-2xl font-semibold tracking-[-0.035em] text-foreground sm:text-[1.75rem]">{title}</h1>
        {description && (
          <p className="mt-2 max-w-full break-words text-sm leading-6 text-muted-foreground sm:max-w-2xl">{description}</p>
        )}
      </div>
      {actions ? <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">{actions}</div> : null}
    </div>
  )
}

export function SectionTitle({ id, title, description, action }: { id?: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h2 id={id} className="text-sm font-semibold tracking-[-0.01em]">{title}</h2>
        {description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="flex w-full min-w-0 flex-wrap gap-2 sm:w-auto sm:justify-end">{action}</div> : null}
    </div>
  )
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-panel)] border border-dashed border-border bg-muted/20 px-5 py-9 text-center">
      <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-[var(--radius-button)] bg-muted text-muted-foreground">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v18"/><path d="M5 10h14"/><path d="M5 19c4.5 2.2 9.5 2.2 14 0"/><path d="M6 10l-2 4"/><path d="M18 10l2 4"/></svg>
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {description ? <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  )
}

export function LoadingState({ title = 'Loading…', description }: { title?: string; description?: string }) {
  return (
    <div className="rounded-[var(--radius-panel)] border border-border bg-card px-5 py-8 text-center" role="status" aria-live="polite">
      <div className="mx-auto mb-3 flex size-10 items-center justify-center text-primary">
        <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {description ? <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">{description}</p> : null}
    </div>
  )
}

export function ErrorState({ title = 'Something went wrong', description, action }: { title?: string; description?: string; action?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-panel)] border border-destructive/30 bg-destructive/8 px-5 py-8 text-center text-destructive" role="alert">
      <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-[var(--radius-button)] bg-destructive/10">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {description ? <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-destructive/80">{description}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  )
}
