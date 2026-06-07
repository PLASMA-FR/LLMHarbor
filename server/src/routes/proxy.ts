import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage } from '@llmharbor/shared/types.js';
import { routeRequestAsync, recordRateLimitHit, recordSuccess, type RouteResult } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, getNextCooldownDuration } from '../services/ratelimit.js';
import { authenticateClientApiKey, checkClientApiKeyLimits, getDb, recordClientApiKeyUsage, type AuthenticatedClientApiKey } from '../db/index.js';
import { contentToString } from '../lib/content.js';
import { getClientModelAccessDenial, isClientRouteAllowed, localApiRouteDenied, type ClientAccessDenial } from '../services/accessPolicy.js';
import { parseLocalModelId, toLocalModelId } from '../services/localModelIds.js';

export const proxyRouter = Router();

// Virtual "auto" model. Clients like Hermes require a non-empty `model` field
// on every request, but llmharbor's whole point is to pick the model itself.
// Requesting this id means "let the router decide" — identical to omitting
// `model` entirely.
const AUTO_MODEL_ID = 'auto';

function isAutoModel(modelId: string | undefined): boolean {
  return modelId === AUTO_MODEL_ID;
}

// Constant-time string comparison for the unified API key. Plain `===` leaks
// length and per-character timing, which a network attacker could in principle
// use to recover the key one byte at a time.
function timingSafeStringEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Compare against a same-length buffer regardless of input length so the
  // comparison itself runs in constant time; the explicit length check at the
  // end is what actually decides equality when lengths differ.
  const compareA = a.length === b.length ? a : Buffer.alloc(b.length);
  return crypto.timingSafeEqual(compareA, b) && a.length === b.length;
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
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const clientKey = token ? authenticateClientApiKey(token, timingSafeStringEqual) : null;
  if (!clientKey) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return null;
  }
  return clientKey;
}

// Sticky sessions: track which model served each "session"
// Key: hash of first user message → model_db_id
// This prevents model switching mid-conversation which causes hallucination
const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 min session TTL

function getSessionKey(messages: ChatMessage[]): string {
  // Use the first user message as session identifier — clients like Hermes
  // re-send the full conversation each turn, so the first user message is
  // stable across turns. Hash the FULL message (not a 100-char slice) so
  // distinct conversations with identical openings don't collide.
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser || typeof firstUser.content !== 'string') return '';
  const hash = crypto.createHash('sha1').update(firstUser.content).digest('hex');
  return `${hash}:${messages.length > 2 ? 'multi' : 'single'}`;
}

function getStickyModel(messages: ChatMessage[]): number | undefined {
  // Only apply sticky for multi-turn (has assistant messages = continuation)
  const hasAssistant = messages.some(m => m.role === 'assistant');
  if (!hasAssistant) return undefined;

  const key = getSessionKey(messages);
  if (!key) return undefined;

  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelDbId;
}

function setStickyModel(messages: ChatMessage[], modelDbId: number) {
  const key = getSessionKey(messages);
  if (!key) return;
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });

  // Cleanup old entries
  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }
  }
}

// OpenAI-compatible /models endpoint (used by Hermes for metadata)
proxyRouter.get('/models', (req: Request, res: Response) => {
  const clientKey = authenticateProxyClient(req, res);
  if (!clientKey) return;

  if (!isClientRouteAllowed(clientKey.id, 'v1.models')) {
    sendAccessDenied(res, localApiRouteDenied('v1.models'));
    return;
  }

  const db = getDb();
  const models = db.prepare(`
    SELECT m.id, m.platform, m.model_id, m.display_name, m.context_window
      FROM models m
     WHERE m.enabled = 1
       AND EXISTS (
         SELECT 1
           FROM api_keys ak
           LEFT JOIN oauth_accounts oa ON oa.id = ak.oauth_account_id
          WHERE ak.platform = m.platform
            AND ak.enabled = 1
            AND (ak.status IN ('healthy', 'unknown') OR ak.source = 'oauth')
            AND (
              ak.source != 'oauth'
              OR (oa.enabled = 1 AND COALESCE(json_extract(oa.metadata_json, '$.oauthNeedsReconnect'), 0) != 1)
            )
       )
     ORDER BY m.intelligence_rank
  `).all() as any[];
  const allowedModels = models.filter(m => getClientModelAccessDenial(clientKey.id, {
    id: m.id,
    platform: m.platform,
    modelId: m.model_id,
    displayName: m.display_name,
  }) === null);

  res.json({
    object: 'list',
    data: [
      {
        id: AUTO_MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'llmharbor',
        name: 'Auto (router picks the best available model)',
        context_window: null,
      },
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

const MAX_RETRIES = 20;

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
  thought_signature: z.string().optional(),
});

// OpenAI multimodal envelope. Clients like opencode / continue.dev send
// content as an array of typed blocks even when only text is present. We
// accept the envelope on the wire and flatten to string for providers that
// don't support arrays (Cohere, Cloudflare). Non-text blocks pass z validation
// but get dropped by contentToString — vision/audio still isn't supported.
const contentBlockSchema = z.object({ type: z.string() }).passthrough();
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
  tool_calls: z.array(toolCallSchema).optional(),
}).refine((msg) => {
  const hasContent = hasNonEmptyContent(msg.content);
  const hasToolCalls = (msg.tool_calls?.length ?? 0) > 0;
  return hasContent || hasToolCalls;
}, {
  message: 'assistant messages must include non-empty content or tool_calls',
});

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
});

export function isRetryableError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
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

proxyRouter.post('/chat/completions', async (req: Request, res: Response) => {
  const start = Date.now();

  // Authenticate with any enabled personal API key for every proxy request,
  // including loopback callers. Browser pages can reach localhost, so socket
  // locality is not a reliable authorization boundary.
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const clientKey = token ? authenticateClientApiKey(token, timingSafeStringEqual) : null;
  if (!clientKey) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return;
  }

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

  const { model: requestedModel, temperature, max_tokens, top_p, stream, tools, tool_choice, parallel_tool_calls } = parsed.data;
  const messages: ChatMessage[] = parsed.data.messages.map((m): ChatMessage => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content ?? null,
        ...(m.name ? { name: m.name } : {}),
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
  const estimatedInputTokens = messages.reduce((sum, m) => {
    const text = contentToString(m.content);
    return sum + Math.ceil(text.length / 4);
  }, 0);
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
    preferredModel = getStickyModel(messages);
  } else if (requestedModel) {
    const db = getDb();
    const localModel = parseLocalModelId(requestedModel);
    const routeablePredicate = `
         m.enabled = 1
         AND EXISTS (
           SELECT 1 FROM api_keys ak
           LEFT JOIN oauth_accounts oa ON oa.id = ak.oauth_account_id
            WHERE ak.platform = m.platform
              AND ak.enabled = 1
              AND (ak.status IN ('healthy', 'unknown') OR ak.source = 'oauth')
              AND (
                ak.source != 'oauth'
                OR (oa.enabled = 1 AND COALESCE(json_extract(oa.metadata_json, '$.oauthNeedsReconnect'), 0) != 1)
              )
         )`;
    const routeableOrder = `ORDER BY CASE WHEN m.display_name LIKE '%browser account%' THEN 0 ELSE 1 END, m.intelligence_rank ASC, m.id ASC LIMIT 1`;
    const enabledByLocalId = localModel ? db.prepare(`
      SELECT m.id, m.platform, m.model_id, m.display_name
        FROM models m
       WHERE m.platform = ?
         AND m.model_id = ?
         AND ${routeablePredicate}
       ${routeableOrder}
    `).get(localModel.platform, localModel.modelId) as { id: number; platform: string; model_id: string; display_name: string } | undefined : undefined;
    const enabled = enabledByLocalId ?? db.prepare(`
      SELECT m.id, m.platform, m.model_id, m.display_name
        FROM models m
       WHERE m.model_id = ?
         AND ${routeablePredicate}
       ${routeableOrder}
    `).get(requestedModel) as { id: number; platform: string; model_id: string; display_name: string } | undefined;
    if (enabled) {
      const denial = getClientModelAccessDenial(clientKey.id, {
        id: enabled.id,
        platform: enabled.platform,
        modelId: enabled.model_id,
        displayName: enabled.display_name,
      });
      if (denial) {
        sendAccessDenied(res, denial);
        return;
      }
      preferredModel = enabled.id;
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
    preferredModel = getStickyModel(messages);
  }

  // Retry loop: on 429/rate limit, skip that model+key and try the next one
  const skipKeys = new Set<string>();
  let lastError: any = null;
  const accessFilter = (model: { id: number; platform: string; modelId: string; displayName: string }) => (
    getClientModelAccessDenial(clientKey.id, model) === null
  );

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = await routeRequestAsync(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel, strictPreferredModel, accessFilter);
    } catch (err: any) {
      if (strictPreferredModel && lastError && isRetryableError(lastError)) {
        // The explicitly requested model/key pool has been exhausted by a
        // transient provider failure. Switch to the normal fallback chain rather
        // than returning "no fallback was attempted".
        strictPreferredModel = false;
        preferredModel = undefined;
        console.log(`[Proxy] Requested model '${requestedModel}' exhausted; falling back to the next routeable model. Last error: ${String(lastError.message ?? lastError).slice(0, 120)}`);
        continue;
      }

      // No more models available
      if (lastError) {
        const lastMessage = String(lastError.message ?? lastError);
        const strictRateLimited = strictPreferredModel && /(429|rate limit|too many requests|quota|resource_exhausted)/i.test(lastMessage);
        res.status(strictPreferredModel ? (strictRateLimited ? 429 : 502) : 429).json({
          error: {
            message: strictPreferredModel
              ? `Requested model '${requestedModel}' failed and no fallback was attempted. Last error: ${lastMessage}`
              : `All models rate-limited. Last error: ${lastMessage}`,
            type: strictPreferredModel ? (strictRateLimited ? 'rate_limit_error' : 'provider_error') : 'rate_limit_error',
            ...(strictPreferredModel ? { code: 'model_no_fallback' } : {}),
          },
        });
      } else {
        res.status(err.status ?? 503).json({
          error: {
            message: err.message,
            type: err.status === 403 ? 'forbidden' : 'routing_error',
            ...(err.code ? { code: err.code } : {}),
          },
        });
      }
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      if (stream) {
        // Lazy header set: pre-stream errors stay retryable (no headers sent yet);
        // mid-stream errors emit an `error` SSE frame so the client sees a real signal
        // instead of a silently truncated stream.
        let totalOutputTokens = 0;
        let streamStarted = false;
        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey, messages, route.modelId,
            { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls, oauth: route.oauth },
          );

          for await (const chunk of gen) {
            const localRouteModelId = toLocalModelId(route.platform, route.modelId);
            if (!streamStarted) {
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
              if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
              streamStarted = true;
            }
            const text = chunk.choices[0]?.delta?.content ?? '';
            totalOutputTokens += Math.ceil(text.length / 4);
            res.write(`data: ${JSON.stringify({ ...chunk, model: localRouteModelId })}\n\n`);
          }

          if (!streamStarted) {
            // Upstream returned no chunks — emit minimal successful stream.
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
          }
          res.write('data: [DONE]\n\n');
          res.end();

          recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
          recordClientApiKeyUsage(clientKey.id, estimatedInputTokens + totalOutputTokens);
          recordSuccess(route.modelDbId);
          setStickyModel(messages, route.modelDbId);
          logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null);
          return;
        } catch (streamErr: any) {
          if (streamStarted) {
            // Mid-stream error — finish the SSE response cleanly instead of leaving
            // the client hanging or letting Express's default handler take over.
            // Full upstream message goes to the log; the client sees a generic
            // message so we don't leak provider internals into a partial stream.
            console.error(`[Proxy] Mid-stream error from ${route.displayName}:`, streamErr.message);
            const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket gone */ }
            try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
            logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, streamErr.message);
            return;
          }
          // Pre-stream error — bubble to outer retry/502 handler.
          throw streamErr;
        }
      } else {
        const result = await route.provider.chatCompletion(
          route.apiKey, messages, route.modelId,
          { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls, oauth: route.oauth },
        );

        const totalTokens = result.usage?.total_tokens ?? estimatedTotal;
        const localRouteModelId = toLocalModelId(route.platform, route.modelId);
        recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
        recordClientApiKeyUsage(clientKey.id, totalTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId);

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
        res.json({
          ...result,
          model: localRouteModelId,
          _routed_via: { platform: route.platform, model: route.modelId },
        });

        logRequest(
          route.platform, route.modelId, route.keyId, 'success',
          result.usage?.prompt_tokens ?? 0,
          result.usage?.completion_tokens ?? 0,
          Date.now() - start, null,
        );
        return;
      }
    } catch (err: any) {
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, err.message);

      if (isRetryableError(err)) {
        // Put this model+key on cooldown and try the next one
        const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
        skipKeys.add(skipId);
        setCooldown(
          route.platform,
          route.modelId,
          route.keyId,
          getNextCooldownDuration(route.platform, route.modelId, route.keyId),
        );
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        console.log(`[Proxy] ${err.message.slice(0, 60)} from ${route.displayName}, ${strictPreferredModel ? 'retrying same requested model/key pool' : 'falling back'} (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      // Non-retryable error (auth, 4xx, etc.): don't retry
      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${err.message}`,
          type: 'provider_error',
        },
      });
      return;
    }
  }

  // Exhausted all retries
  const lastMessage = String(lastError?.message ?? lastError ?? 'unknown error');
  const strictRateLimited = strictPreferredModel && /(429|rate limit|too many requests|quota|resource_exhausted)/i.test(lastMessage);
  res.status(strictPreferredModel ? (strictRateLimited ? 429 : 502) : 429).json({
    error: {
      message: strictPreferredModel
        ? `Requested model '${requestedModel}' failed and no fallback was attempted. Last error: ${lastMessage}`
        : `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastMessage}`,
      type: strictPreferredModel ? (strictRateLimited ? 'rate_limit_error' : 'provider_error') : 'rate_limit_error',
      ...(strictPreferredModel ? { code: 'model_no_fallback' } : {}),
    },
  });
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
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, keyId, status, inputTokens, outputTokens, latencyMs, error);
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}
