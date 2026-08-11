import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@llmharbor/shared/types.js';
import { BaseProvider, ProviderError, ProviderProtocolError, type CompletionOptions } from './base.js';
import { flattenMessageContent } from '../lib/content.js';
import { hasSubstantiveOpenAIStreamDelta, isOpenAIStreamChunk, normalizeOpenAICompatibleResponse } from './openai-compat.js';

const API_BASE = 'https://api.cohere.ai/compatibility/v1';

export class CohereProvider extends BaseProvider {
  readonly platform = 'cohere' as const;
  readonly name = 'Cohere';

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: flattenMessageContent(messages),
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      top_p: options?.top_p,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
    };

    const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
      method: 'POST',
      signal: options?.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new ProviderError(`Cohere API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`, { statusCode: res.status });
    }

    const raw = await res.json().catch(() => {
      throw new ProviderProtocolError('Cohere returned malformed JSON.');
    });
    const data = normalizeOpenAICompatibleResponse(raw, this.name, modelId, () => this.makeId());
    data._routed_via = { platform: 'cohere', model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: flattenMessageContent(messages),
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      top_p: options?.top_p,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
      stream: true,
      stream_options: options?.stream_options,
    };

    const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
      method: 'POST',
      signal: options?.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new ProviderError(`Cohere API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`, { statusCode: res.status });
    }

    const reader = res.body?.getReader();
    if (!reader) throw new ProviderProtocolError('Cohere returned no streaming response body.');

    const decoder = new TextDecoder();
    let buffer = '';
    let substantiveFrames = 0;
    let validFrames = 0;
    let malformedFrames = 0;
    let terminalFrames = 0;
    let sawToolCallDelta = false;
    let streamId: string | null = null;
    let streamCreated = Math.floor(Date.now() / 1000);
    const pendingChunks: ChatCompletionChunk[] = [];

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
          const data = trimmed.slice(5).trimStart();
          if (data === '[DONE]') {
            if (substantiveFrames === 0) {
              throw new ProviderProtocolError(`Cohere returned ${malformedFrames > 0 ? 'only malformed frames' : validFrames > 0 ? 'usage without completion choices' : 'an empty stream'}.`);
            }
            if (malformedFrames > 0) throw new ProviderProtocolError('Cohere returned malformed streaming data.');
            if (terminalFrames === 0) {
              yield {
                id: streamId ?? this.makeId(), object: 'chat.completion.chunk', created: streamCreated, model: modelId,
                choices: [{ index: 0, delta: {}, finish_reason: sawToolCallDelta ? 'tool_calls' : 'stop' }],
              };
            }
            return;
          }
          try {
            const chunk = JSON.parse(data) as unknown;
            if (!isOpenAIStreamChunk(chunk)) {
              malformedFrames++;
              continue;
            }
            validFrames++;
            streamId ??= typeof chunk.id === 'string' && chunk.id ? chunk.id : this.makeId();
            streamCreated = typeof chunk.created === 'number' && Number.isFinite(chunk.created) && chunk.created >= 0 ? chunk.created : streamCreated;
            if (chunk.choices.some(choice => choice.finish_reason !== null && choice.finish_reason !== undefined)) terminalFrames++;
            if (chunk.choices.some(choice => (choice.delta?.tool_calls?.length ?? 0) > 0)) sawToolCallDelta = true;
            const substantive = hasSubstantiveOpenAIStreamDelta(chunk);
            if (!substantiveFrames && !substantive) {
              pendingChunks.push(chunk);
              continue;
            }
            if (!substantiveFrames) {
              for (const pending of pendingChunks) yield pending;
            }
            if (substantive) substantiveFrames++;
            yield chunk;
          } catch {
            // Tolerate one corrupt frame if the stream recovers.
            malformedFrames++;
          }
        }
      }
      if (substantiveFrames === 0) {
        throw new ProviderProtocolError(`Cohere returned ${malformedFrames > 0 ? 'only malformed frames' : validFrames > 0 ? 'usage without completion choices' : 'an empty stream'}.`);
      }
      if (malformedFrames > 0) throw new ProviderProtocolError('Cohere returned malformed streaming data.');
      if (terminalFrames === 0) throw new ProviderProtocolError('Cohere returned a truncated completion stream.');
    } finally {
      try { await reader.cancel(); } catch { /* body already closed */ }
    }
  }

  async validateKey(apiKey: string, signal?: AbortSignal): Promise<boolean> {
    // Transport errors propagate — health.ts marks status='error' without
    // counting toward auto-disable. Only confirmed 401/403 disables a key.
    const res = await this.fetchWithTimeout(`${API_BASE}/models`, {
      method: 'GET',
      signal,
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 10000);
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      return false;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ProviderError(`Cohere validation endpoint returned HTTP ${res.status}.`, { statusCode: res.status, retryable: true });
    }
    await res.body?.cancel().catch(() => {});
    return true;
  }
}
