import { createContext, useContext } from 'react'

export interface Confirmation {
  title: string
  description: string
  confirmLabel?: string
  destructive?: boolean
}
export const ConfirmationContext = createContext<((options: Confirmation) => Promise<boolean>) | null>(null)
export function useConfirm() {
  const confirm = useContext(ConfirmationContext)
  if (!confirm) throw new Error('Confirmation provider is missing.')
  return confirm
}
export interface Notification {
  message: string
  tone?: 'success' | 'error'
  requestId?: string
}
export function notify(message: string, tone: Notification['tone'] = 'success', requestId?: string) {
  window.dispatchEvent(
    new CustomEvent<Notification>('llmharbor:notification', { detail: { message, tone, requestId } }),
  )
}
