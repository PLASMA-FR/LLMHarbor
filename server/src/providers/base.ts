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

  abstract validateKey(apiKey: string): Promise<boolean>;

  async listModels(_apiKey: string): Promise<ProviderCatalogModel[]> {
    return [];
  }

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = 15000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  protected makeId(): string {
    return `chatcmpl-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  }
}
