import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, Braces, CircleStop, Copy, Download, RotateCcw, Send, Trash2 } from 'lucide-react'
import { apiFetch, apiUrl } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { usePlaygroundField, type PlaygroundMessage, type RouteMeta } from '@/lib/playground-state'
import { formatCompactNumber, formatDuration } from '@/lib/format'
import { extractSseFrames, readSseData } from '@/lib/sse'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { PageHeader, EmptyState, ErrorState, LoadingState, SectionTitle } from '@/components/page-header'
import { InlineNotice, StatusIndicator } from '@/components/status-indicator'
import { cn } from '@/lib/utils'
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatContent,
  ChatMessage,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
  TokenUsage,
} from '../../../shared/types'

interface FallbackEntry {
  modelDbId: number
  priority: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  sizeLabel: string
  keyCount: number
  configuredKeyCount: number
  enabledKeyCount: number
  routeableKeyCount: number
  availableKeyCount: number
  modelEnabled: boolean
  eligible: boolean
  skipReason: string | null
}

interface ClientKeySummary {
  id: number
  label: string
  maskedKey: string
  enabled: boolean
  limits: {
    rpm: number | null
    rpd: number | null
    tpm: number | null
    tpd: number | null
  }
}

interface PlaygroundAccessPolicy {
  routes: Array<{ id: string; enabled: boolean }>
  platforms: Array<{ platform: string; enabled: boolean }>
  models: Array<{ modelDbId: number; enabled: boolean }>
}

interface StreamToolCallDelta {
  index?: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
  thought_signature?: string
}

interface StreamFrame {
  choices?: Array<{
    delta?: { content?: string; refusal?: string; tool_calls?: StreamToolCallDelta[] }
    finish_reason?: string | null
  }>
  usage?: TokenUsage
  error?: { message?: string }
}

function createMessageId() {
  return globalThis.crypto?.randomUUID?.() ?? `message-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function localModelId(model: Pick<FallbackEntry, 'platform' | 'modelId'>) {
  return `${model.platform}/${model.modelId}`
}

function contentToText(content: ChatContent) {
  if (typeof content === 'string') return content
  if (content === null) return ''
  return content.map(block => typeof block.text === 'string' ? block.text : JSON.stringify(block)).join('\n')
}

function parseRouteHeader(value: string | null) {
  if (!value) return {}
  const separator = value.indexOf('/')
  if (separator < 0) return { model: value }
  return { platform: value.slice(0, separator), model: value.slice(separator + 1) }
}

function parseOptionalNumber(value: string, label: string, min: number, max: number) {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`)
  }
  return parsed
}

function parseTools(value: string): ChatToolDefinition[] | undefined {
  if (!value.trim()) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Tools must be valid JSON.')
  }
  if (!Array.isArray(parsed) || parsed.some(tool => (
    typeof tool !== 'object' || tool === null
    || (tool as { type?: unknown }).type !== 'function'
    || typeof (tool as { function?: { name?: unknown } }).function?.name !== 'string'
  ))) {
    throw new Error('Tools must be an array of OpenAI function definitions.')
  }
  return parsed as ChatToolDefinition[]
}

async function responseError(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null
  return payload?.error?.message ?? `Request failed with HTTP ${response.status}.`
}

function toApiMessages(messages: PlaygroundMessage[], systemPrompt: string): ChatMessage[] {
  const apiMessages: ChatMessage[] = []
  if (systemPrompt.trim()) apiMessages.push({ role: 'system', content: systemPrompt.trim() })

  for (const message of messages) {
    if (message.kind === 'error') continue
    if (message.role === 'tool') {
      if (message.toolCallId) apiMessages.push({ role: 'tool', content: message.content, tool_call_id: message.toolCallId })
      continue
    }
    if (message.role === 'assistant') {
      apiMessages.push({
        role: 'assistant',
        content: message.content || null,
        ...(message.refusal ? { refusal: message.refusal } : {}),
        ...(!message.streamError && message.toolCalls?.length ? { tool_calls: message.toolCalls } : {}),
      })
      continue
    }
    apiMessages.push({ role: 'user', content: message.content })
  }
  return apiMessages
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
      <dd title={value} className="mt-0.5 truncate text-xs font-medium tabular-nums select-all">{value}</dd>
    </div>
  )
}

function ToolCallCard({
  call,
  result,
  onResultChange,
  onAddResult,
  alreadyAnswered,
  disabled,
}: {
  call: ChatToolCall
  result: string
  onResultChange: (value: string) => void
  onAddResult: () => void
  alreadyAnswered: boolean
  disabled: boolean
}) {
  return (
    <div className="mt-3 rounded-[var(--radius-panel)] border border-border bg-card p-3 text-foreground">
      <div className="flex items-center gap-2">
        <Braces className="size-3.5 text-primary" aria-hidden="true" />
        <span className="text-xs font-semibold">{call.function.name || 'Unnamed function'}</span>
        <Badge variant="outline">tool call</Badge>
      </div>
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-button)] bg-muted/60 p-2 font-mono text-[11px] leading-5 text-muted-foreground">{call.function.arguments || '{}'}</pre>
      {alreadyAnswered ? (
        <StatusIndicator className="mt-2" label="Tool result added to the thread" tone="positive" />
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div>
            <Label htmlFor={`tool-result-${call.id}`} className="mb-1.5 text-xs">Tool result</Label>
            <Textarea
              id={`tool-result-${call.id}`}
              disabled={disabled}
              value={result}
              onChange={event => onResultChange(event.target.value)}
              placeholder='{"status":"ok"}'
              className="min-h-16 font-mono text-xs"
            />
          </div>
          <Button type="button" variant="outline" size="sm" disabled={disabled || !result.trim()} onClick={onAddResult}>Add result</Button>
        </div>
      )}
    </div>
  )
}

export default function PlaygroundPage() {
  const [messages, setMessages] = usePlaygroundField('messages')
  const [input, setInput] = usePlaygroundField('input')
  const [loading, setLoading] = useState(false)
  const [selectedModel, setSelectedModel] = usePlaygroundField('selectedModel')
  const [selectedClientKeyId, setSelectedClientKeyId] = usePlaygroundField('selectedClientKeyId')
  const [streaming, setStreaming] = usePlaygroundField('streaming')
  const [temperature, setTemperature] = usePlaygroundField('temperature')
  const [maxTokens, setMaxTokens] = usePlaygroundField('maxTokens')
  const [systemPrompt, setSystemPrompt] = usePlaygroundField('systemPrompt')
  const [toolsJson, setToolsJson] = usePlaygroundField('toolsJson')
  const [toolChoice, setToolChoice] = usePlaygroundField('toolChoice')
  const [formError, setFormError] = useState<string | null>(null)
  const [toolResults, setToolResults] = usePlaygroundField('toolResults')
  const scrollRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const { data: clientKeys = [], isLoading: keyLoading, isError: keyError, error: keyQueryError } = useQuery<ClientKeySummary[]>({
    queryKey: ['client-api-keys'],
    queryFn: ({ signal }) => apiFetch('/api/settings/api-keys', { signal }),
  })

  const { data: fallbackEntries = [], isLoading: routesLoading, isError: routesError, error: routesQueryError } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: ({ signal }) => apiFetch('/api/fallback', { signal }),
  })

  const configuredModels = useMemo(
    () => fallbackEntries.filter(entry => entry.configuredKeyCount > 0 && entry.enabled && entry.modelEnabled),
    [fallbackEntries],
  )
  const enabledClientKeys = useMemo(() => clientKeys.filter(key => key.enabled), [clientKeys])
  const selectedClientKey = enabledClientKeys.find(key => key.id === selectedClientKeyId) ?? enabledClientKeys[0]

  const policyQuery = useQuery<PlaygroundAccessPolicy>({
    queryKey: ['client-api-key-access-policy', selectedClientKey?.id],
    queryFn: ({ signal }) => apiFetch(`/api/settings/api-keys/${selectedClientKey!.id}/access-policy`, { signal }),
    enabled: Boolean(selectedClientKey),
  })
  const chatRouteAllowed = policyQuery.data?.routes.find(route => route.id === 'v1.chat.completions')?.enabled ?? false
  const blockedPlatforms = useMemo(
    () => new Set(policyQuery.data?.platforms.filter(platform => !platform.enabled).map(platform => platform.platform) ?? []),
    [policyQuery.data?.platforms],
  )
  const blockedModels = useMemo(
    () => new Set(policyQuery.data?.models.filter(model => !model.enabled).map(model => model.modelDbId) ?? []),
    [policyQuery.data?.models],
  )
  const policyAllowedModels = useMemo(
    () => configuredModels.filter(entry => (
      Boolean(policyQuery.data)
      && !blockedPlatforms.has(entry.platform)
      && !blockedModels.has(entry.modelDbId)
    )),
    [blockedModels, blockedPlatforms, configuredModels, policyQuery.data],
  )
  const availableModels = useMemo(
    () => policyAllowedModels.filter(entry => entry.eligible),
    [policyAllowedModels],
  )

  function modelAllowedBySelectedKey(entry: FallbackEntry) {
    return Boolean(policyQuery.data)
      && !blockedPlatforms.has(entry.platform)
      && !blockedModels.has(entry.modelDbId)
  }

  useEffect(() => {
    const container = scrollRef.current
    if (following && container) container.scrollTop = container.scrollHeight
  }, [messages, loading, following])

  useEffect(() => () => abortRef.current?.abort(), [])

  const activeModelLabel = selectedModel === 'auto'
    ? 'Auto routing'
    : configuredModels.find(model => localModelId(model) === selectedModel)?.displayName ?? selectedModel
  const lastMeta = messages.toReversed().find(message => message.meta)?.meta
  const selectedModelReady = selectedModel === 'auto'
    ? chatRouteAllowed && availableModels.length > 0
    : chatRouteAllowed && availableModels.some(model => localModelId(model) === selectedModel)
  const hasEnabledClientKey = Boolean(selectedClientKey)
  const latestToolCalls = messages.toReversed().find(message => message.role === 'assistant' && !message.streamError && message.toolCalls?.length)?.toolCalls ?? []
  const answeredToolCallIds = new Set(messages.filter(message => message.role === 'tool' && message.toolCallId).map(message => message.toolCallId))
  const unresolvedToolCalls = latestToolCalls.filter(call => !answeredToolCallIds.has(call.id))
  const canContinueToolCall = latestToolCalls.length > 0 && unresolvedToolCalls.length === 0 && messages.at(-1)?.role === 'tool'
  const policyLoading = Boolean(selectedClientKey) && policyQuery.isLoading
  const selectedEntry = configuredModels.find(model => localModelId(model) === selectedModel)
  const selectedPolicyBlocked = selectedEntry ? !modelAllowedBySelectedKey(selectedEntry) : false
  const canSend = (Boolean(input.trim()) || canContinueToolCall)
    && !loading
    && hasEnabledClientKey
    && unresolvedToolCalls.length === 0
    && chatRouteAllowed
    && availableModels.length > 0
    && selectedModelReady
  const setupMessage = keyLoading || routesLoading || policyLoading
    ? 'Checking local credentials and enabled routes…'
    : keyError
      ? `Could not load a client credential: ${keyQueryError.message}`
      : routesError
        ? `Could not load routing order: ${routesQueryError.message}`
        : policyQuery.isError
          ? `Could not load the selected client key policy: ${policyQuery.error.message}`
        : !hasEnabledClientKey
          ? 'Create an enabled client key before sending requests.'
          : !chatRouteAllowed
            ? `The ${selectedClientKey?.label ?? 'selected'} client key blocks the chat completions route.`
          : availableModels.length === 0
            ? policyAllowedModels.length === 0 && configuredModels.length > 0
              ? `The ${selectedClientKey?.label ?? 'selected'} client key blocks every configured provider or model route.`
              : 'Add provider credentials and enable at least one routed model.'
            : !selectedModelReady
              ? selectedModel === 'auto'
                ? 'No configured route is currently eligible for automatic routing.'
                : selectedPolicyBlocked
                  ? `The ${selectedClientKey?.label ?? 'selected'} client key blocks the selected provider or model.`
                  : selectedEntry?.skipReason ?? 'The selected model is not currently eligible.'
              : `Ready to send through ${activeModelLabel} as ${selectedClientKey?.label}.`
  const latestMessage = messages.at(-1)
  const conversationAnnouncement = loading
    ? (streaming ? 'Assistant response streaming.' : 'Request in progress.')
    : latestMessage?.streamError
      ? `Response ended: ${latestMessage.streamError}`
      : latestMessage?.role === 'assistant'
        ? 'Assistant response complete.'
        : ''

  function replaceMessage(id: string, updater: (message: PlaygroundMessage) => PlaygroundMessage) {
    setMessages(current => current.map(message => message.id === id ? updater(message) : message))
  }

  function stopRequest() {
    abortRef.current?.abort()
  }

  function addToolResult(call: ChatToolCall) {
    const result = toolResults[call.id]?.trim()
    if (!result) return
    setMessages(current => [...current, {
      id: createMessageId(),
      role: 'tool',
      content: result,
      toolCallId: call.id,
    }])
    setToolResults(current => {
      const next = { ...current }
      delete next[call.id]
      return next
    })
    inputRef.current?.focus()
  }

  async function handleSend(retryLast = false) {
    const text = retryLast ? '' : input.trim()
    if ((!text && !canContinueToolCall && !retryLast) || loading) return
    if (!selectedClientKey) {
      setFormError('Select an enabled local client key before sending a request.')
      return
    }
    if (unresolvedToolCalls.length > 0) {
      setFormError(`Add results for all ${unresolvedToolCalls.length} pending tool call${unresolvedToolCalls.length === 1 ? '' : 's'} before sending another message.`)
      return
    }
    if (!chatRouteAllowed || availableModels.length === 0 || !selectedModelReady) {
      setFormError(setupMessage)
      return
    }

    let requestTemperature: number | undefined
    let requestMaxTokens: number | undefined
    let requestTools: ChatToolDefinition[] | undefined
    try {
      requestTemperature = parseOptionalNumber(temperature, 'Temperature', 0, 2)
      requestMaxTokens = parseOptionalNumber(maxTokens, 'Max tokens', 1, 1_000_000)
      if (requestMaxTokens !== undefined && !Number.isInteger(requestMaxTokens)) throw new Error('Max tokens must be a whole number.')
      requestTools = parseTools(toolsJson)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Check the request options.')
      return
    }

    const userMessage: PlaygroundMessage | null = text ? { id: createMessageId(), role: 'user', content: text } : null
    const requestMessages = retryLast ? messages.slice(0, -1) : userMessage ? [...messages, userMessage] : messages
    const assistantId = createMessageId()
    const controller = new AbortController()
    abortRef.current = controller
    setMessages(requestMessages)
    if (!retryLast) setInput('')
    setFollowing(true)
    setFormError(null)
    setLoading(true)
    if (inputRef.current) inputRef.current.style.height = 'auto'

    const body: ChatCompletionRequest = {
      model: selectedModel,
      messages: toApiMessages(requestMessages, systemPrompt),
      stream: streaming,
      ...(streaming ? { stream_options: { include_usage: true } } : {}),
      ...(requestTemperature !== undefined ? { temperature: requestTemperature } : {}),
      ...(requestMaxTokens !== undefined ? { max_tokens: requestMaxTokens } : {}),
      ...(requestTools?.length ? { tools: requestTools, tool_choice: toolChoice as ChatToolChoice } : {}),
    }

    const startedAt = performance.now()
    let response: Response | undefined
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let cancelScheduledSync: (() => void) | undefined
    let flushScheduledSync: (() => void) | undefined
    let streamingMessageStarted = false
    try {
      response = await fetch(apiUrl('/api/playground/v1/chat/completions'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Accept': streaming ? 'text/event-stream' : 'application/json',
          'Content-Type': 'application/json',
          'X-LLMHarbor-Client-Key-Id': String(selectedClientKey.id),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) throw new Error(await responseError(response))

      const route = parseRouteHeader(response.headers.get('X-Routed-Via'))
      const fallbackHeader = Number.parseInt(response.headers.get('X-Fallback-Attempts') ?? '', 10)
      const responseClientKeyId = Number(response.headers.get('X-LLMHarbor-Client-Key-Id'))
      const responseClientKey = clientKeys.find(key => key.id === responseClientKeyId) ?? selectedClientKey
      const baseMeta: RouteMeta = {
        ...route,
        requestId: response.headers.get('X-Request-Id') ?? undefined,
        clientKey: responseClientKey.label,
        fallbackAttempts: Number.isNaN(fallbackHeader) ? undefined : fallbackHeader,
      }

      if (!streaming) {
        const data = await response.json() as ChatCompletionResponse
        const choice = data.choices?.[0]
        const routedVia = data._routed_via ?? route
        setMessages(current => [...current, {
          id: assistantId,
          role: 'assistant',
          content: contentToText(choice?.message?.content ?? ''),
          refusal: choice?.message?.refusal,
          toolCalls: choice?.message?.tool_calls,
          meta: {
            ...baseMeta,
            platform: routedVia.platform,
            model: routedVia.model,
            latencyMs: performance.now() - startedAt,
            finishReason: choice?.finish_reason,
            usage: data.usage,
          },
        }])
        return
      }

      if (!response.body) throw new Error('The server returned an empty stream.')
      setMessages(current => [...current, { id: assistantId, role: 'assistant', content: '', meta: baseMeta }])
      streamingMessageStarted = true

      activeReader = response.body.getReader()
      const decoder = new TextDecoder()
      const toolCalls = new Map<number, ChatToolCall>()
      let buffer = ''
      let content = ''
      let refusal = ''
      let firstTokenMs: number | undefined
      let finishReason: string | null | undefined
      let usage: TokenUsage | undefined
      let usageEstimated = false
      let streamError: string | undefined
      let sawDone = false
      let sawChoice = false

      let syncTimer: number | null = null
      const syncMessageNow = () => {
        replaceMessage(assistantId, message => ({
          ...message,
          content,
          refusal: refusal || undefined,
          toolCalls: toolCalls.size > 0 ? [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) : undefined,
          streamError,
          meta: {
            ...baseMeta,
            firstTokenMs,
            finishReason,
            usage,
            usageEstimated,
            latencyMs: performance.now() - startedAt,
          },
        }))
      }
      const flushSync = () => {
        if (syncTimer !== null) window.clearTimeout(syncTimer)
        syncTimer = null
        syncMessageNow()
      }
      const scheduleSync = () => {
        if (syncTimer !== null) return
        // Provider chunks can arrive much faster than the browser can render.
        // Bound React/layout work while retaining every byte in local buffers.
        syncTimer = window.setTimeout(flushSync, 50)
      }
      cancelScheduledSync = () => {
        if (syncTimer !== null) window.clearTimeout(syncTimer)
        syncTimer = null
      }
      flushScheduledSync = flushSync

      const processFrame = (rawFrame: string) => {
        const data = readSseData(rawFrame)
        if (!data) return
        if (data === '[DONE]') {
          sawDone = true
          return
        }
        if (sawDone) throw new Error('The provider sent data after the terminal streaming event.')

        let frame: StreamFrame
        try {
          frame = JSON.parse(data) as StreamFrame
        } catch {
          throw new Error('The provider returned a malformed streaming event.')
        }
        if (frame.error?.message) throw new Error(frame.error.message)

        const choice = frame.choices?.[0]
        if (choice) sawChoice = true
        const deltaText = choice?.delta?.content ?? ''
        if ((deltaText || choice?.delta?.refusal || choice?.delta?.tool_calls?.length) && firstTokenMs === undefined) {
          firstTokenMs = performance.now() - startedAt
        }
        content += deltaText
        refusal += choice?.delta?.refusal ?? ''
        finishReason = choice?.finish_reason ?? finishReason
        usage = frame.usage ?? usage

        for (const delta of choice?.delta?.tool_calls ?? []) {
          const index = delta.index ?? 0
          const existing = toolCalls.get(index)
          toolCalls.set(index, {
            id: delta.id ?? existing?.id ?? `tool-${index}`,
            type: 'function',
            function: {
              name: `${existing?.function.name ?? ''}${delta.function?.name ?? ''}`,
              arguments: `${existing?.function.arguments ?? ''}${delta.function?.arguments ?? ''}`,
            },
            ...(delta.thought_signature || existing?.thought_signature ? { thought_signature: delta.thought_signature ?? existing?.thought_signature } : {}),
          })
        }
        scheduleSync()
      }

      while (true) {
        const { done, value } = await activeReader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const extracted = extractSseFrames(buffer)
        buffer = extracted.remainder
        for (const frame of extracted.frames) processFrame(frame)
      }
      buffer += decoder.decode()
      for (const frame of extractSseFrames(buffer, true).frames) processFrame(frame)
      if (!sawDone) throw new Error('The provider stream ended before the terminal [DONE] event.')
      if (!sawChoice || finishReason === null || finishReason === undefined) {
        throw new Error('The provider stream ended without a completed choice.')
      }
      if (!usage) {
        const promptTokens = Math.ceil(JSON.stringify(body.messages).length / 4)
        const completionTokens = Math.ceil((content.length + refusal.length + [...toolCalls.values()].reduce((sum, call) => sum + call.function.name.length + call.function.arguments.length, 0)) / 4)
        usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
        usageEstimated = true
      }
      flushSync()
    } catch (error) {
      // Preserve the last valid buffered chunks before annotating a partial
      // response with its terminal error or cancellation reason.
      flushScheduledSync?.()
      const cancelled = controller.signal.aborted
      const message = cancelled ? 'Request stopped.' : error instanceof Error ? error.message : 'Unknown request error.'
      const elapsed = performance.now() - startedAt
      if (streaming && response?.ok && streamingMessageStarted) {
        replaceMessage(assistantId, current => ({
          ...current,
          kind: current.content || current.refusal || current.toolCalls?.length ? 'normal' : 'error',
          streamError: message,
          meta: { ...current.meta, latencyMs: elapsed, finishReason: cancelled ? 'cancelled' : 'error' },
        }))
      } else {
        setMessages(current => [...current, {
          id: assistantId,
          role: 'assistant',
          kind: 'error',
          content: message,
          meta: { requestId: response?.headers.get('X-Request-Id') ?? undefined, latencyMs: elapsed, finishReason: cancelled ? 'cancelled' : 'error' },
        }])
      }
    } finally {
      cancelScheduledSync?.()
      if (activeReader) {
        try {
          await activeReader.cancel()
        } catch {
          // The stream may already be closed or aborted.
        }
        activeReader.releaseLock()
      }
      if (abortRef.current === controller) abortRef.current = null
      setLoading(false)
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void handleSend()
    }
  }

  async function copyMessage(message: PlaygroundMessage) {
    try {
      await copyText(message.content || message.refusal || '')
      setCopiedMessageId(message.id)
      setFormError(null)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not copy the response.')
    }
  }

  function exportThread() {
    const data = {
      format: 'llmharbor.playground.v1',
      exportedAt: new Date().toISOString(),
      request: { model: selectedModel, stream: streaming, temperature, maxTokens, systemPrompt, toolsJson, toolChoice },
      messages,
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'llmharbor-conversation.json'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function clearThread() {
    if (messages.length && !window.confirm('Clear this conversation? Export it first if you want to keep a copy.')) return
    setMessages([])
    setToolResults({})
    setFormError(null)
    inputRef.current?.focus()
  }

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col">
      <PageHeader
        eyebrow="Request debugger"
        title="Playground"
        description="Exercise the same OpenAI-compatible endpoint your applications use, including streaming and tool calls."
        actions={
          <>
            <Select disabled={loading} value={selectedModel} onValueChange={value => setSelectedModel(value ?? 'auto')}>
              <SelectTrigger className="w-full sm:w-[280px]" aria-label="Choose model route">
                <SelectValue>{activeModelLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto routing</SelectItem>
                {configuredModels.map(model => {
                  const id = localModelId(model)
                  const policyAllowed = modelAllowedBySelectedKey(model)
                  return <SelectItem key={model.modelDbId} value={id} disabled={!model.eligible || !policyAllowed}>{model.displayName} · {id}{!policyAllowed ? ' · blocked by key' : model.eligible ? '' : ' · unavailable'}</SelectItem>
                })}
              </SelectContent>
            </Select>
            {messages.length > 0 ? (
              <>
              <Button variant="outline" size="sm" onClick={exportThread} disabled={loading}><Download aria-hidden="true" /> Export</Button>
              <Button variant="outline" size="sm" onClick={clearThread} disabled={loading}>
                <Trash2 aria-hidden="true" /> Clear
              </Button>
              </>
            ) : null}
          </>
        }
      />

      <div className="grid flex-1 min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="panel-card flex h-[min(760px,calc(100dvh-12rem))] min-h-[460px] min-w-0 flex-col overflow-hidden rounded-[var(--radius-panel)]" aria-labelledby="playground-thread-title">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h2 id="playground-thread-title" className="text-sm font-semibold">Conversation</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Enter sends · Shift Enter adds a line · Kept until reload</p>
            </div>
            <div className="flex items-center gap-2">
              <StatusIndicator label={streaming ? 'Streaming' : 'Single response'} tone={loading ? 'warning' : 'info'} />
              <Badge variant="outline" className="max-w-52 truncate">{activeModelLabel}</Badge>
            </div>
          </div>

          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{conversationAnnouncement}</div>
          <div ref={scrollRef} onScroll={event => { const el = event.currentTarget; setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 80) }} className="relative min-h-0 flex-1 overflow-y-auto p-4 sm:p-5" role="log" aria-label="Conversation" aria-live="off" aria-relevant="additions" aria-busy={loading}>
            <div className="relative space-y-5">
              {keyLoading || routesLoading || policyLoading ? (
                <div className="flex min-h-[360px] items-center justify-center"><LoadingState title="Preparing Playground" description={setupMessage} /></div>
              ) : keyError || routesError || policyQuery.isError ? (
                <div className="flex min-h-[360px] items-center justify-center"><ErrorState title="Playground setup failed" description={setupMessage} /></div>
              ) : messages.length === 0 ? (
                <div className="flex min-h-[430px] items-center justify-center"><EmptyState title="Send a test request" description={setupMessage} /></div>
              ) : messages.map(message => (
                <article key={message.id} className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
                  <div className={cn(
                    'min-w-0 max-w-[92%] sm:max-w-[82%]',
                    message.role === 'user' && 'rounded-[var(--radius-panel)] bg-primary px-4 py-3 text-primary-foreground',
                    message.role === 'assistant' && message.kind !== 'error' && 'rounded-[var(--radius-panel)] border border-border bg-background px-4 py-3',
                    message.kind === 'error' && 'rounded-[var(--radius-panel)] border border-destructive/30 bg-destructive/8 px-4 py-3 text-destructive',
                    message.role === 'tool' && 'rounded-[var(--radius-panel)] border border-primary/25 bg-primary/5 px-4 py-3',
                  )}>
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] opacity-65">{message.role === 'tool' ? 'Tool result' : message.role}</p>
                    {message.content || message.refusal ? <div className="whitespace-pre-wrap break-words text-sm leading-6">{message.content || message.refusal}</div> : message.toolCalls?.length ? null : <span className="text-sm text-muted-foreground">{loading && message.id === latestMessage?.id ? 'Waiting for response…' : 'No response text returned.'}</span>}

                    {message.toolCalls?.map(call => (
                      <ToolCallCard
                        key={call.id}
                        call={call}
                        result={toolResults[call.id] ?? ''}
                        onResultChange={value => setToolResults(current => ({ ...current, [call.id]: value }))}
                        onAddResult={() => addToolResult(call)}
                        alreadyAnswered={messages.some(item => item.role === 'tool' && item.toolCallId === call.id)}
                        disabled={loading || Boolean(message.streamError)}
                      />
                    ))}

                    {message.streamError ? <InlineNotice className="mt-3" tone={message.meta?.finishReason === 'cancelled' ? 'neutral' : 'critical'}>{message.streamError}</InlineNotice> : null}

                    {message.role === 'assistant' && !loading ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {message.content || message.refusal ? <Button variant="ghost" size="xs" onClick={() => void copyMessage(message)} aria-label="Copy assistant response"><Copy aria-hidden="true" /> {copiedMessageId === message.id ? 'Copied' : 'Copy'}</Button> : null}
                        {message.id === latestMessage?.id && message.kind === 'error' ? <Button variant="outline" size="xs" disabled={!selectedModelReady} onClick={() => void handleSend(true)}><RotateCcw aria-hidden="true" /> Retry request</Button> : null}
                      </div>
                    ) : null}

                    {message.meta ? (
                      <dl className={cn('mt-3 grid gap-x-4 gap-y-2 border-t pt-3', message.role === 'user' ? 'border-primary-foreground/25' : 'border-border', 'grid-cols-2 sm:grid-cols-4')}>
                        {message.meta.requestId ? <MetaItem label="Request ID" value={message.meta.requestId} /> : null}
                        {message.meta.platform ? <MetaItem label="Provider" value={message.meta.platform} /> : null}
                        {message.meta.model ? <MetaItem label="Model" value={message.meta.model} /> : null}
                        {message.meta.clientKey ? <MetaItem label="Client key" value={message.meta.clientKey} /> : null}
                        {message.meta.latencyMs !== undefined ? <MetaItem label="Latency" value={formatDuration(message.meta.latencyMs)} /> : null}
                        {message.meta.firstTokenMs !== undefined ? <MetaItem label="First token" value={formatDuration(message.meta.firstTokenMs)} /> : null}
                        {message.meta.usage ? <MetaItem label={message.meta.usageEstimated ? 'Tokens · est.' : 'Tokens'} value={formatCompactNumber(message.meta.usage.total_tokens)} /> : null}
                        {message.meta.finishReason ? <MetaItem label="Finish" value={message.meta.finishReason} /> : null}
                        {message.meta.fallbackAttempts ? <MetaItem label="Fallbacks" value={String(message.meta.fallbackAttempts)} /> : null}
                      </dl>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </div>

          <div className="border-t border-border bg-card p-3">
            {!following && messages.length > 0 ? <Button variant="outline" size="sm" className="mb-2" onClick={() => setFollowing(true)}><ArrowDown aria-hidden="true" /> Jump to latest</Button> : null}
            {formError ? <InlineNotice tone="critical" className="mb-3">{formError}</InlineNotice> : null}
            <div className="flex items-end gap-2 rounded-[var(--radius-panel)] border border-input bg-background p-2 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20">
              <Label htmlFor="playground-prompt" className="sr-only">Message</Label>
              <textarea
                id="playground-prompt"
                ref={inputRef}
                value={input}
                onChange={event => setInput(event.target.value)}
                onKeyDown={handleKeyDown}
                onInput={event => {
                  const element = event.currentTarget
                  element.style.height = 'auto'
                  element.style.height = `${Math.min(element.scrollHeight, 180)}px`
                }}
                placeholder="Message the selected route…"
                rows={1}
                disabled={loading}
                className="max-h-[180px] min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground/75 disabled:opacity-60"
              />
              {loading ? (
                <Button onClick={stopRequest} variant="destructive" size="lg"><CircleStop aria-hidden="true" /> Stop</Button>
              ) : (
                <Button onClick={() => void handleSend()} disabled={!canSend} size="lg" aria-describedby="playground-send-help"><Send aria-hidden="true" /> {canContinueToolCall && !input.trim() ? 'Continue' : 'Send'}</Button>
              )}
            </div>
            <p id="playground-send-help" className="mt-2 text-xs text-muted-foreground">{canContinueToolCall && !input.trim() ? 'Continue sends the completed tool result messages back to the model.' : canSend ? setupMessage : loading ? 'Response in progress. Stop the request to cancel it.' : unresolvedToolCalls.length > 0 ? `Add results for ${unresolvedToolCalls.length} remaining tool call${unresolvedToolCalls.length === 1 ? '' : 's'}.` : setupMessage}</p>
          </div>
        </section>

        <aside className="min-w-0 space-y-4" aria-label="Request configuration and route details">
          <section className="panel-card rounded-[var(--radius-panel)] p-4">
            <SectionTitle title="Request options" description="Sent with the next completion request." />
            <div className="space-y-4">
              <div>
                <Label id="playground-client-key-label" className="mb-1.5 text-xs">Local client key</Label>
                <Select
                  value={selectedClientKey ? String(selectedClientKey.id) : undefined}
                  onValueChange={value => setSelectedClientKeyId(value ? Number(value) : null)}
                  disabled={loading || enabledClientKeys.length === 0}
                >
                  <SelectTrigger className="w-full" aria-labelledby="playground-client-key-label">
                    <SelectValue>
                      {selectedClientKey ? `${selectedClientKey.label} · ${selectedClientKey.maskedKey}` : 'No enabled key'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {enabledClientKeys.map(key => <SelectItem key={key.id} value={String(key.id)}>{key.label} · {key.maskedKey}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
                  {selectedClientKey
                    ? `This key's route policy and ${[
                        selectedClientKey.limits.rpm ? `${selectedClientKey.limits.rpm} RPM` : null,
                        selectedClientKey.limits.rpd ? `${selectedClientKey.limits.rpd} RPD` : null,
                        selectedClientKey.limits.tpm ? `${formatCompactNumber(selectedClientKey.limits.tpm)} TPM` : null,
                        selectedClientKey.limits.tpd ? `${formatCompactNumber(selectedClientKey.limits.tpd)} TPD` : null,
                      ].filter(Boolean).join(' · ') || 'unlimited request and token quotas'} apply to this request.`
                    : 'Create or enable a local client key to use the Playground.'}
                </p>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-[var(--radius-button)] border border-border bg-background px-3 py-2.5">
                <div>
                  <Label htmlFor="streaming-toggle">Streaming</Label>
                  <p className="mt-1 text-xs text-muted-foreground">Render SSE chunks as they arrive.</p>
                </div>
                <Switch id="streaming-toggle" checked={streaming} onCheckedChange={setStreaming} disabled={loading} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="playground-temperature" className="mb-1.5 text-xs">Temperature</Label>
                  <Input id="playground-temperature" type="number" min="0" max="2" step="0.1" value={temperature} onChange={event => setTemperature(event.target.value)} placeholder="default" disabled={loading} />
                </div>
                <div>
                  <Label htmlFor="playground-max-tokens" className="mb-1.5 text-xs">Max tokens</Label>
                  <Input id="playground-max-tokens" type="number" min="1" step="1" value={maxTokens} onChange={event => setMaxTokens(event.target.value)} placeholder="default" disabled={loading} />
                </div>
              </div>
              <details className="group rounded-[var(--radius-button)] border border-border bg-background">
                <summary className="cursor-pointer list-none px-3 py-2.5 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/25">System instruction</summary>
                <div className="border-t border-border p-3">
                  <Label htmlFor="playground-system" className="sr-only">System instruction</Label>
                  <Textarea id="playground-system" value={systemPrompt} onChange={event => setSystemPrompt(event.target.value)} placeholder="Optional system message" disabled={loading} />
                </div>
              </details>
              <details className="group rounded-[var(--radius-button)] border border-border bg-background">
                <summary className="cursor-pointer list-none px-3 py-2.5 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/25">Function tools</summary>
                <div className="space-y-3 border-t border-border p-3">
                  <div>
                    <Label htmlFor="playground-tools" className="mb-1.5 text-xs">OpenAI tools JSON</Label>
                    <Textarea id="playground-tools" value={toolsJson} onChange={event => setToolsJson(event.target.value)} placeholder='[{"type":"function","function":{"name":"get_weather","parameters":{"type":"object"}}}]' className="min-h-32 font-mono text-[11px]" disabled={loading} spellCheck={false} />
                  </div>
                  <div>
                    <Label id="playground-tool-choice-label" className="mb-1.5 text-xs">Tool choice</Label>
                    <Select value={toolChoice} onValueChange={value => setToolChoice((value ?? 'auto') as typeof toolChoice)} disabled={loading || !toolsJson.trim()}>
                      <SelectTrigger className="w-full" aria-labelledby="playground-tool-choice-label"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Auto</SelectItem>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="required">Required</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </details>
            </div>
          </section>

          <section className="panel-card rounded-[var(--radius-panel)] p-4">
            <SectionTitle title="Last route" description="Response metadata from this browser session." />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <MetaItem label="Mode" value={selectedModel === 'auto' ? 'Automatic' : 'Preferred model'} />
              <MetaItem label="Ready models" value={String(availableModels.length)} />
              <MetaItem label="Client key" value={lastMeta?.clientKey ?? '—'} />
              <MetaItem label="Provider" value={lastMeta?.platform ?? '—'} />
              <MetaItem label="Model" value={lastMeta?.model ?? '—'} />
              <MetaItem label="Latency" value={lastMeta?.latencyMs !== undefined ? formatDuration(lastMeta.latencyMs) : '—'} />
              <MetaItem label="Tokens" value={lastMeta?.usage ? formatCompactNumber(lastMeta.usage.total_tokens) : '—'} />
            </dl>
          </section>
        </aside>
      </div>
    </div>
  )
}
