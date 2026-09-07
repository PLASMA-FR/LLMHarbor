import type { ChatCompletionChunk } from '@llmharbor/shared/types.js';
import { ProviderError, ProviderProtocolError } from './base.js';
import { readSseData } from '../lib/sse.js';
import { isValidUsage } from '../lib/usage.js';

export function isOpenAIStreamChunk(value: unknown): value is ChatCompletionChunk {
  if (!value || typeof value !== 'object') return false;
  const chunk = value as Record<string, unknown>;
  if (!Array.isArray(chunk.choices)) return false;
  if (chunk.usage != null && !isValidUsage(chunk.usage)) return false;
  if (chunk.choices.length === 0) return isValidUsage(chunk.usage);
  return chunk.choices.every(choice => {
    if (!choice || typeof choice !== 'object') return false;
    const delta = choice.delta;
    if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return false;
    if (delta.content != null && typeof delta.content !== 'string') return false;
    if (delta.refusal != null && typeof delta.refusal !== 'string') return false;
    if (delta.reasoning_content != null && typeof delta.reasoning_content !== 'string') return false;
    if (delta.reasoning != null && typeof delta.reasoning !== 'string') return false;
    if (choice.finish_reason != null && typeof choice.finish_reason !== 'string') return false;
    if (delta.tool_calls === undefined) return true;
    return Array.isArray(delta.tool_calls) && delta.tool_calls.every((call: any) => {
      if (!call || !Number.isSafeInteger(call.index) || call.index < 0) return false;
      if (call.id !== undefined && typeof call.id !== 'string') return false;
      if (call.type !== undefined && call.type !== 'function') return false;
      const fn = call.function;
      return fn === undefined || (fn !== null && typeof fn === 'object'
        && (fn.name === undefined || typeof fn.name === 'string')
        && (fn.arguments === undefined || typeof fn.arguments === 'string'));
    });
  });
}

export function hasSubstantiveOpenAIStreamDelta(chunk: ChatCompletionChunk): boolean {
  return chunk.choices.some(choice => (
    Boolean(choice.delta?.content) || Boolean(choice.delta?.refusal)
    || Boolean(choice.delta?.reasoning_content) || Boolean(choice.delta?.reasoning)
    || (choice.delta?.tool_calls?.length ?? 0) > 0
    || choice.finish_reason != null
  ));
}

/** One parser and completion contract for all OpenAI-compatible adapters. */
export async function* streamOpenAIResponse(
  response: Response, providerName: string, model: string, makeId: () => string,
): AsyncGenerator<ChatCompletionChunk> {
  let id: string | undefined;
  let created = Math.floor(Date.now() / 1000);
  let substantive = false;
  let terminal = false;
  let sawTools = false;
  const pending: ChatCompletionChunk[] = [];
  let pendingChars = 0;

  for await (const data of readSseData(response)) {
    if (data === '[DONE]') {
      if (!substantive) throw new ProviderProtocolError(`${providerName} returned an empty stream or usage without completion choices.`);
      if (!terminal) yield {
        id: id!, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: {}, finish_reason: sawTools ? 'tool_calls' : 'stop' }],
      };
      return;
    }
    let raw: unknown;
    try { raw = JSON.parse(data); }
    catch { throw new ProviderProtocolError(`${providerName} returned malformed streaming data.`); }
    if (raw && typeof raw === 'object' && 'error' in raw) {
      const status = Number((raw.error as { status?: unknown } | null)?.status);
      throw new ProviderError(`${providerName} returned a streaming error.`, {
        ...(Number.isInteger(status) && status >= 400 && status <= 599 ? { statusCode: status } : {}),
        retryable: true,
      });
    }
    if (!isOpenAIStreamChunk(raw)) throw new ProviderProtocolError(`${providerName} returned malformed streaming data.`);
    if (!id) {
      id = typeof raw.id === 'string' && raw.id ? raw.id : makeId();
      if (Number.isFinite(raw.created) && raw.created >= 0) created = raw.created;
    }
    const chunk: ChatCompletionChunk = {
      ...raw, id, object: 'chat.completion.chunk', created, model,
      choices: raw.choices.map((choice, index) => ({
        ...choice,
        index: Number.isSafeInteger(choice.index) && choice.index >= 0 ? choice.index : index,
        finish_reason: choice.finish_reason ?? null,
      })),
    };
    terminal ||= chunk.choices.some(choice => choice.finish_reason !== null);
    sawTools ||= chunk.choices.some(choice => (choice.delta.tool_calls?.length ?? 0) > 0);
    if (!substantive && !hasSubstantiveOpenAIStreamDelta(chunk)) {
      pendingChars += data.length;
      if (pending.length >= 64 || pendingChars > 262_144) throw new ProviderProtocolError(`${providerName} returned too much metadata without a completion.`);
      pending.push(chunk);
      continue;
    }
    if (!substantive) {
      substantive = true;
      yield* pending;
      pending.length = 0;
    }
    yield chunk;
  }
  if (!substantive) throw new ProviderProtocolError(`${providerName} returned an empty stream or usage without completion choices.`);
  if (!terminal) throw new ProviderProtocolError(`${providerName} returned a truncated completion stream.`);
}
