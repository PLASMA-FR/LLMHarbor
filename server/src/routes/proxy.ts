import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage } from '@llmharbor/shared/types.js';
import { routeRequestAsync, recordRateLimitHit, recordRouteFailure, recordSuccess, RoutePreparationError, type RouteResult } from '../services/router.js';
import { commitProviderRequestReservation, recordRequest, recordTokens, releaseProviderCapacity, setCooldown, getNextCooldownDuration } from '../services/ratelimit.js';
import { authenticateClientApiKey, checkClientApiKeyLimits, commitClientApiKeyRequestReservation, getDashboardClientApiKey, getDb, recordClientApiKeyRequest, recordClientApiKeyTokens, releaseClientApiKeyCapacity, reserveClientApiKeyCapacity, type AuthenticatedClientApiKey } from '../db/index.js';
import { contentToString } from '../lib/content.js';
import { forceRefreshOAuthAccount } from '../services/oauth-refresh.js';
import { getClientEndpointBindingDenial, getClientModelAccessDenial, isClientLegacyEndpointPlatformAllowed, isClientRouteAllowed, localApiRouteDenied, type ClientAccessDenial } from '../services/accessPolicy.js';
import { parseLocalModelId, toLocalModelId } from '../services/localModelIds.js';
import { redactSensitive } from '../lib/errors.js';
import { ProviderError, ProviderProtocolError } from '../providers/base.js';
import { hasSubstantiveOpenAIStreamDelta } from '../providers/openai-compat.js';
import { hasProvider } from '../providers/index.js';

export const proxyRouter = Router({ mergeParams: true });

// Virtual "auto" model. Clients like Hermes require a non-empty `model` field
// on every request, but llmharbor's whole point is to pick the model itself.
// Requesting this id means "let the router decide" — identical to omitting
// `model` entirely.
const AUTO_MODEL_ID = 'auto';

function isAutoModel(modelId: string | undefined): boolean {
  return modelId === AUTO_MODEL_ID;
}

function sendAccessDenied(res: Response, denial: ClientAccessDenial) {
  res.status(denial.status).json({
    error: {
      message: denial.message,
      type: 'forbidden',
      code: denial.code,
    },
  });
}

function authenticateProxyClient(req: Request, res: Response): AuthenticatedClientApiKey | null {
  if (res.locals.llmharborDashboardProxy === true) {
    const selectedIdHeader = req.get('x-llmharbor-client-key-id');
    const selectedId = selectedIdHeader === undefined ? undefined : Number(selectedIdHeader);
    if (selectedId !== undefined && (!Number.isSafeInteger(selectedId) || selectedId <= 0)) {
      res.status(400).json({
        error: { message: 'X-LLMHarbor-Client-Key-Id must identify an enabled local client API key.', type: 'invalid_request_error', code: 'invalid_playground_client_key' },
      });
      return null;
    }
    const dashboardKey = getDashboardClientApiKey(selectedId);
    if (dashboardKey) return dashboardKey;
    res.status(selectedId === undefined ? 503 : 404).json({
      error: { message: selectedId === undefined ? 'No enabled local client API key is available for the Playground.' : 'The selected local client API key is unavailable or disabled.', type: 'routing_error', code: 'playground_client_key_unavailable' },
    });
    return null;
  }
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const clientKey = token ? authenticateClientApiKey(token) : null;
  if (!clientKey) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return null;
  }
  return clientKey;
}

function requestedCompatibilityEndpointSlug(req: Request): string | null {
  const match = req.originalUrl.match(/^\/e\/([^/]+)\/v1(?:\/|$)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function enforceEndpointBinding(req: Request, res: Response, clientKey: AuthenticatedClientApiKey): boolean {
  // The dashboard control-plane proxy deliberately selects a key's policy but
  // is not itself one of the legacy path-bound listeners.
  if (res.locals.llmharborDashboardProxy === true) {
    res.setHeader('X-LLMHarbor-Client-Key-Id', String(clientKey.id));
    return true;
  }
  const denial = getClientEndpointBindingDenial(clientKey, requestedCompatibilityEndpointSlug(req));
  if (!denial) return true;
  sendAccessDenied(res, denial);
  return false;
}

// Sticky sessions: track which model served each "session"
// Key: hash of first user message → model_db_id
// This prevents model switching mid-conversation which causes hallucination
const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 min session TTL

function getSessionKey(clientApiKeyId: number, messages: ChatMessage[]): string {
  // Use the first user message as session identifier — clients like Hermes
  // re-send the full conversation each turn, so the first user message is
  // stable across turns. Hash the FULL message (not a 100-char slice) so
  // distinct conversations with identical openings don't collide.
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return '';
  const firstUserText = contentToString(firstUser.content);
  if (!firstUserText) return '';
  const firstSystemText = contentToString(messages.find(m => m.role === 'system')?.content ?? '');
  const hash = crypto.createHash('sha256').update(firstSystemText).update('\0').update(firstUserText).digest('hex');
  return `${clientApiKeyId}:${hash}`;
}

function getStickyModel(clientApiKeyId: number, messages: ChatMessage[]): number | undefined {
  // Only apply sticky for multi-turn (has assistant messages = continuation)
  const hasAssistant = messages.some(m => m.role === 'assistant');
  if (!hasAssistant) return undefined;

  const key = getSessionKey(clientApiKeyId, messages);
  if (!key) return undefined;

  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelDbId;
}

function setStickyModel(clientApiKeyId: number, messages: ChatMessage[], modelDbId: number) {
  const key = getSessionKey(clientApiKeyId, messages);
  if (!key) return;
  stickySessionMap.delete(key);
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });

  // Cleanup expired entries and enforce a hard bound even when every entry is
  // active. Map insertion order makes the first entry the least recently set.
  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }
    while (stickySessionMap.size > 500) {
      const oldest = stickySessionMap.keys().next().value as string | undefined;
      if (!oldest) break;
      stickySessionMap.delete(oldest);
    }
  }
}

// OpenAI-compatible /models endpoint (used by Hermes for metadata)
proxyRouter.get('/models', (req: Request, res: Response) => {
  const clientKey = authenticateProxyClient(req, res);
  if (!clientKey) return;
  if (!enforceEndpointBinding(req, res, clientKey)) return;

  if (!isClientRouteAllowed(clientKey.id, 'v1.models')) {
    sendAccessDenied(res, localApiRouteDenied('v1.models'));
    return;
  }

  const db = getDb();
  const models = db.prepare(`
    SELECT m.id, m.platform, m.model_id, m.display_name, m.context_window
      FROM models m
      JOIN fallback_config fc ON fc.model_db_id = m.id AND fc.enabled = 1
     WHERE m.enabled = 1
       AND EXISTS (
         SELECT 1
           FROM api_keys ak
           LEFT JOIN oauth_accounts oa ON oa.id = ak.oauth_account_id
          WHERE ak.platform = m.platform
            AND ak.enabled = 1
            AND (
              ak.status IN ('healthy', 'unknown')
              OR (ak.source = 'oauth' AND ak.status NOT IN ('invalid', 'error'))
            )
            AND (
              ak.source != 'oauth'
              OR (
                oa.enabled = 1
                AND COALESCE(json_extract(oa.metadata_json, '$.oauthNeedsReconnect'), 0) != 1
                AND (
                  NOT EXISTS (SELECT 1 FROM oauth_account_models known WHERE known.oauth_account_id = ak.oauth_account_id)
                  OR EXISTS (
                    SELECT 1 FROM oauth_account_models eligible
                     WHERE eligible.oauth_account_id = ak.oauth_account_id
                       AND eligible.platform = m.platform
                       AND eligible.model_id = m.model_id
                       AND eligible.supported = 1
                  )
                )
              )
            )
       )
     ORDER BY m.intelligence_rank
  `).all() as any[];
  // The catalog is configuration-level: transient cooldown/quota exhaustion
  // does not make models disappear between SDK refreshes. It does, however,
  // match routing on fallback/model/provider/key/account eligibility.
  const allowedModels = models.filter(m => (
    hasProvider(m.platform)
    && isClientLegacyEndpointPlatformAllowed(clientKey, m.platform)
    && getClientModelAccessDenial(clientKey.id, {
      id: m.id,
      platform: m.platform,
      modelId: m.model_id,
      displayName: m.display_name,
    }) === null
  ));

  res.json({
    object: 'list',
    data: [
      ...(allowedModels.length > 0 ? [{
        id: AUTO_MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'llmharbor',
        name: 'Auto (router picks the best available model)',
        context_window: null,
      }] : []),
      ...allowedModels.map(m => ({
        id: toLocalModelId(m.platform, m.model_id),
        object: 'model',
        created: 0,
        owned_by: m.platform,
        name: m.display_name,
        context_window: m.context_window,
      })),
    ],
  });
});

const MIN_RETRY_BUDGET = 20;
const MAX_RETRY_BUDGET = 128;
const MAX_CREDENTIAL_FAILURES_PER_ROUTE = 16;
const MAX_FALLBACK_RETRY_WINDOW_MS = 3 * 60 * 1000;

export function createAttemptDeadlineSignal(
  parent: AbortSignal,
  deadlineAt: number,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const abortFromParent = () => controller.abort(parent.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    parent.removeEventListener('abort', abortFromParent);
  };
  if (parent.aborted) {
    abortFromParent();
  } else {
    parent.addEventListener('abort', abortFromParent, { once: true });
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    timer = setTimeout(() => {
      controller.abort(new DOMException('Upstream attempt timed out at the gateway fallback deadline.', 'TimeoutError'));
    }, remainingMs);
    timer.unref?.();
  }
  controller.signal.addEventListener('abort', cleanup, { once: true });
  return { signal: controller.signal, cancel: cleanup };
}

function retryBudgetForConfiguredRoutes(): number {
  try {
    const row = getDb().prepare(`
      SELECT COUNT(*) AS routes
        FROM fallback_config fc
        JOIN models m ON m.id = fc.model_db_id
       WHERE fc.enabled = 1 AND m.enabled = 1
    `).get() as { routes: number };
    // Each route gets a bounded credential sample. OAuth credentials may use
    // one extra outer iteration for an early-401 refresh, hence the factor 2.
    // Round-robin state advances so later client requests sample remaining
    // bulk-imported keys without one request issuing thousands of upstream calls.
    const attempts = Number(row.routes) * MAX_CREDENTIAL_FAILURES_PER_ROUTE * 2 + 1;
    return Math.min(MAX_RETRY_BUDGET, Math.max(MIN_RETRY_BUDGET, attempts));
  } catch {
    return MIN_RETRY_BUDGET;
  }
}

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
  thought_signature: z.string().optional(),
});

// Clients like opencode / continue.dev send text in OpenAI's typed content
// envelope. Vision/audio capability routing is not implemented, so reject
// those blocks explicitly instead of silently deleting prompt content.
const contentBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).passthrough();
const contentSchema = z.union([z.string(), z.array(contentBlockSchema)]);

function hasNonEmptyContent(content: unknown): boolean {
  if (typeof content === 'string') return content.length > 0;
  if (Array.isArray(content)) return content.length > 0;
  return false;
}

const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: contentSchema,
  name: z.string().optional(),
});

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: contentSchema,
  name: z.string().optional(),
});

const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([contentSchema, z.null()]).optional(),
  name: z.string().optional(),
  refusal: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
});

function isEmptyAssistantStub(message: { role: string; content?: unknown; refusal?: string; tool_calls?: unknown[] }): boolean {
  return message.role === 'assistant'
    && !hasNonEmptyContent(message.content)
    && !message.refusal
    && (message.tool_calls?.length ?? 0) === 0;
}

const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: contentSchema,
  tool_call_id: z.string().min(1),
  name: z.string().optional(),
});

const toolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

const toolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().min(1),
    }),
  }),
]);

const chatCompletionSchema = z.object({
  messages: z.array(z.union([
    systemMessageSchema,
    userMessageSchema,
    assistantMessageSchema,
    toolMessageSchema,
  ])).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  tool_choice: toolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
  stream_options: z.object({
    include_usage: z.boolean().optional(),
  }).strict().optional(),
}).superRefine((request, context) => {
  if (request.stream_options !== undefined && request.stream !== true) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stream_options'],
      message: 'stream_options requires stream=true',
    });
  }
});

export function isRetryableError(err: any): boolean {
  if (err instanceof ProviderError) return err.retryable;
  if (typeof err?.retryable === 'boolean') return err.retryable;
  const chain: any[] = [];
  const seen = new Set<unknown>();
  let current: any = err;
  while (current && !seen.has(current) && chain.length < 6) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  const msg = chain.map(item => String(item?.message ?? '')).join(' ').toLowerCase();
  const codes = chain.map(item => String(item?.code ?? '').toUpperCase());
  if (codes.some(code => [
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE',
    'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED',
  ].includes(code))) return true;
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error')
    // 413: this model's payload limit is too small for the request, but another
    // provider in the fallback chain may have a larger limit. Same reasoning as 503.
    || msg.includes('413') || msg.includes('payload too large') || msg.includes('request body too large')
    || msg.includes('request entity too large') || msg.includes('content too large')
    // 404: model deprecated/removed upstream (e.g. OpenRouter's "no endpoints found"
    // for a model that's been pulled). Rotate to the next model in the chain —
    // setCooldown + the health checker will avoid this model on subsequent requests.
    || msg.includes('404') || msg.includes('not found') || msg.includes('no endpoints found')
    // 400: one provider may reject parameters another accepts (e.g. max_tokens
    // limits, unsupported params). The matching pattern is "api error 400"
    // which comes from the OpenAI-compat provider's error formatting, not
    // a bare "400" which is deliberately non-retryable for validation errors.
    || msg.includes('api error 400');
}

function retrySkipId(error: unknown, route: RouteResult): string {
  const exact = `${route.platform}:${route.modelId}:${route.keyId}`;
  const credentialWide = `${route.platform}:*:${route.keyId}`;
  const routeWide = `${route.platform}:${route.modelId}:*`;
  if (error instanceof ProviderProtocolError) return routeWide;
  const status = error instanceof ProviderError ? error.statusCode : null;
  // Auth/payment/quota responses are credential-scoped. Model capability,
  // protocol, transport, and provider failures will repeat for every key, so
  // skip the route immediately and preserve retry budget for later models.
  if (status === 401 || status === 402 || status === 403) return credentialWide;
  if (status === 429) return exact;
  if (status !== null && (status === 400 || status === 404 || status === 408 || status === 409 || status === 413 || status === 425 || status >= 500)) {
    return routeWide;
  }
  const message = String((error as any)?.message ?? '').toLowerCase();
  if (/\b(400|404|408|409|413|425|5\d\d)\b/.test(message)
    || /timeout|timed out|econn|enotfound|eai_again|fetch failed|malformed|protocol/.test(message)) {
    return routeWide;
  }
  return exact;
}

function shouldOpenRouteFailureCircuit(error: unknown): boolean {
  if (error instanceof ProviderProtocolError || isTimeoutFailure(error)) return true;
  if (error instanceof ProviderError) {
    return error.statusCode === 404 || error.statusCode === 408 || (error.statusCode !== null && error.statusCode >= 500);
  }
  let current: any = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const code = String(current.code ?? '').toUpperCase();
    if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET'].includes(code)) return true;
    current = current.cause;
  }
  return false;
}

function sanitizeProviderErrorMessage(value: unknown): string {
  return redactSensitive(value);
}

function safeProviderFailureDescription(error: unknown): string {
  if (error instanceof ProviderProtocolError) return 'Upstream provider returned a malformed response.';
  if (isTimeoutFailure(error)) return 'Upstream provider request timed out.';
  if (error instanceof ProviderError) {
    if (error.statusCode !== null) return `Upstream provider returned HTTP ${error.statusCode}.`;
    return `Upstream provider request failed (${error.code}).`;
  }
  let current: any = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const code = typeof current.code === 'string' ? current.code.toUpperCase() : '';
    if (code) return `Upstream provider transport failed (${code}).`;
    current = current.cause;
  }
  return 'Upstream provider request failed.';
}

export function isRateLimitFailure(error: unknown): boolean {
  if (error instanceof ProviderError && error.statusCode === 429) return true;
  return /(429|rate limit|too many requests|quota|resource_exhausted)/i.test(String((error as any)?.message ?? error));
}

function isTimeoutFailure(error: unknown): boolean {
  const name = String((error as any)?.name ?? '');
  const message = String((error as any)?.message ?? error);
  return name === 'TimeoutError' || /\b(timeout|timed out|etimedout)\b/i.test(message);
}

function isProviderCredentialInvalid(error: unknown): boolean {
  return error instanceof ProviderError && error.statusCode === 401;
}

function markProviderCredentialInvalid(keyId: number): void {
  try {
    getDb().prepare("UPDATE api_keys SET status = 'invalid', last_checked_at = datetime('now') WHERE id = ?")
      .run(keyId);
  } catch (error) {
    console.error('Failed to mark rejected provider credential invalid:', redactSensitive(error));
  }
}

interface RetryFailureSummary {
  rateLimit: boolean;
  timeout: boolean;
  other: boolean;
}

function recordRetryFailure(summary: RetryFailureSummary, error: unknown): void {
  if (isRateLimitFailure(error)) summary.rateLimit = true;
  else if (isTimeoutFailure(error)) summary.timeout = true;
  else summary.other = true;
}

function sendFallbackExhausted(
  res: Response,
  lastError: unknown,
  summary: RetryFailureSummary,
  attempts: number,
): void {
  if (attempts > 0) res.setHeader('X-Fallback-Attempts', String(attempts));
  if (!summary.other && !summary.timeout && summary.rateLimit) {
    res.status(429).json({
      error: {
        message: 'All eligible routes are rate limited or out of quota.',
        type: 'rate_limit_error',
        code: 'route_rate_limit_exhausted',
        request_id: String(res.locals.requestId ?? 'unknown'),
      },
    });
    return;
  }
  if (!summary.other && summary.timeout && !summary.rateLimit) {
    res.status(504).json({
      error: {
        message: 'All eligible upstream routes timed out.',
        type: 'provider_error',
        code: 'upstream_timeout',
        request_id: String(res.locals.requestId ?? 'unknown'),
      },
    });
    return;
  }
  res.status(502).json({
    error: {
      message: 'All eligible provider routes failed.',
      type: 'provider_error',
      code: 'provider_fallback_exhausted',
      request_id: String(res.locals.requestId ?? 'unknown'),
    },
  });
}

function isValidStreamChunk(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const choices = (value as any).choices;
  if (!Array.isArray(choices)) return false;
  if (choices.length === 0) {
    const usage = (value as any).usage;
    return usage !== null && typeof usage === 'object'
      && ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(field => (
        typeof usage[field] === 'number' && Number.isFinite(usage[field]) && usage[field] >= 0
      ));
  }
  return choices.every((choice: unknown) => {
    if (choice === null || typeof choice !== 'object') return false;
    const delta = (choice as any).delta;
    if (delta === null || typeof delta !== 'object') return false;
    if (delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string') return false;
    if (delta.refusal !== undefined && delta.refusal !== null && typeof delta.refusal !== 'string') return false;
    if (delta.tool_calls === undefined) return true;
    return Array.isArray(delta.tool_calls) && delta.tool_calls.every((call: unknown) => (
      call !== null && typeof call === 'object'
      && Number.isInteger((call as any).index) && (call as any).index >= 0
    ));
  });
}

function writeResponseChunk(res: Response, data: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || res.destroyed || res.writableEnded) {
    return Promise.reject(new Error('Downstream client disconnected.'));
  }
  if (res.write(data)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('Downstream client disconnected.')); };
    const onAbort = () => { cleanup(); reject(new Error('Downstream client disconnected.')); };
    res.once('drain', onDrain);
    res.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function downstreamAbortController(req: Request, res: Response): AbortController {
  const controller = new AbortController();
  const cleanup = () => {
    req.off('aborted', abort);
    res.off('close', close);
    res.off('finish', cleanup);
  };
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new Error('Downstream client disconnected.'));
    cleanup();
  };
  const close = () => {
    if (!res.writableEnded) abort();
    else cleanup();
  };
  req.once('aborted', abort);
  res.once('close', close);
  res.once('finish', cleanup);
  return controller;
}

proxyRouter.post('/chat/completions', async (req: Request, res: Response) => {
  const start = Date.now();
  const analyticsRequestId = String(res.locals.requestId ?? crypto.randomUUID());

  // Authenticate with any enabled personal API key for every proxy request,
  // including loopback callers. Browser pages can reach localhost, so socket
  // locality is not a reliable authorization boundary.
  const clientKey = authenticateProxyClient(req, res);
  if (!clientKey) return;
  if (!enforceEndpointBinding(req, res, clientKey)) return;

  if (!isClientRouteAllowed(clientKey.id, 'v1.chat.completions')) {
    sendAccessDenied(res, localApiRouteDenied('v1.chat.completions'));
    return;
  }

  // Validate request
  const parsed = chatCompletionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const { model: requestedModel, temperature, max_tokens, top_p, stream, tools, tool_choice, parallel_tool_calls, stream_options } = parsed.data;
  const requestMessages = parsed.data.messages.filter(m => !isEmptyAssistantStub(m));
  if (requestMessages.length === 0) {
    res.status(400).json({
      error: {
        message: 'Invalid request: messages must include at least one non-empty message',
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const messages: ChatMessage[] = requestMessages.map((m): ChatMessage => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content ?? null,
        ...(m.name ? { name: m.name } : {}),
        ...(m.refusal ? { refusal: m.refusal } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls.map(tc => ({
          id: tc.id,
          type: tc.type,
          function: tc.function,
          thought_signature: tc.thought_signature,
        })) } : {}),
      };
    }

    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.tool_call_id,
        ...(m.name ? { name: m.name } : {}),
      };
    }

    return {
      role: m.role,
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
    };
  });

  // Token estimation is intentionally a heuristic (~4 chars per token). Used
  // for routing decisions (skip a model whose budget is too small) and for
  // streaming bookkeeping where the provider doesn't echo a final usage count.
  // Non-streaming requests reconcile against the provider's real `usage` block
  // (see line ~340). Streaming will drift from real consumption — accepted
  // tradeoff because per-request usage isn't always returned mid-stream.
  const inputCharacters = messages.reduce((sum, message) => {
    const toolCallText = message.tool_calls?.map(call => (
      `${call.id}${call.function.name}${call.function.arguments}`
    )).join('') ?? '';
    return sum
      + contentToString(message.content).length
      + (message.name?.length ?? 0)
      + (message.tool_call_id?.length ?? 0)
      + toolCallText.length;
  }, 0) + (tools ? JSON.stringify(tools).length : 0) + (tool_choice ? JSON.stringify(tool_choice).length : 0);
  const estimatedInputTokens = Math.ceil(inputCharacters / 4);
  const estimatedTotal = estimatedInputTokens + (max_tokens ?? 1000);

  const clientLimitBlock = checkClientApiKeyLimits(clientKey, estimatedTotal);
  if (clientLimitBlock) {
    res.setHeader('Retry-After', String(clientLimitBlock.retryAfterSeconds));
    res.status(429).json({
      error: {
        message: clientLimitBlock.message,
        type: 'rate_limit_error',
        code: 'client_key_limit_exceeded',
        metric: clientLimitBlock.metric,
        limit: clientLimitBlock.limit,
        used: clientLimitBlock.used,
        requested: clientLimitBlock.requested,
      },
    });
    return;
  }

  const downstream = downstreamAbortController(req, res);
  const needsFullToolSemantics = Boolean(
    (tools?.length ?? 0) > 0
    || messages.some(message => message.role === 'tool' || (message.tool_calls?.length ?? 0) > 0),
  );

  // Explicit `model` field is honored first. If the catalog has no enabled row
  // matching the requested id, return 400. Once the requested model's available
  // keys are exhausted by retryable upstream failures, though, resume the normal
  // fallback chain so transient provider/OAuth outages don't fail the whole
  // request when other configured models can answer.
  // Sticky-session is the fallback when no `model` field was sent at all.
  let preferredModel: number | undefined;
  const explicitModelRequested = Boolean(requestedModel && !isAutoModel(requestedModel));
  let strictPreferredModel = explicitModelRequested;
  if (isAutoModel(requestedModel)) {
    // Explicit "auto" → behave exactly like an omitted model field.
    preferredModel = getStickyModel(clientKey.id, messages);
  } else if (requestedModel) {
    const db = getDb();
    const localModel = parseLocalModelId(requestedModel);
    const routeablePredicate = `
         m.enabled = 1
         AND EXISTS (
           SELECT 1 FROM fallback_config fc
            WHERE fc.model_db_id = m.id AND fc.enabled = 1
         )
         AND EXISTS (
           SELECT 1 FROM api_keys ak
           LEFT JOIN oauth_accounts oa ON oa.id = ak.oauth_account_id
            WHERE ak.platform = m.platform
              AND ak.enabled = 1
              AND (
                ak.status IN ('healthy', 'unknown')
                OR (ak.source = 'oauth' AND ak.status NOT IN ('invalid', 'error'))
              )
              AND (
                ak.source != 'oauth'
                OR (
                  oa.enabled = 1
                  AND COALESCE(json_extract(oa.metadata_json, '$.oauthNeedsReconnect'), 0) != 1
                  AND (
                    NOT EXISTS (SELECT 1 FROM oauth_account_models known WHERE known.oauth_account_id = ak.oauth_account_id)
                    OR EXISTS (
                      SELECT 1 FROM oauth_account_models eligible
                       WHERE eligible.oauth_account_id = ak.oauth_account_id
                         AND eligible.platform = m.platform
                         AND eligible.model_id = m.model_id
                         AND eligible.supported = 1
                    )
                  )
                )
              )
              ${needsFullToolSemantics ? "AND NOT (ak.source = 'oauth' AND oa.provider = 'openai')" : ''}
         )`;
    const routeableOrder = `ORDER BY CASE WHEN m.display_name LIKE '%browser account%' THEN 0 ELSE 1 END, m.intelligence_rank ASC, m.id ASC LIMIT 1`;
    const enabledByLocalIdCandidate = localModel ? db.prepare(`
      SELECT m.id, m.platform, m.model_id, m.display_name
        FROM models m
       WHERE m.platform = ?
         AND m.model_id = ?
         AND ${routeablePredicate}
       ${routeableOrder}
    `).get(localModel.platform, localModel.modelId) as { id: number; platform: string; model_id: string; display_name: string } | undefined : undefined;
    const enabledByLocalId = enabledByLocalIdCandidate && hasProvider(enabledByLocalIdCandidate.platform)
      ? enabledByLocalIdCandidate
      : undefined;
    const genericCandidates = enabledByLocalId ? [] : db.prepare(`
      SELECT m.id, m.platform, m.model_id, m.display_name
        FROM models m
       WHERE m.model_id = ?
         AND ${routeablePredicate}
       ORDER BY CASE WHEN m.display_name LIKE '%browser account%' THEN 0 ELSE 1 END, m.intelligence_rank ASC, m.id ASC
    `).all(requestedModel) as Array<{ id: number; platform: string; model_id: string; display_name: string }>;
    const routeableGenericCandidates = genericCandidates.filter(candidate => hasProvider(candidate.platform));
    const candidateDenial = (candidate: { id: number; platform: string; model_id: string; display_name: string }): ClientAccessDenial | null => {
      if (!isClientLegacyEndpointPlatformAllowed(clientKey, candidate.platform)) {
        return {
          status: 403,
          code: 'provider_endpoint_access_denied',
          message: `This local API key is not allowed to use the ${candidate.platform} provider endpoint.`,
        };
      }
      return getClientModelAccessDenial(clientKey.id, {
        id: candidate.id,
        platform: candidate.platform,
        modelId: candidate.model_id,
        displayName: candidate.display_name,
      });
    };
    const enabled = enabledByLocalId
      ?? routeableGenericCandidates.find(candidate => candidateDenial(candidate) === null);
    if (enabled) {
      const denial = candidateDenial(enabled);
      if (denial) {
        sendAccessDenied(res, denial);
        return;
      }
      preferredModel = enabled.id;
    } else if (routeableGenericCandidates.length > 0) {
      sendAccessDenied(res, candidateDenial(routeableGenericCandidates[0])!);
      return;
    } else {
      const disabledByLocalId = localModel ? db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(localModel.platform, localModel.modelId) as { id: number } | undefined : undefined;
      const disabled = disabledByLocalId ?? db.prepare('SELECT id FROM models WHERE model_id = ?').get(requestedModel) as { id: number } | undefined;
      const reason = disabled ? 'is disabled or has no routeable key' : 'is not in the catalog';
      res.status(400).json({
        error: {
          message: `Model '${requestedModel}' ${reason}. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available provider/model list.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      });
      return;
    }
  } else {
    preferredModel = getStickyModel(clientKey.id, messages);
  }

  // Retry loop: on 429/rate limit, skip that model+key and try the next one
  const skipKeys = new Set<string>();
  const credentialFailuresByRoute = new Map<string, number>();
  const oauthAccountsRefreshedAfter401 = new Set<number>();
  let lastError: any = null;
  let lastAttemptRoute: RouteResult | null = null;
  let reachedUpstream = false;
  const retryFailures: RetryFailureSummary = { rateLimit: false, timeout: false, other: false };
  const addRetrySkip = (error: unknown, route: RouteResult, forceCredentialWide = false) => {
    const routeId = `${route.platform}:${route.modelId}`;
    const routeWide = `${routeId}:*`;
    const skipId = forceCredentialWide ? `${route.platform}:*:${route.keyId}` : retrySkipId(error, route);
    skipKeys.add(skipId);
    if (skipId === routeWide && shouldOpenRouteFailureCircuit(error)) recordRouteFailure(route.modelDbId);
    if (skipId !== routeWide) {
      const failures = (credentialFailuresByRoute.get(routeId) ?? 0) + 1;
      credentialFailuresByRoute.set(routeId, failures);
      if (failures >= MAX_CREDENTIAL_FAILURES_PER_ROUTE) skipKeys.add(routeWide);
    }
  };
  const accessFilter = (model: { id: number; platform: string; modelId: string; displayName: string }) => (
    isClientLegacyEndpointPlatformAllowed(clientKey, model.platform)
    && getClientModelAccessDenial(clientKey.id, model) === null
  );
  // ChatGPT's private Responses surface cannot faithfully carry OpenAI tool
  // result messages/tool controls. Do not silently corrupt those requests;
  // API-key routes and other OAuth providers remain eligible.
  const keyAccessFilter = needsFullToolSemantics
    ? (key: { oauthProvider?: string | null }) => key.oauthProvider !== 'openai'
    : undefined;
  const clientCapacityReservationId = reserveClientApiKeyCapacity(clientKey.id, estimatedTotal);
  recordClientApiKeyRequest(clientKey.id);
  commitClientApiKeyRequestReservation(clientCapacityReservationId);
  let clientCapacitySettled = false;
  const settleClientCapacity = (actualTokens = 0) => {
    if (clientCapacitySettled) return;
    clientCapacitySettled = true;
    try {
      if (actualTokens > 0) recordClientApiKeyTokens(clientKey.id, actualTokens);
    } catch (error) {
      console.error('Failed to record client API key token usage:', redactSensitive(error));
    } finally {
      releaseClientApiKeyCapacity(clientCapacityReservationId);
    }
  };
  const retryBudget = retryBudgetForConfiguredRoutes();
  const fallbackDeadlineAt = start + MAX_FALLBACK_RETRY_WINDOW_MS;
  let attemptsPerformed = 0;

  for (let attempt = 0;
    attempt < retryBudget && Date.now() < fallbackDeadlineAt;
    attempt++) {
    attemptsPerformed = attempt + 1;
    const attemptDeadline = createAttemptDeadlineSignal(downstream.signal, fallbackDeadlineAt);
    try {
    let route: RouteResult;
    try {
      route = await routeRequestAsync(estimatedTotal, skipKeys, preferredModel, strictPreferredModel, accessFilter, attemptDeadline.signal, keyAccessFilter);
    } catch (err: any) {
      if (downstream.signal.aborted || res.destroyed) {
        settleClientCapacity(reachedUpstream ? estimatedInputTokens : 0);
        logRequest('routing', requestedModel ?? AUTO_MODEL_ID, 0, 'cancelled', estimatedInputTokens, 0, Date.now() - start, 'Client disconnected', analyticsRequestId, attempt + 1, true);
        return;
      }
      if (attemptDeadline.signal.aborted) {
        lastError = attemptDeadline.signal.reason ?? err;
        recordRetryFailure(retryFailures, lastError);
        settleClientCapacity(reachedUpstream ? estimatedInputTokens : 0);
        logRequest('routing', requestedModel ?? AUTO_MODEL_ID, 0, 'error', estimatedInputTokens, 0, Date.now() - start, safeProviderFailureDescription(lastError), analyticsRequestId, attempt + 1, true);
        sendFallbackExhausted(res, lastError, retryFailures, attempt + 1);
        return;
      }
      if (err instanceof RoutePreparationError) {
        lastError = err;
        lastAttemptRoute = err.failedRoute;
        addRetrySkip(err, err.failedRoute, true);
        recordRetryFailure(retryFailures, err);
        logRequest(
          err.failedRoute.platform, err.failedRoute.modelId, err.failedRoute.keyId,
          'error', 0, 0, Date.now() - start,
          safeProviderFailureDescription(err), analyticsRequestId, attempt + 1, false,
        );
        continue;
      }
      if (strictPreferredModel && lastError && isRetryableError(lastError)) {
        // The explicitly requested model/key pool has been exhausted by a
        // transient provider failure. Switch to the normal fallback chain rather
        // than returning "no fallback was attempted".
        strictPreferredModel = false;
        preferredModel = undefined;
        console.log(`[Proxy] Requested model '${requestedModel}' exhausted; falling back to the next routeable model. ${safeProviderFailureDescription(lastError)}`);
        continue;
      }

      // No more models available
      if (lastError) {
        settleClientCapacity(reachedUpstream ? estimatedInputTokens : 0);
        const failedRoute = lastAttemptRoute;
        logRequest(
          failedRoute?.platform ?? 'routing', failedRoute?.modelId ?? requestedModel ?? AUTO_MODEL_ID, failedRoute?.keyId ?? 0,
          'error', estimatedInputTokens, 0, Date.now() - start,
          safeProviderFailureDescription(lastError), analyticsRequestId, attempt + 1, true,
        );
        sendFallbackExhausted(res, lastError, retryFailures, attempt);
      } else {
        settleClientCapacity();
        const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 503;
        logRequest('routing', requestedModel ?? AUTO_MODEL_ID, 0, 'error', estimatedInputTokens, 0, Date.now() - start, sanitizeProviderErrorMessage(err.message), analyticsRequestId, attempt + 1, true);
        res.status(status).json({
          error: {
            message: sanitizeProviderErrorMessage(err.message ?? 'No eligible route is currently available.'),
            type: status === 403 ? 'forbidden' : 'routing_error',
            code: err.code ?? (status === 503 ? 'no_eligible_route' : 'routing_error'),
          },
        });
      }
      return;
    }
    lastAttemptRoute = route;

    recordRequest(route.platform, route.modelId, route.keyId);
    commitProviderRequestReservation(route.capacityReservationId);
    reachedUpstream = true;

    try {
      if (stream) {
        // Lazy header set: pre-stream errors stay retryable (no headers sent yet);
        // mid-stream errors emit an `error` SSE frame so the client sees a real signal
        // instead of a silently truncated stream.
        let estimatedOutputTokens = 0;
        let reportedPromptTokens = 0;
        let reportedCompletionTokens = 0;
        let reportedTotalTokens = 0;
        let streamStarted = false;
        const bufferedUsageChunks: string[] = [];
        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey, messages, route.modelId,
            { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls, stream_options, oauth: route.oauth, signal: attemptDeadline.signal },
          );

          for await (const chunk of gen) {
            if (!isValidStreamChunk(chunk)) {
              throw new ProviderProtocolError(`${route.displayName} returned a malformed streaming chunk.`);
            }
            const localRouteModelId = toLocalModelId(route.platform, route.modelId);
            if (chunk.usage) {
              reportedPromptTokens = chunk.usage.prompt_tokens;
              reportedCompletionTokens = chunk.usage.completion_tokens;
              reportedTotalTokens = chunk.usage.total_tokens;
            }
            const serialized = `data: ${JSON.stringify({ ...chunk, model: localRouteModelId })}\n\n`;
            // include_usage frames have choices:[] and are metadata, not proof
            // that the provider produced a completion. Keep them buffered until
            // the first substantive choice so an all-usage stream can fallback.
            if (!streamStarted && !hasSubstantiveOpenAIStreamDelta(chunk)) {
              bufferedUsageChunks.push(serialized);
              continue;
            }
            if (!streamStarted) {
              res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
              res.setHeader('Cache-Control', 'no-cache, no-transform');
              res.setHeader('Connection', 'keep-alive');
              res.setHeader('X-Accel-Buffering', 'no');
              res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
              if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
              res.flushHeaders();
              streamStarted = true;
              for (const buffered of bufferedUsageChunks) {
                await writeResponseChunk(res, buffered, downstream.signal);
              }
            }
            const outputCharacters = chunk.choices.reduce((sum, choice) => {
              const text = choice.delta?.content ?? '';
              const toolDelta = choice.delta?.tool_calls?.map(call => (
                `${call.id ?? ''}${call.function?.name ?? ''}${call.function?.arguments ?? ''}`
              )).join('') ?? '';
              return sum + text.length + toolDelta.length;
            }, 0);
            estimatedOutputTokens += Math.ceil(outputCharacters / 4);
            await writeResponseChunk(res, serialized, downstream.signal);
          }

          if (!streamStarted) {
            throw new ProviderProtocolError(`${route.displayName} returned an empty streaming response.`);
          }
          await writeResponseChunk(res, 'data: [DONE]\n\n', downstream.signal);
          res.end();

          const actualInputTokens = reportedPromptTokens > 0 ? reportedPromptTokens : estimatedInputTokens;
          const actualOutputTokens = reportedCompletionTokens > 0 ? reportedCompletionTokens : estimatedOutputTokens;
          const totalTokens = reportedTotalTokens > 0 ? reportedTotalTokens : actualInputTokens + actualOutputTokens;
          recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
          releaseProviderCapacity(route.capacityReservationId);
          settleClientCapacity(totalTokens);
          recordSuccess(route.modelDbId);
          setStickyModel(clientKey.id, messages, route.modelDbId);
          logRequest(route.platform, route.modelId, route.keyId, 'success', actualInputTokens, actualOutputTokens, Date.now() - start, null, analyticsRequestId, attempt + 1, true);
          return;
        } catch (streamErr: any) {
          if (downstream.signal.aborted || res.destroyed) {
            const attemptedTokens = estimatedInputTokens + estimatedOutputTokens;
            recordTokens(route.platform, route.modelId, route.keyId, attemptedTokens);
            settleClientCapacity(attemptedTokens);
            releaseProviderCapacity(route.capacityReservationId);
            logRequest(route.platform, route.modelId, route.keyId, 'cancelled', estimatedInputTokens, estimatedOutputTokens, Date.now() - start, 'Client disconnected', analyticsRequestId, attempt + 1, true);
            return;
          }
          if (streamStarted) {
            // Mid-stream error — finish the SSE response cleanly instead of leaving
            // the client hanging or letting Express's default handler take over.
            // Full upstream message goes to the log; the client sees a generic
            // message so we don't leak provider internals into a partial stream.
            const safeStreamError = safeProviderFailureDescription(streamErr);
            console.error(`[Proxy] Mid-stream failure from ${route.displayName}: ${safeStreamError}`);
            const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
            if (isRateLimitFailure(streamErr)) {
              setCooldown(route.platform, route.modelId, route.keyId, getNextCooldownDuration(route.platform, route.modelId, route.keyId));
              recordRateLimitHit(route.modelDbId);
            } else if (shouldOpenRouteFailureCircuit(streamErr)) {
              recordRouteFailure(route.modelDbId);
            }
            recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + estimatedOutputTokens);
            releaseProviderCapacity(route.capacityReservationId);
            settleClientCapacity(estimatedInputTokens + estimatedOutputTokens);
            try { await writeResponseChunk(res, `data: ${JSON.stringify(payload)}\n\n`, downstream.signal); } catch { /* socket gone */ }
            try { await writeResponseChunk(res, 'data: [DONE]\n\n', downstream.signal); res.end(); } catch { /* socket gone */ }
            logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, estimatedOutputTokens, Date.now() - start, safeStreamError, analyticsRequestId, attempt + 1, true);
            return;
          }
          // Pre-stream error — bubble to outer retry/502 handler.
          throw streamErr;
        }
      } else {
        const result = await route.provider.chatCompletion(
          route.apiKey, messages, route.modelId,
          { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls, stream_options, oauth: route.oauth, signal: attemptDeadline.signal },
        );

        const reportedPromptTokens = result.usage?.prompt_tokens ?? 0;
        const reportedCompletionTokens = result.usage?.completion_tokens ?? 0;
        const estimatedOutputTokens = result.choices.reduce((sum, choice) => {
          const content = contentToString(choice.message.content);
          const toolArguments = choice.message.tool_calls?.map(call => call.function.arguments).join('') ?? '';
          return sum + Math.ceil((content.length + toolArguments.length) / 4);
        }, 0);
        const actualInputTokens = reportedPromptTokens > 0 ? reportedPromptTokens : estimatedInputTokens;
        const actualOutputTokens = reportedCompletionTokens > 0 ? reportedCompletionTokens : estimatedOutputTokens;
        const totalTokens = (result.usage?.total_tokens ?? 0) > 0
          ? result.usage.total_tokens
          : actualInputTokens + actualOutputTokens;
        const localRouteModelId = toLocalModelId(route.platform, route.modelId);
        recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
        releaseProviderCapacity(route.capacityReservationId);
        settleClientCapacity(totalTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(clientKey.id, messages, route.modelDbId);

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
        res.json({
          ...result,
          model: localRouteModelId,
          usage: {
            prompt_tokens: actualInputTokens,
            completion_tokens: actualOutputTokens,
            total_tokens: totalTokens,
          },
          _routed_via: { platform: route.platform, model: route.modelId },
        });

        logRequest(
          route.platform, route.modelId, route.keyId, 'success',
          actualInputTokens,
          actualOutputTokens,
          Date.now() - start, null, analyticsRequestId, attempt + 1, true,
        );
        return;
      }
    } catch (err: any) {
      releaseProviderCapacity(route.capacityReservationId);
      // Once an upstream accepted the request, conservatively account for its
      // input even when it fails before returning output. This prevents large
      // prompts followed by immediate disconnects/errors from bypassing TPM.
      recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens);
      if (downstream.signal.aborted || res.destroyed) {
        settleClientCapacity(estimatedInputTokens);
        logRequest(route.platform, route.modelId, route.keyId, 'cancelled', estimatedInputTokens, 0, Date.now() - start, 'Client disconnected', analyticsRequestId, attempt + 1, true);
        return;
      }
      const latency = Date.now() - start;
      const safeError = safeProviderFailureDescription(err);
      if (isProviderCredentialInvalid(err) && route.oauth && !oauthAccountsRefreshedAfter401.has(route.oauth.accountId)) {
        oauthAccountsRefreshedAfter401.add(route.oauth.accountId);
        try {
          await forceRefreshOAuthAccount(getDb(), route.oauth.accountId, attemptDeadline.signal);
          logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, safeError, analyticsRequestId, attempt + 1, false);
          lastError = err;
          recordRetryFailure(retryFailures, err);
          // Do not skip the route: the next selection will decrypt the newly
          // rotated access token. The set above guarantees at most one forced
          // refresh per account for this client request.
          continue;
        } catch (refreshError) {
          if (downstream.signal.aborted || res.destroyed) {
            settleClientCapacity(estimatedInputTokens);
            logRequest(route.platform, route.modelId, route.keyId, 'cancelled', estimatedInputTokens, 0, Date.now() - start, 'Client disconnected', analyticsRequestId, attempt + 1, true);
            return;
          }
          const safeRefreshError = safeProviderFailureDescription(refreshError);
          logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, safeRefreshError, analyticsRequestId, attempt + 1, false);
          addRetrySkip(refreshError, route, true);
          lastError = refreshError;
          recordRetryFailure(retryFailures, refreshError);
          continue;
        }
      }
      // A manual credential rejected with 401 is definitively invalid. OAuth
      // credentials are only disabled by a definitive refresh-token rejection;
      // a model/account-specific 401 must not permanently strand the account.
      if (isProviderCredentialInvalid(err) && !route.oauth) markProviderCredentialInvalid(route.keyId);
      if (isRetryableError(err)) {
        logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, safeError, analyticsRequestId, attempt + 1, false);
        // Put this model+key on cooldown and try the next one
        addRetrySkip(err, route);
        // Persistent cooldowns and the dashboard's "rate-limit hits" metric
        // represent actual quota pressure only. Other retryable failures are
        // isolated by skipKeys for this request without being mislabeled.
        if (isRateLimitFailure(err)) {
          setCooldown(
            route.platform,
            route.modelId,
            route.keyId,
            getNextCooldownDuration(route.platform, route.modelId, route.keyId),
          );
          recordRateLimitHit(route.modelDbId);
        }
        lastError = err;
        recordRetryFailure(retryFailures, err);
        console.log(`[Proxy] ${safeError} Route ${route.displayName} is ${strictPreferredModel ? 'retrying its requested model/key pool' : 'falling back'} (attempt ${attempt + 1}/${retryBudget}).`);
        continue;
      }

      // Non-retryable error (auth, 4xx, etc.): don't retry
      settleClientCapacity(estimatedInputTokens);
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, safeError, analyticsRequestId, attempt + 1, true);
      res.status(502).json({
        error: {
          message: `The upstream provider route '${route.displayName}' failed.`,
          type: 'provider_error',
          code: 'upstream_provider_error',
          request_id: String(res.locals.requestId ?? 'unknown'),
        },
      });
      return;
    }
    } finally {
      attemptDeadline.cancel();
    }
  }

  // Exhausted all retries
  if (!downstream.signal.aborted && !res.destroyed) {
    settleClientCapacity(reachedUpstream ? estimatedInputTokens : 0);
    const failedRoute = lastAttemptRoute;
    logRequest(
      failedRoute?.platform ?? 'routing', failedRoute?.modelId ?? requestedModel ?? AUTO_MODEL_ID, failedRoute?.keyId ?? 0,
      'error', estimatedInputTokens, 0, Date.now() - start,
      safeProviderFailureDescription(lastError), analyticsRequestId, attemptsPerformed + 1, true,
    );
    sendFallbackExhausted(res, lastError, retryFailures, attemptsPerformed);
  }
  else settleClientCapacity(reachedUpstream ? estimatedInputTokens : 0);
});

function logRequest(
  platform: string,
  modelId: string,
  keyId: number,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
  requestId: string,
  attempt: number,
  isFinal: boolean,
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (request_id, attempt, is_final, platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(requestId, attempt, isFinal ? 1 : 0, platform, modelId, keyId, status, inputTokens, outputTokens, latencyMs, error);
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}
