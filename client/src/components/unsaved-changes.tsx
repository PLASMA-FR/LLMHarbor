import { useEffect } from 'react'
import { useBlocker } from 'react-router-dom'
import { ConfirmationDialog } from '@/components/ui/modal'

export function UnsavedChanges({ active }: { active: boolean }) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => active && currentLocation.pathname !== nextLocation.pathname,
  )
  useEffect(() => {
    if (!active) return
    const listener = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', listener)
    return () => window.removeEventListener('beforeunload', listener)
  }, [active])
  return (
    <ConfirmationDialog
      open={blocker.state === 'blocked'}
      title="Discard routing changes?"
      description="Your unsaved order and toggles will be lost. Save the routing changes before leaving to apply them."
      confirmLabel="Discard & leave"
      onCancel={() => {
        if (blocker.state === 'blocked') blocker.reset()
      }}
      onConfirm={() => {
        if (blocker.state === 'blocked') blocker.proceed()
      }}
    />
  )
}
