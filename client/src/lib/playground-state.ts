import { createContext, useCallback, useContext, type Dispatch, type SetStateAction } from 'react'
import type { ChatToolCall, TokenUsage } from '../../../shared/types'

export interface RouteMeta {
  requestId?: string
  clientKey?: string
  platform?: string
  model?: string
  latencyMs?: number
  firstTokenMs?: number
  fallbackAttempts?: number
  finishReason?: string | null
  usage?: TokenUsage
  usageEstimated?: boolean
}

export interface PlaygroundMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  refusal?: string
  kind?: 'normal' | 'error'
  toolCallId?: string
  toolCalls?: ChatToolCall[]
  meta?: RouteMeta
  streamError?: string
}

export function createPlaygroundDraft() {
  return {
    messages: [] as PlaygroundMessage[], input: '', selectedModel: 'auto',
    selectedClientKeyId: null as number | null, streaming: true,
    temperature: '', maxTokens: '', systemPrompt: '', toolsJson: '',
    toolChoice: 'auto' as 'auto' | 'none' | 'required', toolResults: {} as Record<string, string>,
  }
}

type PlaygroundDraft = ReturnType<typeof createPlaygroundDraft>
// Memory only: prompts and tool results survive navigation, and are cleared on
// reload. No provider/client secrets or conversation text enter browser storage.
export const PlaygroundContext = createContext<{
  draft: PlaygroundDraft
  setDraft: Dispatch<SetStateAction<PlaygroundDraft>>
} | null>(null)

export function usePlaygroundField<K extends keyof PlaygroundDraft>(field: K) {
  const context = useContext(PlaygroundContext)
  if (!context) throw new Error('Playground requires its draft provider.')
  const { draft, setDraft } = context
  const setValue = useCallback((value: SetStateAction<PlaygroundDraft[K]>) => {
    setDraft(current => ({
      ...current,
      [field]: typeof value === 'function'
        ? (value as (previous: PlaygroundDraft[K]) => PlaygroundDraft[K])(current[field])
        : value,
    }))
  }, [field, setDraft])
  return [draft[field], setValue] as const
}
