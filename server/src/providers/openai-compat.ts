import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Platform,
} from '@llmharbor/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';

/**
 * Generic provider for platforms that use an OpenAI-compatible API.
 * Covers: Groq, Cerebras, SambaNova, NVIDIA NIM, Mistral, OpenRouter,
 * GitHub Models, Fireworks AI.
 */
export class OpenAICompatProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly validateUrl?: string;
  /** Per-provider HTTP timeout override. Cloud APIs finish in ~15s; locally-hosted
   * inference (llama.cpp / vLLM on CPU) can take 30-120s for long prompts. Default 15000. */
  readonly timeoutMs: number;

  constructor(opts: {
    platform: Platform;
    name: string;
    baseUrl: string;
    extraHeaders?: Record<string, string>;
    validateUrl?: string;
    timeoutMs?: number;
  }) {
    super();
    this.platform = opts.platform;
    this.name = opts.name;
    this.baseUrl = opts.baseUrl;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.validateUrl = opts.validateUrl;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  private runtimeBaseUrl(options?: CompletionOptions): string {
    if (this.platform !== 'qwen-oauth') return this.baseUrl;
    const metadataUrl = options?.oauth?.metadata?.resourceUrl ?? options?.oauth?.metadata?.qwenResourceUrl;
    const raw = typeof metadataUrl === 'string' && metadataUrl.trim().length > 0 ? metadataUrl.trim() : this.baseUrl;
    const withoutTrailing = raw.replace(/\/+$/, '');
    return withoutTrailing.endsWith('/v1') ? withoutTrailing : `${withoutTrailing}/v1`;
  }

  private endpoint(path: string, options?: CompletionOptions): string {
    return `${this.runtimeBaseUrl(options)}${path}`;
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    if (this.platform === 'openai' && options?.oauth?.provider === 'openai') {
      return this.chatGptSubscriptionCompletion(apiKey, messages, modelId, options);
    }
    const res = await this.fetchWithTimeout(this.endpoint('/chat/completions', options), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
      }),
    }, this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json() as ChatCompletionResponse;
    normalizeChoices(data);
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    if (this.platform === 'openai' && options?.oauth?.provider === 'openai') {
      yield* this.streamChatGptSubscriptionCompletion(apiKey, messages, modelId, options);
      return;
    }
    const res = await this.fetchWithTimeout(this.endpoint('/chat/completions', options), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        stream: true,
      }),
    }, this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data) as ChatCompletionChunk;
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Note: transport errors (DNS / timeout / TLS) propagate to the caller.
    // health.ts catches them and marks status='error' WITHOUT incrementing
    // the consecutive-failure counter — only confirmed 401/403 disables a key.
    const url = this.validateUrl ?? `${this.baseUrl}/models`;
    const res = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...this.extraHeaders,
      },
    }, 10000);
    return res.status !== 401 && res.status !== 403;
  }

  private chatGptHeaders(accessToken: string): Record<string, string> {
    const accountId = extractOpenAIAccountId(accessToken);
    return {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'LLMHarbor/0.1.0',
      'originator': 'llmharbor',
      ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
    };
  }

  private responsesBody(messages: ChatMessage[], modelId: string, options?: CompletionOptions, stream = false): Record<string, unknown> {
    return {
      model: modelId,
      instructions: 'You are Codex, a precise coding and reasoning assistant. Answer the user directly and concisely unless more detail is needed.',
      input: messages.map(message => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: [{
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: normalizeMessageText(message),
        }],
      })),
      stream,
      store: false,
      temperature: options?.temperature,
      top_p: options?.top_p,
    };
  }

  private async chatGptSubscriptionCompletion(
    accessToken: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: this.chatGptHeaders(accessToken),
      body: JSON.stringify(this.responsesBody(messages, modelId, options, true)),
    }, 120000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`ChatGPT Codex OAuth error ${res.status}: ${(err as any).error?.message ?? (err as any).detail ?? res.statusText}`);
    }
    const text = await collectCodexStreamText(res);
    return {
      id: this.makeId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      _routed_via: { platform: this.platform, model: modelId },
    } as ChatCompletionResponse;
  }

  private async *streamChatGptSubscriptionCompletion(
    accessToken: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.fetchWithTimeout('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: this.chatGptHeaders(accessToken),
      body: JSON.stringify(this.responsesBody(messages, modelId, options, true)),
    }, 120000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`ChatGPT Codex OAuth error ${res.status}: ${(err as any).error?.message ?? (err as any).detail ?? res.statusText}`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    const id = this.makeId();
    let buffer = '';
    const accumulator = new CodexTextAccumulator();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const raw = trimmed.slice(6);
        if (raw === '[DONE]') return;
        try {
          const event = JSON.parse(raw) as any;
          const text = accumulator.push(event);
          if (typeof text === 'string' && text.length > 0) {
            yield {
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
            };
          }
        } catch {}
      }
    }
    yield {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractOpenAIAccountId(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;
  for (const key of ['account_id', 'accountId', 'https://api.openai.com/auth']) {
    const value = payload[key];
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (typeof obj.account_id === 'string') return obj.account_id;
      if (typeof obj.accountId === 'string') return obj.accountId;
    }
  }
  return undefined;
}

function normalizeMessageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (message.content == null) return '';
  if (Array.isArray(message.content)) {
    return message.content.map((part: any) => typeof part === 'string' ? part : (part.text ?? '')).join('');
  }
  return String(message.content);
}

function extractResponsesText(data: any): string {
  if (typeof data.output_text === 'string') return data.output_text;
  const pieces: string[] = [];
  for (const item of data.output ?? []) {
    for (const part of item.content ?? []) {
      if (typeof part.text === 'string') pieces.push(part.text);
    }
  }
  return pieces.join('');
}

class CodexTextAccumulator {
  private emitted = '';

  push(event: any): string {
    const candidates = codexEventTextCandidates(event);
    for (const candidate of candidates) {
      if (!candidate.text) continue;
      const next = candidate.cumulative ? this.diffCumulative(candidate.text) : candidate.text;
      if (!next) continue;
      this.emitted += next;
      return next;
    }
    return '';
  }

  private diffCumulative(text: string): string {
    if (!this.emitted) return text;
    if (text === this.emitted) return '';
    if (text.startsWith(this.emitted)) return text.slice(this.emitted.length);
    if (this.emitted.includes(text)) return '';
    return text;
  }
}

function codexEventTextCandidates(event: any): Array<{ text: string; cumulative: boolean }> {
  const type = typeof event?.type === 'string' ? event.type : '';
  const isDeltaEvent = type.includes('delta');
  const candidates: Array<{ text: string; cumulative: boolean }> = [];

  if (typeof event?.delta === 'string') candidates.push({ text: event.delta, cumulative: false });
  if (typeof event?.text === 'string') candidates.push({ text: event.text, cumulative: !isDeltaEvent });
  if (typeof event?.response?.output_text === 'string') candidates.push({ text: event.response.output_text, cumulative: true });
  if (typeof event?.item?.content?.[0]?.text === 'string') candidates.push({ text: event.item.content[0].text, cumulative: true });

  for (const item of event?.response?.output ?? event?.output ?? []) {
    for (const part of item?.content ?? []) {
      if (typeof part?.text === 'string') candidates.push({ text: part.text, cumulative: true });
    }
  }

  return candidates;
}

async function collectCodexStreamText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const accumulator = new CodexTextAccumulator();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const raw = trimmed.slice(6);
      if (raw === '[DONE]') return text;
      try { text += accumulator.push(JSON.parse(raw)); } catch {}
    }
  }
  return text;
}

/**
 * Some providers (Z.ai glm-4.5-flash, Cloudflare DeepSeek-R1-distill, others)
 * return reasoning models' actual answer in `message.reasoning_content` with
 * `message.content === ""`. Fold reasoning_content into content so OpenAI-
 * compatible clients see a non-empty assistant message.
 *
 * Other providers (Mistral magistral-medium) return `message.content` as an
 * array of text segments instead of a string. Flatten to string.
 */
function normalizeChoices(data: ChatCompletionResponse): void {
  for (const choice of data.choices ?? []) {
    const msg = choice.message as ChatMessage & {
      reasoning_content?: string;
      reasoning?: string;
      content: unknown;
    };
    // Flatten array content (Mistral magistral) → join text segments.
    if (Array.isArray(msg.content)) {
      msg.content = (msg.content as Array<{ text?: string; type?: string }>)
        .map(seg => (typeof seg === 'string' ? seg : (seg.text ?? '')))
        .join('');
    }
    // Fold reasoning into content if content is empty AND there are no
    // tool_calls. With tool_calls present, content=null is the correct OpenAI
    // shape; folding reasoning would confuse clients that branch on content.
    // Field naming varies by provider: Z.ai uses `reasoning_content`, Ollama
    // uses `reasoning`. Prefer `reasoning_content` when both are set.
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    if (!hasToolCalls && (msg.content === '' || msg.content == null)) {
      const fold = (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0)
        ? msg.reasoning_content
        : (typeof msg.reasoning === 'string' && msg.reasoning.length > 0 ? msg.reasoning : null);
      if (fold !== null) msg.content = fold;
    }
  }
}
