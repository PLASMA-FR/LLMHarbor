import { Search, X, ChevronLeft, ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

export function SearchField({
  value,
  onChange,
  label = 'Search',
  placeholder = 'Search…',
  id,
}: {
  value: string
  onChange: (value: string) => void
  label?: string
  placeholder?: string
  id?: string
}) {
  return (
    <div className="relative min-w-[min(100%,220px)] flex-1">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        id={id}
        type="search"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="pl-9 pr-10 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute right-2 top-1/2 -translate-y-1/2"
          onClick={() => onChange('')}
          aria-label={`Clear ${label.toLowerCase()}`}
        >
          <X aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  )
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(page, pages)
  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3"
    >
      <p className="text-xs tabular-nums text-muted-foreground" role="status">
        {total
          ? `${(current - 1) * pageSize + 1}–${Math.min(total, current * pageSize)} of ${total}`
          : '0 results'}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon-sm"
          disabled={current === 1}
          onClick={() => onPageChange(current - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <span className="text-xs tabular-nums text-muted-foreground">
          {current} / {pages}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          disabled={current >= pages}
          onClick={() => onPageChange(current + 1)}
          aria-label="Next page"
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </nav>
  )
}
