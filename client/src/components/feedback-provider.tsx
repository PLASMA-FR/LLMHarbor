import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { CheckCircle2, CircleAlert, X } from 'lucide-react'
import { ConfirmationContext, type Confirmation, type Notification } from '@/lib/feedback'
import { ConfirmationDialog } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'

function Toast({ item, dismiss }: { item: Notification & { id: number }; dismiss: (id: number) => void }) {
  useEffect(() => {
    if (item.tone === 'error') return
    const timer = window.setTimeout(() => dismiss(item.id), 5000)
    return () => window.clearTimeout(timer)
  }, [item.id, item.tone, dismiss])
  return (
    <div
      role={item.tone === 'error' ? 'alert' : 'status'}
      className="flex items-start gap-3 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg"
    >
      {item.tone === 'error' ? (
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      ) : (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1 text-sm">
        <p className="break-words leading-5">{item.message}</p>
        {item.requestId ? (
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">Request {item.requestId}</p>
        ) : null}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => dismiss(item.id)}
        aria-label="Dismiss notification"
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  )
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const resolver = useRef<((accepted: boolean) => void) | null>(null)
  const [notifications, setNotifications] = useState<Array<Notification & { id: number }>>([])
  const nextId = useRef(1)
  const dismiss = useCallback(
    (id: number) => setNotifications((items) => items.filter((item) => item.id !== id)),
    [],
  )
  const confirm = useCallback(
    (options: Confirmation) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false)
        resolver.current = resolve
        setConfirmation(options)
      }),
    [],
  )
  const settle = (accepted: boolean) => {
    resolver.current?.(accepted)
    resolver.current = null
    setConfirmation(null)
  }
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<Notification>).detail
      setNotifications((items) => [...items.slice(-2), { ...detail, id: nextId.current++ }])
    }
    window.addEventListener('llmharbor:notification', listener)
    return () => {
      window.removeEventListener('llmharbor:notification', listener)
      resolver.current?.(false)
    }
  }, [])
  return (
    <ConfirmationContext value={confirm}>
      {children}
      {confirmation ? (
        <ConfirmationDialog
          open
          {...confirmation}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      ) : null}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[90] flex w-[min(400px,calc(100vw-2rem))] flex-col gap-2 [&>*]:pointer-events-auto"
        role="group"
        aria-label="Notifications"
        aria-hidden={!notifications.length}
      >
        {notifications.map((item) => (
          <Toast key={item.id} item={item} dismiss={dismiss} />
        ))}
      </div>
    </ConfirmationContext>
  )
}
