import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type StatusTone = 'neutral' | 'positive' | 'warning' | 'critical' | 'info'

const dotClasses: Record<StatusTone, string> = {
  neutral: 'bg-muted-foreground/55',
  positive: 'bg-emerald-500',
  warning: 'bg-amber-500',
  critical: 'bg-destructive',
  info: 'bg-primary',
}

const labelClasses: Record<StatusTone, string> = {
  neutral: 'text-muted-foreground',
  positive: 'text-emerald-700 dark:text-emerald-400',
  warning: 'text-amber-700 dark:text-amber-400',
  critical: 'text-destructive',
  info: 'text-primary',
}

export function StatusIndicator({
  label,
  tone = 'neutral',
  className,
}: {
  label: string
  tone?: StatusTone
  className?: string
}) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs font-medium', labelClasses[tone], className)}>
      <span className={cn('size-1.5 shrink-0 rounded-full', dotClasses[tone])} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  )
}

export function InlineNotice({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode
  tone?: StatusTone
  className?: string
}) {
  const classes: Record<StatusTone, string> = {
    neutral: 'border-border bg-muted/40 text-muted-foreground',
    positive: 'border-emerald-500/25 bg-emerald-500/8 text-emerald-800 dark:text-emerald-300',
    warning: 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200',
    critical: 'border-destructive/30 bg-destructive/8 text-destructive',
    info: 'border-primary/25 bg-primary/8 text-foreground',
  }
  return (
    <div className={cn('rounded-[var(--radius-panel)] border px-3 py-2.5 text-sm leading-5', classes[tone], className)} role={tone === 'critical' ? 'alert' : tone === 'positive' ? 'status' : undefined}>
      {children}
    </div>
  )
}
