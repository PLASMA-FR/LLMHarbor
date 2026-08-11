import crypto from 'crypto';
import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
  Platform,
} from '@llmharbor/shared/types.js';

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  /** Cancels upstream work when the downstream client disconnects. */
  signal?: AbortSignal;
  oauth?: {
    accountId: number;
    provider: string;
    accountHint?: string | null;
    metadata?: Record<string, unknown>;
  };
}

export interface ProviderCatalogModel {
  id: string;
  displayName?: string;
  contextWindow?: number | null;
  pricing?: unknown;
  raw?: unknown;
}

export class ProviderError extends Error {
  readonly statusCode: number | null;
  readonly retryable: boolean;
  readonly code: string;

  constructor(message: string, options: { statusCode?: number; retryable?: boolean; code?: string } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.statusCode = options.statusCode ?? null;
    this.retryable = options.retryable ?? isRetryableProviderStatus(this.statusCode);
    this.code = options.code ?? 'provider_error';
  }
}

export function isRetryableProviderStatus(status: number | null): boolean {
  if (status === null) return false;
  // Authentication, payment, and authorization failures are scoped to the
  // selected upstream credential/model. They must not prevent the gateway
  // from trying another configured key or provider route.
  return status === 400 || status === 401 || status === 402 || status === 403
    || status === 404 || status === 408 || status === 409
    || status === 413 || status === 425 || status === 429 || status >= 500;
}

export class ProviderProtocolError extends ProviderError {
  constructor(message: string) {
    super(message, { retryable: true, code: 'malformed_provider_response' });
    this.name = 'ProviderProtocolError';
  }
}

export abstract class BaseProvider {
  abstract readonly platform: Platform;
  abstract readonly name: string;

  abstract chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse>;

  abstract streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk>;

  abstract validateKey(apiKey: string, signal?: AbortSignal): Promise<boolean>;

  async listModels(_apiKey: string, _signal?: AbortSignal): Promise<ProviderCatalogModel[]> {
    return [];
  }

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    headersTimeoutMs = 15000,
    bodyIdleTimeoutMs = Math.max(headersTimeoutMs, 120_000),
    fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
  ): Promise<Response> {
    // Header latency and body progress are different failure modes. Keeping a
    // single short AbortSignal.timeout alive for the full response truncated
    // otherwise healthy long-running streams. Clear the header timer once a
    // response arrives, then enforce a renewable idle deadline per body read.
    const transport = new AbortController();
    const signal = init.signal
      ? AbortSignal.any([init.signal, transport.signal])
      : transport.signal;
    const headerTimer = setTimeout(() => {
      transport.abort(new DOMException('Upstream response headers timed out.', 'TimeoutError'));
    }, headersTimeoutMs);
    headerTimer.unref?.();

    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal });
    } finally {
      clearTimeout(headerTimer);
    }

    // Test doubles and body-less responses need no wrapping.
    if (!response.body || typeof response.body.getReader !== 'function') return response;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            reader.read(),
            new Promise<never>((_resolve, reject) => {
              idleTimer = setTimeout(() => {
                const error = new DOMException('Upstream response body timed out waiting for data.', 'TimeoutError');
                transport.abort(error);
                reject(error);
              }, bodyIdleTimeoutMs);
              idleTimer.unref?.();
            }),
          ]);
          if (result.done) controller.close();
          else controller.enqueue(result.value);
        } catch (error) {
          controller.error(error);
          try { await reader.cancel(error); } catch {}
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }
      },
      async cancel(reason) {
        transport.abort(reason);
        try { await reader.cancel(reason); } catch {}
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  protected makeId(): string {
    return `chatcmpl-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  }
}
