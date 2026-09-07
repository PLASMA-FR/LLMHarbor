import { streamOpenAIResponse } from './openai-stream.js';
import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@llmharbor/shared/types.js';
import { BaseProvider, ProviderError, ProviderProtocolError, type CompletionOptions } from './base.js';
import { flattenMessageContent } from '../lib/content.js';
import { normalizeOpenAICompatibleResponse } from './openai-compat.js';

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

    yield* streamOpenAIResponse(res, this.name, modelId, () => this.makeId());
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
