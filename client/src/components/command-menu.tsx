import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { SearchField } from '@/components/collection-controls'
import { navItems } from '@/lib/navigation'

export function CommandMenu() {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const navigate = useNavigate()
  const items = navItems.filter((item) =>
    `${item.label} ${item.helper}`.toLowerCase().includes(search.toLowerCase()),
  )
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !event.isComposing) {
        event.preventDefault()
        if (!open && document.querySelector('[role="dialog"], [role="alertdialog"]')) return
        setOpen((value) => !value)
        setSearch('')
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [open])
  return (
    <>
      <Button
        variant="outline"
        className="gap-2 text-muted-foreground"
        size="sm"
        onClick={() => {
          setOpen(true)
          setSearch('')
        }}
        aria-label="Search dashboard"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Search aria-hidden="true" />
        <span className="hidden sm:inline">Find a page…</span>
        <kbd className="ml-6 hidden rounded border border-border px-1 font-mono text-[10px] md:inline">
          Ctrl K
        </kbd>
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Find your way around"
        description="Search pages. Use the arrow keys to move, Enter to open, or Escape to close."
      >
        <div
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-command]')]
            if (!buttons.length) return
            event.preventDefault()
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
          }}
        >
          <SearchField
            value={search}
            onChange={setSearch}
            label="Search pages"
            placeholder="Providers, client keys, API examples…"
          />
          <ul className="mt-3 max-h-[min(440px,60dvh)] space-y-1 overflow-auto">
            {items.map((item) => (
              <li key={item.to}>
                <button
                  type="button"
                  data-command
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    setOpen(false)
                    navigate(item.to)
                  }}
                >
                  <item.icon className="size-4 text-primary" aria-hidden="true" />
                  <span>
                    <span className="block text-sm font-medium">{item.label}</span>
                    <span className="block text-xs text-muted-foreground">{item.helper}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!items.length ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No matching pages. Try “keys”, “models” or “API”.
            </p>
          ) : null}
        </div>
      </Modal>
    </>
  )
}
