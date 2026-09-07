import type { ReactNode } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  sheet = false,
  busy = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  className?: string
  sheet?: boolean
  busy?: boolean
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value)
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Viewport
          className={cn(
            'fixed inset-0 z-50 flex overflow-y-auto p-4',
            sheet ? 'justify-start p-0' : 'items-start justify-center sm:items-center',
          )}
        >
          <Dialog.Popup
            className={cn(
              'relative my-auto w-full max-w-xl overflow-y-auto border border-border bg-popover p-6 text-popover-foreground shadow-xl outline-none',
              sheet ? 'my-0 max-w-80 rounded-none' : 'max-h-[calc(100dvh-2rem)] rounded-2xl',
              className,
            )}
          >
            <div className="mb-5 pr-8">
              <Dialog.Title className="text-lg font-semibold tracking-tight">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-1.5 text-sm leading-6 text-muted-foreground">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            {children}
            <Dialog.Close
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="absolute right-3 top-3"
                  disabled={busy}
                  aria-label={`Close ${title}`}
                />
              }
            >
              <X aria-hidden="true" />
            </Dialog.Close>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive = true,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onCancel()
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-[70] bg-black/45 backdrop-blur-[2px]" />
        <AlertDialog.Viewport className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto p-4">
          <AlertDialog.Popup className="w-full max-w-md rounded-2xl border border-border bg-popover p-6 text-popover-foreground shadow-xl outline-none">
            <AlertDialog.Title className="text-lg font-semibold tracking-tight">{title}</AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm leading-6 text-muted-foreground">
              {description}
            </AlertDialog.Description>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
