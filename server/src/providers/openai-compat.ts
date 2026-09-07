import { streamOpenAIResponse } from './openai-stream.js';
import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Platform,
} from '@llmharbor/shared/types.js';
import { BaseProvider, ProviderError, ProviderProtocolError, type CompletionOptions, type ProviderCatalogModel } from './base.js';
import { fetchPinnedCustomEndpoint } from '../lib/urlSecurity.js';

function catalogRows(body: any): any[] {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.models)) return body.models;
  return [];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function numericValue(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const nested = numericValue(record.tokens, record.token, record.max_input_tokens, record.chars);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function pricingFields(row: Record<string, unknown>): unknown {
  if (row.pricing || row.cost || row.limits || row.price) return row.pricing ?? row.cost ?? row.limits ?? row.price;
  const prompt = row.prompt ?? row.input ?? row.prompt_tokens ?? row.input_tokens ?? row.input_token ?? row.prompt_price
    ?? row.input_price ?? row.prompt_cost ?? row.input_cost ?? row.prompt_token_cost ?? row.input_cost_per_token;
  const completion = row.completion ?? row.output ?? row.completion_tokens ?? row.output_tokens ?? row.output_token ?? row.completion_price
    ?? row.output_price ?? row.completion_cost ?? row.output_cost ?? row.completion_token_cost ?? row.output_cost_per_token;
  return prompt !== undefined || completion !== undefined ? { prompt, completion } : null;
}

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
  private readonly modelsUrl?: string;
  private readonly redirect: 'follow' | 'error';
  /** Per-provider HTTP timeout override. Cloud APIs finish in ~15s; locally-hosted
   * inference (llama.cpp / vLLM on CPU) can take 30-120s for long prompts. Default 15000. */
  readonly timeoutMs: number;

  constructor(opts: {
    platform: Platform;
    name: string;
    baseUrl: string;
    extraHeaders?: Record<string, string>;
    validateUrl?: string;
    modelsUrl?: string;
    timeoutMs?: number;
    /** Custom endpoints must not redirect into a network location that was not validated. */
    allowRedirects?: boolean;
  }) {
    super();
    this.platform = opts.platform;
    this.name = opts.name;
    this.baseUrl = opts.baseUrl;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.validateUrl = opts.validateUrl;
    this.modelsUrl = opts.modelsUrl;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.redirect = opts.allowRedirects === false ? 'error' : 'follow';
  }

  private endpoint(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private fetchEndpoint(url: string, init: RequestInit, headersTimeoutMs: number): Promise<Response> {
    return this.fetchWithTimeout(
      url,
      init,
      headersTimeoutMs,
      Math.max(headersTimeoutMs, 120_000),
      this.redirect === 'error' ? fetchPinnedCustomEndpoint : fetch,
    );
  }

  async listModels(apiKey: string, signal?: AbortSignal): Promise<ProviderCatalogModel[]> {
    const url = this.modelsUrl ?? this.endpoint('/models');
    const res = await this.fetchEndpoint(url, {
      method: 'GET',
      redirect: this.redirect,
      signal,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...this.extraHeaders,
      },
    }, 10000);

    if (!res.ok) {
      // Do not retain an arbitrary upstream response body. Catalog failures are
      // surfaced in updater state rendered by the dashboard.
      await res.body?.cancel().catch(() => {});
      throw new ProviderError(`${this.name} model catalog returned HTTP ${res.status}.`, { statusCode: res.status });
    }

    const body = await res.json() as any;
    const normalized: Array<ProviderCatalogModel | null> = catalogRows(body)
      .map((row: any) => {
        if (typeof row === 'string') {
          return { id: row, displayName: row, contextWindow: null, pricing: null, raw: row };
        }
        if (!row || typeof row !== 'object') return null;
        const record = row as Record<string, unknown>;
        const id = firstString(record.id, record.model, record.model_id, record.name);
        if (!id) return null;
        const displayName = firstString(record.display_name, record.displayName, record.name, record.label, id) ?? id;
        return {
          id,
          displayName,
          contextWindow: numericValue(record.context_length, record.context_window, record.max_context_length, record.context, record.inputTokenLimit, (record.limits as any)?.max_input_tokens, (record.top_provider as any)?.context_length),
          pricing: pricingFields(record),
          raw: row,
        };
      });
    return normalized.filter((row): row is ProviderCatalogModel => row !== null);
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
    const url = this.endpoint('/chat/completions');
    const res = await this.fetchEndpoint(url, {
      method: 'POST',
      redirect: this.redirect,
      signal: options?.signal,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: modelId,
        messages: this.platform === 'openai' ? messages : messages.map(message => message.role === 'developer' ? { ...message, role: 'system' } : message),
        temperature: options?.temperature,
        max_tokens: this.platform === 'openai' && options?.max_completion_tokens !== undefined ? undefined : options?.max_tokens,
        max_completion_tokens: this.platform === 'openai' ? options?.max_completion_tokens : undefined,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
      }),
    }, this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new ProviderError(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`, { statusCode: res.status });
    }

    const raw = await res.json().catch((error: any) => {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw error;
      throw new ProviderProtocolError(`${this.name} returned malformed JSON.`);
    });
    const data = normalizeOpenAICompatibleResponse(raw, this.name, modelId, () => this.makeId());
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
    const url = this.endpoint('/chat/completions');
    const res = await this.fetchEndpoint(url, {
      method: 'POST',
      redirect: this.redirect,
      signal: options?.signal,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: modelId,
        messages: this.platform === 'openai' ? messages : messages.map(message => message.role === 'developer' ? { ...message, role: 'system' } : message),
        temperature: options?.temperature,
        max_tokens: this.platform === 'openai' && options?.max_completion_tokens !== undefined ? undefined : options?.max_tokens,
        max_completion_tokens: this.platform === 'openai' ? options?.max_completion_tokens : undefined,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        stream: true,
        stream_options: options?.stream_options,
      }),
    }, this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new ProviderError(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`, { statusCode: res.status });
    }

    yield* streamOpenAIResponse(res, this.name, modelId, () => this.makeId());
  }

  async validateKey(apiKey: string, signal?: AbortSignal): Promise<boolean> {
    // Note: transport errors (DNS / timeout / TLS) propagate to the caller.
    // health.ts catches them and marks status='error' WITHOUT incrementing
    // the consecutive-failure counter — only confirmed 401/403 disables a key.
    const url = this.validateUrl ?? `${this.baseUrl}/models`;
    const res = await this.fetchEndpoint(url, {
      method: 'GET',
      redirect: this.redirect,
      signal,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...this.extraHeaders,
      },
    }, 10000);
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw new ProviderError(`${this.name} validation endpoint returned a blocked redirect.`, {
        statusCode: res.status,
        retryable: true,
        code: 'provider_redirect_blocked',
      });
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      return false;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ProviderError(`${this.name} validation endpoint returned HTTP ${res.status}.`, { statusCode: res.status, retryable: true });
    }
    await res.body?.cancel().catch(() => {});
    return true;
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
    const systemInstructions = messages
      .filter(message => (message.role === 'system' || message.role === 'developer'))
      .map(normalizeMessageText)
      .filter(Boolean)
      .join('\n\n');
    return {
      model: modelId,
      instructions: systemInstructions || 'You are Codex, a precise coding and reasoning assistant. Answer the user directly and concisely unless more detail is needed.',
      input: messages.filter(message => (message.role !== 'system' && message.role !== 'developer')).map(message => ({
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
      max_output_tokens: options?.max_tokens,
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
      signal: options?.signal,
      headers: this.chatGptHeaders(accessToken),
      body: JSON.stringify(this.responsesBody(messages, modelId, options, true)),
    }, 120000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new ProviderError(`ChatGPT Codex OAuth error ${res.status}: ${(err as any).error?.message ?? (err as any).detail ?? res.statusText}`, { statusCode: res.status });
    }
    const output = await collectCodexStreamText(res);
    if (!output.text && !output.refusal) throw new ProviderProtocolError('ChatGPT Codex OAuth returned an empty completion stream.');
    return {
      id: this.makeId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: output.text || null,
          ...(output.refusal ? { refusal: output.refusal } : {}),
        },
        finish_reason: output.refusal ? 'content_filter' : 'stop',
      }],
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
      signal: options?.signal,
      headers: this.chatGptHeaders(accessToken),
      body: JSON.stringify(this.responsesBody(messages, modelId, options, true)),
    }, 120000);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new ProviderError(`ChatGPT Codex OAuth error ${res.status}: ${(err as any).error?.message ?? (err as any).detail ?? res.statusText}`, { statusCode: res.status });
    }
    const reader = res.body?.getReader();
    if (!reader) throw new ProviderProtocolError('ChatGPT Codex OAuth returned no streaming response body.');
    const decoder = new TextDecoder();
    const id = this.makeId();
    let buffer = '';
    const accumulator = new CodexTextAccumulator();
    let emittedContent = false;
    let emittedRefusal = false;
    let malformedFrames = 0;
    let sawTerminalEvent = false;
    const terminalChunk = (): ChatCompletionChunk => ({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{ index: 0, delta: {}, finish_reason: emittedRefusal ? 'content_filter' : 'stop' }],
    });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const raw = trimmed.slice(5).trimStart();
          if (raw === '[DONE]') {
            if (!emittedContent && !emittedRefusal) throw new ProviderProtocolError('ChatGPT Codex OAuth returned an empty completion stream.');
            if (malformedFrames > 0) throw new ProviderProtocolError('ChatGPT Codex OAuth returned malformed streaming data.');
            yield terminalChunk();
            return;
          }
          try {
            const event = JSON.parse(raw) as any;
            if (event?.type === 'response.completed') sawTerminalEvent = true;
            const delta = accumulator.push(event);
            if (delta.content) {
              emittedContent = true;
              yield {
                id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{ index: 0, delta: { content: delta.content }, finish_reason: null }],
              };
            }
            if (delta.refusal) {
              emittedRefusal = true;
              yield {
                id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{ index: 0, delta: { refusal: delta.refusal }, finish_reason: null }],
              };
            }
          } catch (error) {
            if (error instanceof ProviderProtocolError) throw error;
            malformedFrames++;
          }
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* body already closed */ }
    }
    if (!emittedContent && !emittedRefusal) throw new ProviderProtocolError('ChatGPT Codex OAuth returned an empty completion stream.');
    if (malformedFrames > 0) throw new ProviderProtocolError('ChatGPT Codex OAuth returned malformed streaming data.');
    if (!sawTerminalEvent) throw new ProviderProtocolError('ChatGPT Codex OAuth returned a truncated completion stream.');
    yield terminalChunk();
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

class CodexTextAccumulator {
  private emittedText = '';
  private emittedRefusal = '';

  push(event: any): { content?: string; refusal?: string } {
    const result: { content?: string; refusal?: string } = {};
    const candidates = codexEventTextCandidates(event);
    for (const candidate of candidates) {
      if (!candidate.text) continue;
      const next = candidate.cumulative ? this.diffCumulative(candidate.text, 'text') : candidate.text;
      if (!next) continue;
      this.emittedText += next;
      result.content = next;
      break;
    }
    for (const candidate of codexEventRefusalCandidates(event)) {
      if (!candidate.text) continue;
      const next = candidate.cumulative ? this.diffCumulative(candidate.text, 'refusal') : candidate.text;
      if (!next) continue;
      this.emittedRefusal += next;
      result.refusal = next;
      break;
    }
    return result;
  }

  private diffCumulative(text: string, kind: 'text' | 'refusal'): string {
    const emitted = kind === 'text' ? this.emittedText : this.emittedRefusal;
    if (!emitted) return text;
    if (text === emitted) return '';
    if (text.startsWith(emitted)) return text.slice(emitted.length);
    if (emitted.includes(text)) return '';
    return text;
  }
}

function codexEventTextCandidates(event: any): Array<{ text: string; cumulative: boolean }> {
  const type = typeof event?.type === 'string' ? event.type : '';
  const isDeltaEvent = type.includes('delta');
  const candidates: Array<{ text: string; cumulative: boolean }> = [];

  // Typed Responses events may carry reasoning or function arguments in the
  // same `delta` shape. Only output-text events are assistant content. Keep a
  // narrow untyped fallback for older Codex fixtures/proxies.
  if (!type || type === 'response.output_text.delta') {
    if (typeof event?.delta === 'string') candidates.push({ text: event.delta, cumulative: false });
  }
  if (!type || type === 'response.output_text.done') {
    if (typeof event?.text === 'string') candidates.push({ text: event.text, cumulative: !isDeltaEvent });
  }
  if (type === 'response.completed' || !type) {
    if (typeof event?.response?.output_text === 'string') candidates.push({ text: event.response.output_text, cumulative: true });
  }

  const output = type === 'response.completed' || !type
    ? (event?.response?.output ?? event?.output ?? [])
    : [];
  for (const item of output) {
    for (const part of item?.content ?? []) {
      if ((part?.type === undefined || part?.type === 'output_text') && typeof part?.text === 'string') {
        candidates.push({ text: part.text, cumulative: true });
      }
    }
  }

  return candidates;
}

function codexEventRefusalCandidates(event: any): Array<{ text: string; cumulative: boolean }> {
  const type = typeof event?.type === 'string' ? event.type : '';
  const candidates: Array<{ text: string; cumulative: boolean }> = [];
  if (type === 'response.refusal.delta' && typeof event?.delta === 'string') {
    candidates.push({ text: event.delta, cumulative: false });
  }
  if (type === 'response.refusal.done' && typeof event?.refusal === 'string') {
    candidates.push({ text: event.refusal, cumulative: true });
  }
  if (type === 'response.completed' || !type) {
    for (const item of event?.response?.output ?? event?.output ?? []) {
      for (const part of item?.content ?? []) {
        if (part?.type === 'refusal' && typeof part?.refusal === 'string') {
          candidates.push({ text: part.refusal, cumulative: true });
        }
      }
    }
  }
  return candidates;
}

async function collectCodexStreamText(res: Response): Promise<{ text: string; refusal: string }> {
  const reader = res.body?.getReader();
  if (!reader) throw new ProviderProtocolError('ChatGPT Codex OAuth returned no streaming response body.');
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let refusal = '';
  const accumulator = new CodexTextAccumulator();
  let malformedFrames = 0;
  let sawTerminalEvent = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const raw = trimmed.slice(5).trimStart();
        if (raw === '[DONE]') {
          if (!text && !refusal) throw new ProviderProtocolError('ChatGPT Codex OAuth returned an empty completion stream.');
          if (malformedFrames > 0) throw new ProviderProtocolError('ChatGPT Codex OAuth returned malformed streaming data.');
          return { text, refusal };
        }
        try {
          const event = JSON.parse(raw);
          if (event?.type === 'response.completed') sawTerminalEvent = true;
          const delta = accumulator.push(event);
          text += delta.content ?? '';
          refusal += delta.refusal ?? '';
        } catch { malformedFrames++; }
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* body already closed */ }
  }
  if (!text && !refusal) throw new ProviderProtocolError('ChatGPT Codex OAuth returned an empty completion stream.');
  if (malformedFrames > 0) throw new ProviderProtocolError('ChatGPT Codex OAuth returned malformed streaming data.');
  if (!sawTerminalEvent) throw new ProviderProtocolError('ChatGPT Codex OAuth returned a truncated completion stream.');
  return { text, refusal };
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export { isOpenAIStreamChunk, hasSubstantiveOpenAIStreamDelta } from './openai-stream.js';

function normalizeChatCompletionResponse(
  raw: unknown,
  providerName: string,
  requestedModel: string,
  makeId: () => string,
): ChatCompletionResponse {
  if (!raw || typeof raw !== 'object') {
    throw new ProviderProtocolError(`${providerName} returned a non-object chat completion response.`);
  }
  const data = raw as any;
  if (!Array.isArray(data.choices) || data.choices.length === 0) {
    throw new ProviderProtocolError(`${providerName} returned a chat completion without choices.`);
  }
  data.choices = data.choices.map((choice: any, index: number) => {
    if (!choice || typeof choice !== 'object' || !choice.message || typeof choice.message !== 'object') {
      throw new ProviderProtocolError(`${providerName} returned a malformed choice at index ${index}.`);
    }
    const message = choice.message;
    if (message.content === undefined && (message.tool_calls?.length || typeof message.refusal === 'string')) {
      message.content = null;
    }
    if (message.content !== null && typeof message.content !== 'string' && !Array.isArray(message.content)) {
      throw new ProviderProtocolError(`${providerName} returned an invalid assistant message content value.`);
    }
    if (message.refusal !== undefined && message.refusal !== null && typeof message.refusal !== 'string') {
      throw new ProviderProtocolError(`${providerName} returned an invalid assistant refusal value.`);
    }
    if (Array.isArray(message.content) && message.content.some((part: unknown) => (
      typeof part !== 'string' && (!part || typeof part !== 'object'
        || ('text' in part && typeof part.text !== 'string'))
    ))) {
      throw new ProviderProtocolError(`${providerName} returned malformed assistant content blocks.`);
    }
    if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
      throw new ProviderProtocolError(`${providerName} returned malformed tool_calls.`);
    }
    const toolCalls = message.tool_calls?.map((call: any, callIndex: number) => {
      if (
        !call || typeof call !== 'object'
        || typeof call.id !== 'string' || !call.id
        || call.type !== 'function'
        || !call.function || typeof call.function !== 'object'
        || typeof call.function.name !== 'string' || !call.function.name
        || typeof call.function.arguments !== 'string'
      ) {
        throw new ProviderProtocolError(`${providerName} returned a malformed tool call at index ${callIndex}.`);
      }
      return {
        ...call,
        id: call.id,
        type: 'function' as const,
        function: {
          ...call.function,
          name: call.function.name,
          arguments: call.function.arguments,
        },
      };
    });
    return {
      ...choice,
      index: Number.isInteger(choice.index) && choice.index >= 0 ? choice.index : index,
      message: { ...message, role: 'assistant', ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      finish_reason: typeof choice.finish_reason === 'string' || choice.finish_reason === null
        ? choice.finish_reason
        : null,
    };
  });
  const usage = data.usage && typeof data.usage === 'object' ? data.usage : {};
  const promptTokens = finiteNonNegative(usage.prompt_tokens);
  const completionTokens = finiteNonNegative(usage.completion_tokens);
  return {
    ...data,
    id: typeof data.id === 'string' && data.id ? data.id : makeId(),
    object: 'chat.completion',
    created: finiteNonNegative(data.created) || Math.floor(Date.now() / 1000),
    model: typeof data.model === 'string' && data.model ? data.model : requestedModel,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: finiteNonNegative(usage.total_tokens) || promptTokens + completionTokens,
    },
  } as ChatCompletionResponse;
}

export function normalizeOpenAICompatibleResponse(
  raw: unknown,
  providerName: string,
  requestedModel: string,
  makeId: () => string,
): ChatCompletionResponse {
  const data = normalizeChatCompletionResponse(raw, providerName, requestedModel, makeId);
  normalizeChoices(data);
  return data;
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
