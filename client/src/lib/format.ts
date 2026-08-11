const compactNumber = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
})

const integerNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

export function formatCompactNumber(value: number) {
  return compactNumber.format(Number.isFinite(value) ? value : 0)
}

export function formatInteger(value: number) {
  return integerNumber.format(Number.isFinite(value) ? value : 0)
}

export function formatPercent(value: number, fractionDigits = 1) {
  const safeValue = Number.isFinite(value) ? value : 0
  return `${safeValue.toFixed(fractionDigits).replace(/\.0$/, '')}%`
}

export function formatDuration(milliseconds: number) {
  if (!Number.isFinite(milliseconds)) return '—'
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))} ms`
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

export function formatRelativeTime(value: string | null | undefined) {
  if (!value) return 'Never'
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return 'Unknown'

  const seconds = Math.round((timestamp - Date.now()) / 1_000)
  const absoluteSeconds = Math.abs(seconds)
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (absoluteSeconds < 60) return relative.format(seconds, 'second')
  if (absoluteSeconds < 3_600) return relative.format(Math.round(seconds / 60), 'minute')
  if (absoluteSeconds < 86_400) return relative.format(Math.round(seconds / 3_600), 'hour')
  if (absoluteSeconds < 2_592_000) return relative.format(Math.round(seconds / 86_400), 'day')
  return formatDateTime(value)
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${Math.round(value)} B`
}
