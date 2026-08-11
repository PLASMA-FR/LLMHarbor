import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type MetricTone = 'default' | 'positive' | 'warning' | 'critical'

const toneClasses: Record<MetricTone, string> = {
  default: 'text-foreground',
  positive: 'text-emerald-700 dark:text-emerald-400',
  warning: 'text-amber-700 dark:text-amber-400',
  critical: 'text-destructive',
}

export function MetricCard({
  label,
  value,
  detail,
  tone = 'default',
  className,
}: {
  label: string
  value: ReactNode
  detail?: ReactNode
  tone?: MetricTone
  className?: string
}) {
  return (
    <div className={cn('panel-card min-w-0 rounded-[var(--radius-panel)] px-4 py-3.5', className)}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn('mt-1.5 truncate text-2xl font-semibold tracking-[-0.035em] tabular-nums', toneClasses[tone])}>{value}</p>
      {detail ? <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  )
}
