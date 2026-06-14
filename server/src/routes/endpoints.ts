import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { clearDynamicProvider, getBuiltInProviderSummaries, getProvider, hasProvider } from '../providers/index.js';

export const endpointsRouter = Router();

const platformSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);

const endpointSchema = z.object({
  name: z.string().min(1).max(80),
  baseUrl: z.string().url().max(500),
  validateUrl: z.string().url().max(500).optional().nullable(),
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
});

const modelSchema = z.object({
  modelId: z.string().min(1).max(240),
  displayName: z.string().min(1).max(160),
  intelligenceRank: z.number().int().min(1).max(999).default(50),
  speedRank: z.number().int().min(1).max(999).default(50),
  sizeLabel: z.string().max(60).default('Custom'),
  rpmLimit: z.number().int().positive().nullable().optional(),
  rpdLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
  tpdLimit: z.number().int().positive().nullable().optional(),
  monthlyTokenBudget: z.string().max(80).default('custom'),
  contextWindow: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().default(true),
});

const probeSchema = z.object({
  modelId: z.string().min(1).max(240),
  keyId: z.number().int().positive().optional(),
});

function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'endpoint';
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function nextCustomPlatform(name: string): string {
  const db = getDb();
  const base = `custom-${slugifyName(name)}`;
  let candidate = base;
  let suffix = 2;
  while (hasProvider(candidate) || db.prepare('SELECT 1 FROM custom_endpoints WHERE platform = ?').get(candidate)) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

function addFallbackForModel(modelDbId: number): void {
  const db = getDb();
  const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
  db.prepare('INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)')
    .run(modelDbId, maxPriority + 1);
}

function endpointExists(platform: string): boolean {
  return hasProvider(platform);
}

function customEndpointExists(platform: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM custom_endpoints WHERE platform = ?').get(platform);
}

function serializeModel(m: any) {
  return {
    id: m.id,
    platform: m.platform,
    modelId: m.model_id,
    displayName: m.display_name,
    intelligenceRank: m.intelligence_rank,
    speedRank: m.speed_rank,
    sizeLabel: m.size_label,
    rpmLimit: m.rpm_limit,
    rpdLimit: m.rpd_limit,
    tpmLimit: m.tpm_limit,
    tpdLimit: m.tpd_limit,
    monthlyTokenBudget: m.monthly_token_budget,
    contextWindow: m.context_window,
    enabled: m.enabled === 1,
    priority: m.priority,
    fallbackEnabled: m.fallback_enabled === 1,
  };
}

endpointsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const customEndpoints = db.prepare(`
    SELECT ce.*,
           (SELECT COUNT(*) FROM models m WHERE m.platform = ce.platform) AS model_count,
           (SELECT COUNT(*) FROM api_keys ak WHERE ak.platform = ce.platform) AS key_count
    FROM custom_endpoints ce
    ORDER BY ce.created_at DESC
  `).all() as any[];

  const count = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM models WHERE platform = ?) AS model_count,
      (SELECT COUNT(*) FROM api_keys WHERE platform = ?) AS key_count
  `);

  const builtIns = getBuiltInProviderSummaries().map(provider => {
    const stats = count.get(provider.platform, provider.platform) as { model_count: number; key_count: number };
    return {
      id: null,
      platform: provider.platform,
      name: provider.name,
      baseUrl: provider.baseUrl,
      validateUrl: null,
      timeoutMs: provider.timeoutMs ?? 15000,
      enabled: true,
      custom: false,
      createdAt: null,
      modelCount: stats.model_count,
      keyCount: stats.key_count,
    };
  });

  const custom = customEndpoints.map(e => ({
    id: e.id,
    platform: e.platform,
    name: e.name,
    baseUrl: e.base_url,
    validateUrl: e.validate_url,
    timeoutMs: e.timeout_ms,
    enabled: e.enabled === 1,
    custom: true,
    createdAt: e.created_at,
    modelCount: e.model_count,
    keyCount: e.key_count,
  }));

  res.json([...builtIns, ...custom]);
});

endpointsRouter.post('/', (req: Request, res: Response) => {
  const parsed = endpointSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const platform = nextCustomPlatform(parsed.data.name);
  const result = getDb().prepare(`
    INSERT INTO custom_endpoints (platform, name, base_url, validate_url, timeout_ms, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(
    platform,
    parsed.data.name.trim(),
    normalizeBaseUrl(parsed.data.baseUrl),
    parsed.data.validateUrl || null,
    parsed.data.timeoutMs ?? 120000,
  );
  clearDynamicProvider(platform);

  res.status(201).json({
    id: result.lastInsertRowid,
    platform,
    name: parsed.data.name.trim(),
    baseUrl: normalizeBaseUrl(parsed.data.baseUrl),
    validateUrl: parsed.data.validateUrl || null,
    timeoutMs: parsed.data.timeoutMs ?? 120000,
    enabled: true,
    custom: true,
    modelCount: 0,
    keyCount: 0,
  });
});

endpointsRouter.patch('/:platform', (req: Request, res: Response) => {
  const platform = platformSchema.safeParse(req.params.platform);
  if (!platform.success || !customEndpointExists(platform.data)) {
    res.status(404).json({ error: { message: 'Custom endpoint not found' } });
    return;
  }

  const parsed = endpointSchema.partial().extend({ enabled: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const existing = getDb().prepare('SELECT * FROM custom_endpoints WHERE platform = ?').get(platform.data) as any;
  const next = {
    name: parsed.data.name?.trim() ?? existing.name,
    baseUrl: parsed.data.baseUrl ? normalizeBaseUrl(parsed.data.baseUrl) : existing.base_url,
    validateUrl: parsed.data.validateUrl === undefined ? existing.validate_url : (parsed.data.validateUrl || null),
    timeoutMs: parsed.data.timeoutMs ?? existing.timeout_ms,
    enabled: parsed.data.enabled === undefined ? existing.enabled === 1 : parsed.data.enabled,
  };

  getDb().prepare(`
    UPDATE custom_endpoints
       SET name = ?, base_url = ?, validate_url = ?, timeout_ms = ?, enabled = ?
     WHERE platform = ?
  `).run(next.name, next.baseUrl, next.validateUrl, next.timeoutMs, next.enabled ? 1 : 0, platform.data);
  clearDynamicProvider(platform.data);
  res.json({ platform: platform.data, custom: true, ...next });
});

endpointsRouter.delete('/:platform', (req: Request, res: Response) => {
  const platform = platformSchema.safeParse(req.params.platform);
  if (!platform.success || !customEndpointExists(platform.data)) {
    res.status(404).json({ error: { message: 'Custom endpoint not found' } });
    return;
  }

  const db = getDb();
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = ?)').run(platform.data);
    db.prepare('DELETE FROM free_model_updater_provider_preferences WHERE platform = ?').run(platform.data);
    db.prepare('DELETE FROM models WHERE platform = ?').run(platform.data);
    db.prepare('DELETE FROM api_keys WHERE platform = ?').run(platform.data);
    db.prepare('DELETE FROM custom_endpoints WHERE platform = ?').run(platform.data);
  });
  remove();
  clearDynamicProvider(platform.data);
  res.json({ success: true });
});

endpointsRouter.get('/:platform/models', (req: Request, res: Response) => {
  const platform = platformSchema.safeParse(req.params.platform);
  if (!platform.success || !endpointExists(platform.data)) {
    res.status(404).json({ error: { message: 'Endpoint not found' } });
    return;
  }

  const rows = getDb().prepare(`
    SELECT m.*, fc.priority, fc.enabled AS fallback_enabled
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    WHERE m.platform = ?
    ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
  `).all(platform.data) as any[];

  res.json(rows.map(serializeModel));
});

endpointsRouter.post('/:platform/models/probe', async (req: Request, res: Response) => {
  const platform = platformSchema.safeParse(req.params.platform);
  if (!platform.success || !endpointExists(platform.data)) {
    res.status(404).json({ error: { message: 'Endpoint not found' } });
    return;
  }

  const parsed = probeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const keyRow = parsed.data.keyId
    ? db.prepare('SELECT * FROM api_keys WHERE id = ? AND platform = ? AND enabled = 1').get(parsed.data.keyId, platform.data) as any
    : db.prepare("SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 ORDER BY CASE status WHEN 'healthy' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END, id DESC LIMIT 1").get(platform.data) as any;

  if (!keyRow) {
    res.status(400).json({ ok: false, modelId: parsed.data.modelId, message: 'Add an enabled key for this endpoint before probing a model.' });
    return;
  }

  const provider = getProvider(platform.data);
  if (!provider) {
    res.status(404).json({ error: { message: 'Endpoint not found' } });
    return;
  }

  const started = Date.now();
  try {
    const key = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
    const completion = await provider.chatCompletion(key, [
      { role: 'system', content: 'Reply with exactly: harbor-ok' },
      { role: 'user', content: 'LLMHarbor model probe.' },
    ], parsed.data.modelId, { temperature: 0, max_tokens: 16 });

    const sample = completion.choices?.[0]?.message?.content ?? '';
    res.json({
      ok: true,
      platform: platform.data,
      modelId: parsed.data.modelId,
      keyId: keyRow.id,
      latencyMs: Date.now() - started,
      sample: typeof sample === 'string' ? sample : JSON.stringify(sample),
      usage: completion.usage ?? null,
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      platform: platform.data,
      modelId: parsed.data.modelId,
      keyId: keyRow.id,
      latencyMs: Date.now() - started,
      message: error instanceof Error ? error.message : 'Model probe failed',
    });
  }
});

endpointsRouter.post('/:platform/models', (req: Request, res: Response) => {
  const platform = platformSchema.safeParse(req.params.platform);
  if (!platform.success || !endpointExists(platform.data)) {
    res.status(404).json({ error: { message: 'Endpoint not found' } });
    return;
  }

  const parsed = modelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    platform.data,
    parsed.data.modelId,
    parsed.data.displayName,
    parsed.data.intelligenceRank,
    parsed.data.speedRank,
    parsed.data.sizeLabel,
    parsed.data.rpmLimit ?? null,
    parsed.data.rpdLimit ?? null,
    parsed.data.tpmLimit ?? null,
    parsed.data.tpdLimit ?? null,
    parsed.data.monthlyTokenBudget,
    parsed.data.contextWindow ?? null,
    parsed.data.enabled ? 1 : 0,
  );
  addFallbackForModel(Number(result.lastInsertRowid));

  res.status(201).json({
    id: result.lastInsertRowid,
    platform: platform.data,
    modelId: parsed.data.modelId,
    displayName: parsed.data.displayName,
    intelligenceRank: parsed.data.intelligenceRank,
    speedRank: parsed.data.speedRank,
    sizeLabel: parsed.data.sizeLabel,
    rpmLimit: parsed.data.rpmLimit ?? null,
    rpdLimit: parsed.data.rpdLimit ?? null,
    tpmLimit: parsed.data.tpmLimit ?? null,
    tpdLimit: parsed.data.tpdLimit ?? null,
    monthlyTokenBudget: parsed.data.monthlyTokenBudget,
    contextWindow: parsed.data.contextWindow ?? null,
    enabled: parsed.data.enabled,
  });
});

endpointsRouter.delete('/:platform/models/:modelDbId', (req: Request, res: Response) => {
  const platform = platformSchema.safeParse(req.params.platform);
  const modelDbId = Number(req.params.modelDbId);
  if (!platform.success || Number.isNaN(modelDbId)) {
    res.status(400).json({ error: { message: 'Invalid endpoint or model id' } });
    return;
  }

  const db = getDb();
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(modelDbId);
    return db.prepare('DELETE FROM models WHERE id = ? AND platform = ?').run(modelDbId, platform.data);
  });
  const result = remove();
  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Model not found' } });
    return;
  }
  res.json({ success: true });
});
