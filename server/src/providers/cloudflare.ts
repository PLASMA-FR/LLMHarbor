import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@llmharbor/shared/types.js';
import { BaseProvider, ProviderError, type CompletionOptions } from './base.js';
import { contentToString } from '../lib/content.js';
import { ProviderProtocolError } from './base.js';
import { hasSubstantiveOpenAIStreamDelta, isOpenAIStreamChunk, normalizeOpenAICompatibleResponse } from './openai-compat.js';

/**
 * Cloudflare Workers AI provider.
 * API key format expected: "account_id:api_token"
 * The account_id is extracted from the key to build the URL.
 */
export class CloudflareProvider extends BaseProvider {
  readonly platform = 'cloudflare' as const;
  readonly name = 'Cloudflare Workers AI';

  private parseKey(apiKey: string): { accountId: string; token: string } {
    const sep = apiKey.indexOf(':');
    if (sep === -1) {
      throw new ProviderError('Cloudflare credential has an invalid account/token format.', {
        statusCode: 401,
        retryable: true,
        code: 'invalid_provider_credential',
      });
    }
    const accountId = apiKey.slice(0, sep).trim();
    const token = apiKey.slice(sep + 1).trim();
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(accountId) || !token) {
      throw new ProviderError('Cloudflare credential has an invalid account/token format.', {
        statusCode: 401,
        retryable: true,
        code: 'invalid_provider_credential',
      });
    }
    return { accountId, token };
  }

  // Cloudflare's OpenAI-compat endpoint:
  //   - rejects `content: null` on assistant messages that carry tool_calls,
  //     even though the OpenAI spec allows it (collapse to '');
  //   - doesn't accept the array content envelope, so flatten to string.
  private normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(m => ({ ...m, content: contentToString(m.content) }));
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      signal: options?.signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: this.normalizeMessages(messages),
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new ProviderError(`Cloudflare API error ${res.status}: ${(err as any).error?.message ?? (err as any).errors?.[0]?.message ?? res.statusText}`, { statusCode: res.status });
    }

    const raw = await res.json().catch(() => {
      throw new ProviderProtocolError('Cloudflare Workers AI returned malformed JSON.');
    });
    const data = normalizeOpenAICompatibleResponse(raw, this.name, modelId, () => this.makeId());
    data._routed_via = { platform: 'cloudflare', model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      signal: options?.signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: this.normalizeMessages(messages),
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        stream: true,
        stream_options: options?.stream_options,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new ProviderError(`Cloudflare API error ${res.status}: ${(err as any).error?.message ?? (err as any).errors?.[0]?.message ?? res.statusText}`, { statusCode: res.status });
    }

    const reader = res.body?.getReader();
    if (!reader) throw new ProviderProtocolError('Cloudflare Workers AI returned no streaming response body.');

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
              throw new ProviderProtocolError(`Cloudflare Workers AI returned ${malformedFrames > 0 ? 'only malformed frames' : validFrames > 0 ? 'usage without completion choices' : 'an empty stream'}.`);
            }
            if (malformedFrames > 0) throw new ProviderProtocolError('Cloudflare Workers AI returned malformed streaming data.');
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
        throw new ProviderProtocolError(`Cloudflare Workers AI returned ${malformedFrames > 0 ? 'only malformed frames' : validFrames > 0 ? 'usage without completion choices' : 'an empty stream'}.`);
      }
      if (malformedFrames > 0) throw new ProviderProtocolError('Cloudflare Workers AI returned malformed streaming data.');
      if (terminalFrames === 0) throw new ProviderProtocolError('Cloudflare Workers AI returned a truncated completion stream.');
    } finally {
      try { await reader.cancel(); } catch { /* body already closed */ }
    }
  }

  async validateKey(apiKey: string, signal?: AbortSignal): Promise<boolean> {
    // Transport errors propagate — health.ts marks status='error' without
    // counting toward auto-disable. Only confirmed bad/inactive tokens disable.
    const { accountId, token } = this.parseKey(apiKey);
    const res = await this.fetchWithTimeout(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      { method: 'GET', signal, headers: { 'Authorization': `Bearer ${token}` } },
      10000,
    );
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      return false;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ProviderError(`Cloudflare validation endpoint returned HTTP ${res.status}.`, { statusCode: res.status, retryable: true });
    }
    const data = await res.json().catch(() => {
      throw new ProviderProtocolError('Cloudflare validation endpoint returned malformed JSON.');
    }) as any;
    if (data.success !== true || data.result?.status !== 'active') return false;

    // Token verification alone does not validate the account id embedded in
    // LLMHarbor's `accountId:token` credential. Probe the account-scoped API so
    // a typo or an inaccessible account is not reported healthy while every
    // Workers AI request fails.
    const accountRes = await this.fetchWithTimeout(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`,
      { method: 'GET', signal, headers: { 'Authorization': `Bearer ${token}` } },
      10000,
    );
    if (accountRes.status === 401 || accountRes.status === 403 || accountRes.status === 404) {
      await accountRes.body?.cancel().catch(() => {});
      return false;
    }
    if (!accountRes.ok) {
      await accountRes.body?.cancel().catch(() => {});
      throw new ProviderError(`Cloudflare account validation returned HTTP ${accountRes.status}.`, { statusCode: accountRes.status, retryable: true });
    }
    await accountRes.body?.cancel().catch(() => {});
    return true;
  }
}
