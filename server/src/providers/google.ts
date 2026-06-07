import crypto from 'crypto';
import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
  TokenUsage,
} from '@llmharbor/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';
import { contentToString } from '../lib/content.js';
import { getDb } from '../db/index.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const CODE_ASSIST_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
];
const LOAD_CODE_ASSIST_ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.googleapis.com',
];
const CODE_ASSIST_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'antigravity/1.15.8',
  'X-Goog-Api-Client': 'google-cloud-sdk vscode',
};
const ANTIGRAVITY_SYSTEM_INSTRUCTION = 'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**';
const codeAssistSessionIds = new Map<string, string>();

interface GeminiPart {
  text?: string;
  thoughtSignature?: string;
  functionCall?: {
    id?: string;
    name?: string;
    args?: unknown;
  };
  functionResponse?: {
    id?: string;
    name?: string;
    response?: unknown;
  };
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface CodeAssistResponse {
  traceId?: string;
  response?: GeminiResponse;
}

function isOAuthGoogleRequest(options?: CompletionOptions): boolean {
  return options?.oauth?.provider === 'antigravity'
    || options?.oauth?.provider === 'google-oauth';
}

function codeAssistPlatform() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 2 : 1;
  if (process.platform === 'linux') return process.arch === 'arm64' ? 4 : 3;
  if (process.platform === 'win32') return 5;
  return 0;
}

function coreClientMetadata() {
  return {
    ideType: 9,
    platform: codeAssistPlatform(),
    pluginType: 2,
  };
}

async function ensureCodeAssistProject(accessToken: string, options?: CompletionOptions): Promise<string | undefined> {
  const oauth = options?.oauth;
  if (!oauth) return undefined;
  const existing = typeof oauth.metadata?.cloudaicompanionProject === 'string'
    ? oauth.metadata.cloudaicompanionProject
    : undefined;
  if (existing) return existing;

  let lastError = '';
  for (const endpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
    const res = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers: {
        ...CODE_ASSIST_HEADERS,
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        metadata: coreClientMetadata(),
        mode: 1,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      lastError = `HTTP ${res.status}: ${errText.slice(0, 300)}`;
      continue;
    }
    const data = await res.json() as any;
    const validationRequired = Array.isArray(data.ineligibleTiers)
      ? data.ineligibleTiers.find((tier: any) => tier?.reasonCode === 'VALIDATION_REQUIRED')
      : undefined;
    if (validationRequired) {
      const message = String(validationRequired.reasonMessage ?? 'Verify your account to continue.');
      throw new Error(`Google Code Assist account verification required: ${message}`);
    }
    const projectId = data.cloudaicompanionProject?.id ?? data.cloudaicompanionProject;
    const metadata = {
      ...(oauth.metadata ?? {}),
      ...(projectId ? { cloudaicompanionProject: projectId } : {}),
      ...(data.currentTier?.id ? { currentTier: data.currentTier.id } : {}),
      ...(data.paidTier?.id ? { paidTier: data.paidTier.id } : {}),
    };
    try {
      getDb().prepare('UPDATE oauth_accounts SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), oauth.accountId);
    } catch {}
    return typeof projectId === 'string' ? projectId : undefined;
  }
  throw new Error(`Google Code Assist OAuth setup failed on all endpoints. Last error: ${lastError || 'unknown error'}`);
}

function codeAssistSessionId(options?: CompletionOptions) {
  const key = options?.oauth?.accountHint || String(options?.oauth?.accountId ?? 'oauth');
  const existing = codeAssistSessionIds.get(key);
  if (existing) return existing;
  const next = `${crypto.randomUUID()}${Date.now()}`;
  codeAssistSessionIds.set(key, next);
  return next;
}

function isCodeAssistThinkingModel(modelId: string) {
  const lower = modelId.toLowerCase();
  if (lower.includes('thinking')) return true;
  if (lower.includes('gemini')) {
    const version = lower.match(/gemini-(\d+)/);
    return Boolean(version && Number.parseInt(version[1], 10) >= 3);
  }
  return false;
}

function codeAssistHeaders(token: string, accept = 'application/json', sessionId?: string) {
  return {
    ...CODE_ASSIST_HEADERS,
    ...(accept !== 'application/json' ? { Accept: accept } : {}),
    ...(sessionId ? { 'X-Machine-Session-Id': sessionId } : {}),
    'Authorization': `Bearer ${token}`,
  };
}

function codeAssistBody(modelId: string, messages: ChatMessage[], options?: CompletionOptions, projectId?: string) {
  const { contents, systemInstruction } = toGeminiContents(messages);
  const systemParts: GeminiPart[] = [
    { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
    { text: `Please ignore the following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
  ];
  for (const part of systemInstruction?.parts ?? []) {
    if (part.text) systemParts.push({ text: part.text });
  }
  const request: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: options?.temperature,
      maxOutputTokens: options?.max_tokens,
      topP: options?.top_p,
    },
    tools: toGeminiTools(options?.tools),
    toolConfig: toGeminiToolConfig(options?.tool_choice),
    sessionId: codeAssistSessionId(options),
    systemInstruction: { role: 'user', parts: systemParts },
  };
  const requestId = crypto.randomUUID();
  return {
    project: projectId,
    model: modelId,
    request,
    userAgent: 'antigravity',
    requestType: 'agent',
    requestId: `agent-${requestId}`,
  };
}

function fromCodeAssist(data: CodeAssistResponse): GeminiResponse {
  return data.response ?? { candidates: [] };
}

async function collectCodeAssistSseResponse(res: Response): Promise<GeminiResponse> {
  const raw = await res.text();
  const merged: GeminiResponse = { candidates: [{ content: { parts: [] } }] };
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) continue;
    const frame = trimmed.slice(6);
    if (!frame || frame === '[DONE]') continue;
    let chunk: GeminiResponse;
    try {
      chunk = fromCodeAssist(JSON.parse(frame) as CodeAssistResponse);
    } catch {
      continue;
    }
    const candidate = chunk.candidates?.[0];
    if (candidate?.content?.parts?.length) {
      merged.candidates![0].content!.parts!.push(...candidate.content.parts);
    }
    if (candidate?.finishReason) merged.candidates![0].finishReason = candidate.finishReason;
    if (chunk.usageMetadata) merged.usageMetadata = chunk.usageMetadata;
  }
  return merged;
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { value: raw };
  }
}

function normalizeGeminiArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  return JSON.stringify(args ?? {});
}

function toGeminiFinishReason(finishReason?: string): string {
  const r = (finishReason ?? '').toUpperCase();
  if (!r) return 'stop';
  if (r === 'MAX_TOKENS') return 'length';
  if (r === 'SAFETY' || r === 'RECITATION' || r === 'BLOCKLIST' || r === 'PROHIBITED_CONTENT' || r === 'SPII') {
    return 'content_filter';
  }
  return 'stop';
}

// Google Gemini accepts only a subset of JSON Schema (~OpenAPI 3.0).
// Strip fields that opencode / other strict-JSON-Schema clients send but
// Google rejects with 400 "Unknown name '<field>'".
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema', '$id', '$ref', '$defs', '$comment',
  'definitions',
  'exclusiveMinimum', 'exclusiveMaximum',
  'patternProperties', 'unevaluatedProperties', 'unevaluatedItems',
  'if', 'then', 'else',
  'contentEncoding', 'contentMediaType', 'contentSchema',
  'dependentRequired', 'dependentSchemas',
  'additionalProperties',
]);

export function sanitizeForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeForGemini);
  }
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
      out[k] = sanitizeForGemini(v);
    }
    return out;
  }
  return schema;
}

function toGeminiTools(tools?: ChatToolDefinition[]): Array<{ functionDeclarations: Array<Record<string, unknown>> }> | undefined {
  if (!tools || tools.length === 0) return undefined;

  return [{
    functionDeclarations: tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: sanitizeForGemini(t.function.parameters),
    })),
  }];
}

function toGeminiToolConfig(toolChoice?: ChatToolChoice): { functionCallingConfig: Record<string, unknown> } | undefined {
  if (!toolChoice) return undefined;

  if (typeof toolChoice === 'string') {
    const mode =
      toolChoice === 'none'
        ? 'NONE'
        : toolChoice === 'required'
          ? 'ANY'
          : 'AUTO';
    return { functionCallingConfig: { mode } };
  }

  return {
    functionCallingConfig: {
      mode: 'ANY',
      allowedFunctionNames: [toolChoice.function.name],
    },
  };
}

// Translate OpenAI messages to Gemini format. Content may arrive as a string,
// null, or the OpenAI multimodal array envelope — flatten to string first so
// system/user/tool messages all surface as `parts: [{ text }]` for Gemini.
function toGeminiContents(messages: ChatMessage[]) {
  const systemMessages = messages
    .filter(m => m.role === 'system')
    .map(m => contentToString(m.content))
    .filter(s => s.length > 0);

  const toolNameByCallId = new Map<string, string>();
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) {
      toolNameByCallId.set(tc.id, tc.function.name);
    }
  }

  const contents = messages
    .filter(m => m.role !== 'system')
    .map((m): { role: 'user' | 'model'; parts: GeminiPart[] } | null => {
      if (m.role === 'assistant') {
        const parts: GeminiPart[] = [];

        const assistantText = contentToString(m.content);
        if (assistantText.length > 0) {
          parts.push({ text: assistantText });
        }

        for (const call of m.tool_calls ?? []) {
          parts.push({
            thoughtSignature: call.thought_signature,
            functionCall: {
              id: call.id,
              name: call.function.name,
              args: safeParseObject(call.function.arguments),
            },
          });
        }

        if (parts.length === 0) return null;
        return {
          role: 'model',
          parts,
        };
      }

      if (m.role === 'tool') {
        const toolCallId = m.tool_call_id;
        if (!toolCallId) return null;

        const toolName = m.name ?? toolNameByCallId.get(toolCallId) ?? 'tool';
        const response = safeParseObject(contentToString(m.content));

        return {
          role: 'user',
          parts: [{
            functionResponse: {
              id: toolCallId,
              name: toolName,
              response,
            },
          }],
        };
      }

      return {
        role: 'user',
        parts: [{ text: contentToString(m.content) }],
      };
    })
    .filter((entry): entry is { role: 'user' | 'model'; parts: GeminiPart[] } => entry !== null);

  return {
    contents,
    systemInstruction: systemMessages.length > 0
      ? { parts: [{ text: systemMessages.join('\n\n') }] }
      : undefined,
  };
}

function extractToolCalls(parts: GeminiPart[] | undefined): ChatToolCall[] {
  const calls: ChatToolCall[] = [];
  if (!parts) return calls;

  let fallbackIndex = 0;
  for (const part of parts) {
    if (!part.functionCall?.name) continue;

    const id = part.functionCall.id ?? `call_${Date.now()}_${fallbackIndex++}`;
    calls.push({
      id,
      type: 'function',
      function: {
        name: part.functionCall.name,
        arguments: normalizeGeminiArgs(part.functionCall.args),
      },
      thought_signature: part.thoughtSignature,
    });
  }

  return calls;
}

function extractText(parts: GeminiPart[] | undefined): string | null {
  if (!parts) return null;
  const text = parts
    .map(p => p.text ?? '')
    .join('');
  return text.length > 0 ? text : null;
}

export class GoogleProvider extends BaseProvider {
  readonly platform: 'google' | 'google-oauth';
  readonly name: string;

  constructor(options: { platform?: 'google' | 'google-oauth'; name?: string } = {}) {
    super();
    this.platform = options.platform ?? 'google';
    this.name = options.name ?? (this.platform === 'google-oauth' ? 'Antigravity Browser Account' : 'Google AI Studio');
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const { contents, systemInstruction } = toGeminiContents(messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: options?.temperature,
        maxOutputTokens: options?.max_tokens,
        topP: options?.top_p,
      },
      tools: toGeminiTools(options?.tools),
      toolConfig: toGeminiToolConfig(options?.tool_choice),
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    let data: GeminiResponse | undefined;
    if (isOAuthGoogleRequest(options)) {
      const projectId = await ensureCodeAssistProject(apiKey, options);
      let lastError = '';
      let codeAssistJson: CodeAssistResponse | null = null;
      const payload = codeAssistBody(modelId, messages, options, projectId);
      const sessionId = String((payload.request as Record<string, unknown>).sessionId ?? '');
      const endpointPath = isCodeAssistThinkingModel(modelId)
        ? '/v1internal:streamGenerateContent?alt=sse'
        : '/v1internal:generateContent';
      for (const endpoint of CODE_ASSIST_ENDPOINTS) {
        const res = await this.fetchWithTimeout(`${endpoint}${endpointPath}`, {
          method: 'POST',
          headers: codeAssistHeaders(apiKey, isCodeAssistThinkingModel(modelId) ? 'text/event-stream' : 'application/json', sessionId),
          body: JSON.stringify(payload),
        }, 120000);
        if (!res.ok) {
          const errText = await res.text().catch(() => res.statusText);
          lastError = `HTTP ${res.status}: ${errText.slice(0, 300)}`;
          continue;
        }
        if (isCodeAssistThinkingModel(modelId)) {
          data = await collectCodeAssistSseResponse(res);
          codeAssistJson = { response: data };
        } else {
          codeAssistJson = await res.json() as CodeAssistResponse;
          data = fromCodeAssist(codeAssistJson);
        }
        break;
      }
      if (!codeAssistJson) {
        throw new Error(`Google Code Assist OAuth error on all endpoints. Last error: ${lastError || 'unknown error'}`);
      }
    } else {
      const url = `${API_BASE}/models/${modelId}:generateContent?key=${apiKey}`;
      const res = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`Google API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
      }

      data = await res.json() as GeminiResponse;
    }
    if (!data) {
      throw new Error('Google API returned no response data');
    }
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts;
    const toolCalls = extractToolCalls(parts);
    const text = extractText(parts);

    const usage: TokenUsage = {
      prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
    };

    return {
      id: this.makeId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : toGeminiFinishReason(candidate?.finishReason),
      }],
      usage,
      _routed_via: { platform: this.platform, model: modelId },
    };
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const { contents, systemInstruction } = toGeminiContents(messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: options?.temperature,
        maxOutputTokens: options?.max_tokens,
        topP: options?.top_p,
      },
      tools: toGeminiTools(options?.tools),
      toolConfig: toGeminiToolConfig(options?.tool_choice),
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const projectId = isOAuthGoogleRequest(options) ? await ensureCodeAssistProject(apiKey, options) : undefined;
    let res: Response;
    if (isOAuthGoogleRequest(options)) {
      let lastError = '';
      let codeAssistResponse: Response | null = null;
      const payload = codeAssistBody(modelId, messages, options, projectId);
      const sessionId = String((payload.request as Record<string, unknown>).sessionId ?? '');
      for (const endpoint of CODE_ASSIST_ENDPOINTS) {
        const upstream = await this.fetchWithTimeout(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
          method: 'POST',
          headers: codeAssistHeaders(apiKey, 'text/event-stream', sessionId),
          body: JSON.stringify(payload),
        }, 120000);
        if (!upstream.ok) {
          const errText = await upstream.text().catch(() => upstream.statusText);
          lastError = `HTTP ${upstream.status}: ${errText.slice(0, 300)}`;
          continue;
        }
        codeAssistResponse = upstream;
        break;
      }
      if (!codeAssistResponse) {
        throw new Error(`Google Code Assist OAuth stream error on all endpoints. Last error: ${lastError || 'unknown error'}`);
      }
      res = codeAssistResponse;
    } else {
      const url = `${API_BASE}/models/${modelId}:streamGenerateContent?alt=sse&key=${apiKey}`;
      res = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 15000);
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Google API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    const id = this.makeId();
    let buffer = '';
    let emittedFinish = false;
    let sawToolCalls = false;

    const seenToolCallKeys = new Set<string>();

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
        if (raw === '[DONE]') {
          if (!emittedFinish) {
            emittedFinish = true;
            yield {
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: sawToolCalls ? 'tool_calls' : 'stop',
              }],
            };
          }
          return;
        }

        // Skip malformed SSE frames instead of aborting the whole stream.
        // Matches the defensive parse in openai-compat / cohere / cloudflare:
        // a single corrupt chunk shouldn't take down the rest of the response.
        let chunk: GeminiResponse;
        try {
          chunk = isOAuthGoogleRequest(options)
            ? fromCodeAssist(JSON.parse(raw) as CodeAssistResponse)
            : JSON.parse(raw) as GeminiResponse;
        } catch {
          continue;
        }
        const candidate = chunk.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];

        const text = extractText(parts);
        const toolCalls = extractToolCalls(parts).filter(call => {
          const key = `${call.id}:${call.function.name}:${call.function.arguments}`;
          if (seenToolCallKeys.has(key)) return false;
          seenToolCallKeys.add(key);
          return true;
        });

        if ((text && text.length > 0) || toolCalls.length > 0) {
          sawToolCalls = sawToolCalls || toolCalls.length > 0;
          yield {
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{
              index: 0,
              delta: {
                ...(text ? { content: text } : {}),
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: null,
            }],
          };
        }

        if (candidate?.finishReason && !emittedFinish) {
          emittedFinish = true;
          yield {
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: sawToolCalls ? 'tool_calls' : toGeminiFinishReason(candidate.finishReason),
            }],
          };
          return;
        }
      }
    }

    if (!emittedFinish) {
      yield {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: sawToolCalls ? 'tool_calls' : 'stop',
        }],
      };
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Transport errors propagate — health.ts marks status='error' without
    // counting toward auto-disable. Only confirmed 401/403 disables a key.
    const res = await this.fetchWithTimeout(
      `${API_BASE}/models?key=${apiKey}`,
      { method: 'GET' },
      10000,
    );
    return res.status !== 401 && res.status !== 403;
  }
}
