import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader, EmptyState } from '@/components/page-header'
import { cn } from '@/lib/utils'

interface FallbackEntry {
  modelDbId: number
  priority: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  sizeLabel: string
  keyCount: number
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  meta?: {
    platform?: string
    model?: string
    latency?: number
    fallbackAttempts?: number
  }
}

function RoutePill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-background px-3 py-2 ">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-xs font-medium">{value}</p>
    </div>
  )
}

export default function PlaygroundPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>('auto')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.enabled)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return

    const userMsg: ChatMessage = { role: 'user', content: text }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setLoading(true)
    inputRef.current?.focus()

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (keyData?.apiKey) headers['Authorization'] = `Bearer ${keyData.apiKey}`

      const body: { messages: { role: 'user' | 'assistant'; content: string }[]; model?: string } = {
        messages: newMessages.map(m => ({ role: m.role, content: m.content })),
      }
      if (selectedModel !== 'auto') body.model = selectedModel

      const base = import.meta.env.BASE_URL.replace(/\/$/, '')
      const start = Date.now()
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      const latency = Date.now() - start
      const routedVia = res.headers.get('X-Routed-Via')
      const fallbackAttempts = res.headers.get('X-Fallback-Attempts')

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
        setMessages([...newMessages, {
          role: 'assistant',
          content: `Error: ${err.error?.message ?? 'Unknown error'}`,
        }])
        return
      }

      const data = await res.json()
      const content = data.choices?.[0]?.message?.content ?? JSON.stringify(data, null, 2)
      const via = data._routed_via ?? (routedVia ? {
        platform: routedVia.split('/')[0],
        model: routedVia.split('/').slice(1).join('/'),
      } : undefined)

      setMessages([...newMessages, {
        role: 'assistant',
        content,
        meta: {
          platform: via?.platform,
          model: via?.model,
          latency,
          fallbackAttempts: fallbackAttempts ? parseInt(fallbackAttempts) : undefined,
        },
      }])
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setMessages([...newMessages, {
        role: 'assistant',
        content: `Error: ${message}`,
      }])
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleClear = () => {
    setMessages([])
    inputRef.current?.focus()
  }

  const activeModelLabel = selectedModel === 'auto'
    ? 'Auto routing'
    : availableModels.find(m => m.modelId === selectedModel)?.displayName ?? selectedModel

  const lastMeta = [...messages].reverse().find(m => m.meta)?.meta

  return (
    <div className="flex min-h-[calc(100vh-9.5rem)] flex-col">
      <PageHeader
        eyebrow="Test a request"
        title="Playground"
        description="Send one request, see which provider handled it, and check latency without leaving the app."
        actions={
          <>
            <Select value={selectedModel} onValueChange={(v) => setSelectedModel(v ?? 'auto')}>
              <SelectTrigger className="h-9 w-[270px] rounded-2xl bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto routing</SelectItem>
                {availableModels.map(m => (
                  <SelectItem key={m.modelDbId} value={m.modelId}>{m.displayName}, {m.platform}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {messages.length > 0 && <Button variant="outline" size="sm" onClick={handleClear}>Clear thread</Button>}
          </>
        }
      />

      <div className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <section className="panel-card flex min-h-[620px] flex-col overflow-hidden rounded-2xl">
          <div className="flex items-center justify-between border-b border-border bg-card px-5 py-3">
            <div>
              <p className="text-sm font-semibold">Thread</p>
              <p className="text-xs text-muted-foreground">Enter to send. Shift Enter for a new line.</p>
            </div>
            <div className="rounded-lg bg-primary/10 px-3 py-1 text-xs font-medium text-primary">{activeModelLabel}</div>
          </div>

          <div className="relative flex-1 overflow-y-auto p-5">
            <div className="harbor-grid pointer-events-none absolute inset-0 opacity-70" />
            <div className="relative space-y-4">
              {messages.length === 0 ? (
                <div className="flex min-h-[430px] items-center justify-center">
                  <EmptyState
                    title="Send a test request."
                    description={`Using ${activeModelLabel}. Add provider keys to start routing requests.`}
                  />
                </div>
              ) : (
                <>
                  {messages.map((msg, i) => (
                    <div key={i} className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                      <div className={cn(
                        'max-w-[86%] rounded-xl px-4 py-3 text-sm leading-7  sm:max-w-[76%]',
                        msg.role === 'user'
                          ? 'bg-primary text-primary-foreground '
                          : 'border border-border bg-background ',
                      )}>
                        <div className="whitespace-pre-wrap">{msg.content}</div>
                        {msg.meta && (
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] opacity-75 tabular-nums">
                            {msg.meta.platform && <span>{msg.meta.platform}</span>}
                            {msg.meta.model && <span className="font-mono">{msg.meta.model}</span>}
                            {msg.meta.latency != null && <span>{msg.meta.latency} ms</span>}
                            {msg.meta.fallbackAttempts != null && msg.meta.fallbackAttempts > 0 && (
                              <span>{msg.meta.fallbackAttempts} fallback{msg.meta.fallbackAttempts > 1 ? 's' : ''}</span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {loading && (
                    <div className="flex justify-start">
                      <div className="rounded-xl border border-border bg-background px-4 py-3 ">
                        <div className="flex gap-1.5">
                          <span className="size-1.5 rounded-lg bg-primary/70 animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="size-1.5 rounded-lg bg-primary/70 animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="size-1.5 rounded-lg bg-primary/70 animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </>
              )}
            </div>
          </div>

          <div className="border-t border-border bg-background p-3 ">
            <div className="flex items-end gap-2 rounded-[var(--radius-panel)] border border-border bg-card p-2 ">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a test prompt..."
                rows={1}
                className="max-h-[180px] min-h-[44px] flex-1 resize-none rounded-[var(--radius-input)] bg-transparent px-3 py-2.5 text-sm leading-6 outline-none placeholder:text-muted-foreground/75"
                style={{ height: 'auto', overflow: 'hidden' }}
                onInput={e => {
                  const el = e.target as HTMLTextAreaElement
                  el.style.height = 'auto'
                  el.style.height = Math.min(el.scrollHeight, 180) + 'px'
                }}
              />
              <Button onClick={handleSend} disabled={loading || !input.trim()} size="lg" className="rounded-[var(--radius-button)] px-4">
                {loading ? 'Routing...' : 'Send'}
              </Button>
            </div>
          </div>
        </section>

        <aside className="space-y-3">
          <RoutePill label="Mode" value={selectedModel === 'auto' ? 'Auto routing' : 'Pinned model'} />
          <RoutePill label="Ready models" value={`${availableModels.length} enabled`} />
          <RoutePill label="Last provider" value={lastMeta?.platform ?? 'No response yet'} />
          <RoutePill label="Latency" value={lastMeta?.latency != null ? `${lastMeta.latency} ms` : 'Waiting'} />
          <div className="rounded-[var(--radius-panel)] border border-border bg-card p-4 text-xs leading-5 text-muted-foreground ">
            <p className="font-medium text-foreground">Practical check</p>
            <p className="mt-1">If a provider fails, LLMHarbor tries the next enabled model. Change the order on the Fallback page.</p>
          </div>
        </aside>
      </div>
    </div>
  )
}
