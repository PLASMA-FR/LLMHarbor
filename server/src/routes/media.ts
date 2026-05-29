import { Router } from 'express';
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authenticateClientApiKey, checkClientApiKeyLimits, getDb, recordClientApiKeyUsage, type AuthenticatedClientApiKey } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';

export const mediaRouter = Router();

function timingSafeStringEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const compareA = a.length === b.length ? a : Buffer.alloc(b.length);
  return crypto.timingSafeEqual(compareA, b) && a.length === b.length;
}

const MEDIA_PROVIDERS = [
  {
    platform: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    imageModels: ['gpt-image-1', 'dall-e-3', 'dall-e-2'],
    audioModels: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
    voices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'],
  },
  {
    platform: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    imageModels: ['openai/gpt-image-1'],
    audioModels: [],
    voices: [],
  },
];

const imageSchema = z.object({
  model: z.string().min(1).default('gpt-image-1'),
  prompt: z.string().min(1),
  n: z.number().int().min(1).max(10).optional(),
  size: z.string().optional(),
  quality: z.string().optional(),
  style: z.string().optional(),
  response_format: z.enum(['url', 'b64_json']).optional(),
  user: z.string().optional(),
  provider: z.string().optional(),
});

const speechSchema = z.object({
  model: z.string().min(1).default('tts-1'),
  input: z.string().min(1),
  voice: z.string().min(1).default('alloy'),
  response_format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).optional(),
  speed: z.number().min(0.25).max(4).optional(),
  instructions: z.string().optional(),
  provider: z.string().optional(),
});

function requireProxyAuth(req: Request, res: Response): AuthenticatedClientApiKey | null {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const clientKey = token ? authenticateClientApiKey(token, timingSafeStringEqual) : null;
  if (!clientKey) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return null;
  }
  return clientKey;
}

function enforceClientKeyLimits(clientKey: AuthenticatedClientApiKey, res: Response, requestedTokens = 0): boolean {
  const block = checkClientApiKeyLimits(clientKey, requestedTokens);
  if (!block) return true;
  res.setHeader('Retry-After', String(block.retryAfterSeconds));
  res.status(429).json({
    error: {
      message: block.message,
      type: 'rate_limit_error',
      code: 'client_key_limit_exceeded',
      metric: block.metric,
      limit: block.limit,
      used: block.used,
      requested: block.requested,
    },
  });
  return false;
}

function providerFor(kind: 'image' | 'audio', model: string, requestedProvider?: string) {
  const candidates = requestedProvider
    ? MEDIA_PROVIDERS.filter(provider => provider.platform === requestedProvider)
    : MEDIA_PROVIDERS;
  return candidates.find(provider => (
    kind === 'image'
      ? provider.imageModels.includes(model)
      : provider.audioModels.includes(model)
  )) ?? candidates[0];
}

function getProviderKey(platform: string): { key: string; keyId: number } | null {
  const db = getDb();
  const rows = db.prepare("SELECT id, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown') ORDER BY CASE status WHEN 'healthy' THEN 0 ELSE 1 END, id DESC").all(platform) as any[];
  for (const row of rows) {
    try {
      return { key: decrypt(row.encrypted_key, row.iv, row.auth_tag), keyId: row.id };
    } catch {
      db.prepare("UPDATE api_keys SET status = 'error', last_checked_at = datetime('now') WHERE id = ?").run(row.id);
    }
  }
  return null;
}

function filterUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as T;
}

mediaRouter.get('/media/providers', (_req: Request, res: Response) => {
  res.json({ providers: MEDIA_PROVIDERS });
});

mediaRouter.post('/images/generations', async (req: Request, res: Response) => {
  const clientKey = requireProxyAuth(req, res);
  if (!clientKey) return;
  const parsed = imageSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', '), type: 'invalid_request_error' } });
    return;
  }

  if (!enforceClientKeyLimits(clientKey, res)) return;

  const provider = providerFor('image', parsed.data.model, parsed.data.provider);
  if (!provider) {
    res.status(400).json({ error: { message: `No image provider available for model '${parsed.data.model}'`, type: 'invalid_request_error' } });
    return;
  }
  const key = getProviderKey(provider.platform);
  if (!key) {
    res.status(503).json({ error: { message: `No enabled ${provider.name} key is available for image generation`, type: 'routing_error' } });
    return;
  }

  const upstream = await fetch(`${provider.baseUrl}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(filterUndefined({
      model: parsed.data.model,
      prompt: parsed.data.prompt,
      n: parsed.data.n,
      size: parsed.data.size,
      quality: parsed.data.quality,
      style: parsed.data.style,
      response_format: parsed.data.response_format,
      user: parsed.data.user,
    })),
  });
  if (!upstream.ok) {
    const err = await upstream.json().catch(() => ({}));
    res.status(502).json({ error: { message: `${provider.name} image API error ${upstream.status}: ${(err as any).error?.message ?? upstream.statusText}`, type: 'provider_error' } });
    return;
  }
  const body = await upstream.json();
  recordClientApiKeyUsage(clientKey.id);
  res.setHeader('X-Routed-Via', `${provider.platform}/${parsed.data.model}`);
  res.json(body);
});

mediaRouter.post('/audio/speech', async (req: Request, res: Response) => {
  const clientKey = requireProxyAuth(req, res);
  if (!clientKey) return;
  const parsed = speechSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', '), type: 'invalid_request_error' } });
    return;
  }

  if (!enforceClientKeyLimits(clientKey, res)) return;

  const provider = providerFor('audio', parsed.data.model, parsed.data.provider);
  if (!provider) {
    res.status(400).json({ error: { message: `No audio provider available for model '${parsed.data.model}'`, type: 'invalid_request_error' } });
    return;
  }
  const key = getProviderKey(provider.platform);
  if (!key) {
    res.status(503).json({ error: { message: `No enabled ${provider.name} key is available for audio speech`, type: 'routing_error' } });
    return;
  }

  const upstream = await fetch(`${provider.baseUrl}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(filterUndefined({
      model: parsed.data.model,
      input: parsed.data.input,
      voice: parsed.data.voice,
      response_format: parsed.data.response_format,
      speed: parsed.data.speed,
      instructions: parsed.data.instructions,
    })),
  });
  if (!upstream.ok) {
    const err = await upstream.json().catch(() => ({}));
    res.status(502).json({ error: { message: `${provider.name} audio API error ${upstream.status}: ${(err as any).error?.message ?? upstream.statusText}`, type: 'provider_error' } });
    return;
  }
  const bytes = Buffer.from(await upstream.arrayBuffer());
  recordClientApiKeyUsage(clientKey.id);
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
  res.setHeader('X-Routed-Via', `${provider.platform}/${parsed.data.model}`);
  res.send(bytes);
});
