import { Button } from '@/components/ui/button'

export function SectionTabs<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T
  onChange: (value: T) => void
  items: Array<{ value: T; label: string; count?: number }>
  label: string
}) {
  return (
    <nav aria-label={label} className="flex gap-1 overflow-x-auto border-b border-border pb-2">
      {items.map((item) => (
        <Button
          key={item.value}
          variant={value === item.value ? 'secondary' : 'ghost'}
          size="sm"
          aria-current={value === item.value ? 'page' : undefined}
          onClick={() => onChange(item.value)}
        >
          {item.label}
          {item.count !== undefined ? (
            <span className="ml-1 rounded bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {item.count}
            </span>
          ) : null}
        </Button>
      ))}
    </nav>
  )
}
