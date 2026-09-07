import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getRouteCredentials, prepareProviderCredential } from '../services/credentials.js';
import { clearDynamicProvider, getBuiltInProviderSummaries, getProvider, hasProvider } from '../providers/index.js';
import { safeUpstreamFailure } from '../lib/errors.js';
import { parsePositiveResourceId } from '../lib/resourceId.js';
import { toUtcTimestamp } from '../lib/time.js';
import { normalizeCustomEndpointUrl } from '../lib/urlSecurity.js';

export const endpointsRouter = Router();

const platformSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);

const endpointUrlSchema = z.string().trim().min(1).max(500).superRefine((value, context) => {
  try {
    normalizeCustomEndpointUrl(value);
  } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'Invalid endpoint URL.' });
  }
});

const endpointSchema = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: endpointUrlSchema,
  validateUrl: endpointUrlSchema.optional().nullable(),
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
});

const endpointPatchSchema = endpointSchema
  .partial()
  .extend({ enabled: z.boolean().optional() })
  .refine(value => Object.keys(value).length > 0, {
    message: 'Provide at least one endpoint field to update.',
  });

const modelSchema = z.object({
  modelId: z.string().trim().min(1).max(240),
  displayName: z.string().trim().min(1).max(160),
  intelligenceRank: z.number().int().min(1).max(999).default(50),
  speedRank: z.number().int().min(1).max(999).default(50),
  sizeLabel: z.string().max(60).default('Custom'),
  rpmLimit: z.number().int().positive().safe().nullable().optional(),
  rpdLimit: z.number().int().positive().safe().nullable().optional(),
  tpmLimit: z.number().int().positive().safe().nullable().optional(),
  tpdLimit: z.number().int().positive().safe().nullable().optional(),
  monthlyTokenBudget: z.string().max(80).default('custom'),
  contextWindow: z.number().int().positive().safe().nullable().optional(),
  enabled: z.boolean().default(true),
});

const modelPatchSchema = modelSchema.omit({ modelId: true }).partial().strict()
  .refine(value => Object.keys(value).length > 0, { message: 'Provide at least one model field to update.' });

const probeSchema = z.object({
  modelId: z.string().min(1).max(240),
  keyId: z.number().int().positive().safe().optional(),
});

function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'endpoint';
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
  // A newly typed model ID is unverified. Enroll it visibly at the bottom of
  // Routing, but require an explicit operator enable after a successful probe
  // before automatic traffic can reach it.
  db.prepare('INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 0)')
    .run(modelDbId, maxPriority + 1);
}

function endpointExists(platform: string): boolean {
  // Disabled custom endpoints deliberately have no active provider adapter,
  // but their configuration and models must remain manageable.
  return customEndpointExists(platform) || hasProvider(platform);
}

function customEndpointExists(platform: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM custom_endpoints WHERE platform = ?').get(platform);
}

function customEndpointEnabled(platform: string): boolean | null {
  const row = getDb().prepare('SELECT enabled FROM custom_endpoints WHERE platform = ?').get(platform) as { enabled: number } | undefined;
  return row ? row.enabled === 1 : null;
}

interface CredentialCountRow {
  platform: string;
  enabled: number;
  status: string;
  source: string | null;
  oauth_enabled: number | null;
  metadata_json: string | null;
}

interface EndpointCounts {
  modelCount: number;
  configuredKeyCount: number;
  enabledKeyCount: number;
  availableKeyCount: number;
}

function endpointCounts(db = getDb()): Map<string, EndpointCounts> {
  const counts = new Map<string, EndpointCounts>();
  const modelRows = db.prepare(`
    SELECT platform, COUNT(*) AS count
    FROM models
    GROUP BY platform
  `).all() as Array<{ platform: string; count: number }>;
  for (const row of modelRows) {
    counts.set(row.platform, {
      modelCount: row.count,
      configuredKeyCount: 0,
      enabledKeyCount: 0,
      availableKeyCount: 0,
    });
  }

  // Select metadata only: encrypted credential material must never enter an
  // endpoint-summary response or the code constructing it.
  const credentialRows = db.prepare(`
    SELECT ak.platform, ak.enabled, ak.status, ak.source,
           oa.enabled AS oauth_enabled, oa.metadata_json
    FROM api_keys ak
    LEFT JOIN oauth_accounts oa ON oa.id = ak.oauth_account_id
  `).all() as CredentialCountRow[];
  for (const row of credentialRows) {
    const count = counts.get(row.platform) ?? {
      modelCount: 0,
      configuredKeyCount: 0,
      enabledKeyCount: 0,
      availableKeyCount: 0,
    };
    count.configuredKeyCount += 1;
    if (row.enabled === 1) {
      count.enabledKeyCount += 1;
      let oauthNeedsReconnect = false;
      if (row.source === 'oauth' && row.metadata_json) {
        try {
          oauthNeedsReconnect = JSON.parse(row.metadata_json).oauthNeedsReconnect === true;
        } catch {
          oauthNeedsReconnect = true;
        }
      }
      const available = row.source === 'oauth'
        ? row.oauth_enabled === 1 && !oauthNeedsReconnect && row.status !== 'invalid' && row.status !== 'error'
        : row.status === 'healthy' || row.status === 'unknown';
      if (available) count.availableKeyCount += 1;
    }
    counts.set(row.platform, count);
  }
  return counts;
}

function serializeEndpointCounts(counts: EndpointCounts) {
  return {
    modelCount: counts.modelCount,
    // keyCount is retained as the configured count for existing clients.
    keyCount: counts.configuredKeyCount,
    configuredKeyCount: counts.configuredKeyCount,
    enabledKeyCount: counts.enabledKeyCount,
    availableKeyCount: counts.availableKeyCount,
  };
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
    SELECT ce.*
    FROM custom_endpoints ce
    ORDER BY ce.created_at DESC
  `).all() as any[];
  const counts = endpointCounts(db);

  const builtIns = getBuiltInProviderSummaries().map(provider => {
    const stats = counts.get(provider.platform) ?? {
      modelCount: 0,
      configuredKeyCount: 0,
      enabledKeyCount: 0,
      availableKeyCount: 0,
    };
    return {
      id: null,
      platform: provider.platform,
      name: provider.name,
      baseUrl: provider.baseUrl,
      validateUrl: null,
      timeoutMs: provider.timeoutMs ?? 15000,
      enabled: true,
      custom: false,
      credentialMode: provider.credentialMode,
      createdAt: null,
      ...serializeEndpointCounts(stats),
    };
  });

  const custom = customEndpoints.map(e => {
    const stats = counts.get(e.platform) ?? {
      modelCount: 0,
      configuredKeyCount: 0,
      enabledKeyCount: 0,
      availableKeyCount: 0,
    };
    return {
      id: e.id,
      platform: e.platform,
      name: e.name,
      baseUrl: e.base_url,
      validateUrl: e.validate_url,
      timeoutMs: e.timeout_ms,
      enabled: e.enabled === 1,
      custom: true,
      credentialMode: 'api-key',
      createdAt: toUtcTimestamp(e.created_at),
      ...serializeEndpointCounts(stats),
    };
  });

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
    normalizeCustomEndpointUrl(parsed.data.baseUrl),
    parsed.data.validateUrl ? normalizeCustomEndpointUrl(parsed.data.validateUrl) : null,
    parsed.data.timeoutMs ?? 120000,
  );
  clearDynamicProvider(platform);

  res.status(201).json({
    id: result.lastInsertRowid,
    platform,
    name: parsed.data.name,
    baseUrl: normalizeCustomEndpointUrl(parsed.data.baseUrl),
    validateUrl: parsed.data.validateUrl ? normalizeCustomEndpointUrl(parsed.data.validateUrl) : null,
    timeoutMs: parsed.data.timeoutMs ?? 120000,
    enabled: true,
    custom: true,
    credentialMode: 'api-key',
    ...serializeEndpointCounts({
      modelCount: 0,
      configuredKeyCount: 0,
      enabledKeyCount: 0,
      availableKeyCount: 0,
    }),
  });
});

endpointsRouter.patch('/:platform', (req: Request, res: Response) => {
  const platform = platformSchema.safeParse(req.params.platform);
  if (!platform.success || !customEndpointExists(platform.data)) {
    res.status(404).json({ error: { message: 'Custom endpoint not found' } });
    return;
  }

  const parsed = endpointPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const existing = getDb().prepare('SELECT * FROM custom_endpoints WHERE platform = ?').get(platform.data) as any;
  const next = {
    name: parsed.data.name ?? existing.name,
    baseUrl: parsed.data.baseUrl ? normalizeCustomEndpointUrl(parsed.data.baseUrl) : existing.base_url,
    validateUrl: parsed.data.validateUrl === undefined ? existing.validate_url : (parsed.data.validateUrl ? normalizeCustomEndpointUrl(parsed.data.validateUrl) : null),
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

  if (customEndpointEnabled(platform.data) === false) {
    const message = 'Enable this custom endpoint before probing a model.';
    res.status(409).json({
      ok: false,
      platform: platform.data,
      modelId: parsed.data.modelId,
      message,
      error: { message, type: 'conflict', code: 'endpoint_disabled' },
    });
    return;
  }

  const credentials = getRouteCredentials(platform.data, parsed.data.modelId);
  const keyRow = parsed.data.keyId
    ? credentials.find(key => key.id === parsed.data.keyId)
    : credentials[0];

  if (!keyRow) {
    res.status(400).json({ ok: false, modelId: parsed.data.modelId, message: 'Add an enabled, usable credential that supports this model before probing it.' });
    return;
  }

  const provider = getProvider(platform.data);
  if (!provider) {
    res.status(404).json({ error: { message: 'Endpoint not found' } });
    return;
  }

  const started = Date.now();
  const abortController = new AbortController();
  const abortProbe = () => abortController.abort(new DOMException('Client disconnected.', 'AbortError'));
  const abortOnClose = () => {
    if (!res.writableEnded) abortProbe();
  };
  req.once('aborted', abortProbe);
  res.once('close', abortOnClose);
  try {
    const credential = await prepareProviderCredential(keyRow.id, abortController.signal);
    const completion = await provider.chatCompletion(credential.apiKey, [
      { role: 'system', content: 'Reply with exactly: harbor-ok' },
      { role: 'user', content: 'LLMHarbor model probe.' },
    ], parsed.data.modelId, { temperature: 0, max_tokens: 16, oauth: credential.oauth, signal: abortController.signal });

    if (abortController.signal.aborted) return;

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
    if (abortController.signal.aborted) return;
    res.status(502).json({
      ok: false,
      platform: platform.data,
      modelId: parsed.data.modelId,
      keyId: keyRow.id,
      latencyMs: Date.now() - started,
      message: safeUpstreamFailure(error, 'Model probe failed.'),
    });
  } finally {
    req.off('aborted', abortProbe);
    res.off('close', abortOnClose);
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
  const insertModel = db.transaction(() => {
    const result = db.prepare(`
      INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled)
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
    if (result.changes === 0) return null;
    const modelDbId = Number(result.lastInsertRowid);
    addFallbackForModel(modelDbId);
    return modelDbId;
  });
  const modelDbId = insertModel();
  if (modelDbId === null) {
    res.status(409).json({
      error: {
        message: `Model '${parsed.data.modelId}' is already registered for endpoint '${platform.data}'.`,
        type: 'conflict',
        code: 'model_already_exists',
        param: 'modelId',
      },
    });
    return;
  }

  res.status(201).json({
    id: modelDbId,
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

endpointsRouter.patch('/:platform/models/:modelDbId', (req: Request, res: Response) => {
  const platform = platformSchema.safeParse(req.params.platform);
  const modelDbId = parsePositiveResourceId(req.params.modelDbId);
  if (!platform.success || !endpointExists(platform.data)) {
    res.status(404).json({ error: { message: 'Endpoint not found' } });
    return;
  }
  if (modelDbId === null) {
    res.status(400).json({ error: { message: 'Invalid model id' } });
    return;
  }
  const parsed = modelPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(error => error.message).join(', ') } });
    return;
  }
  const db = getDb();
  // Column names come exclusively from this fixed mapping. Omitted fields
  // retain their values, while explicit null clears a configured limit.
  const columns = {
    displayName: 'display_name', intelligenceRank: 'intelligence_rank', speedRank: 'speed_rank',
    sizeLabel: 'size_label', rpmLimit: 'rpm_limit', rpdLimit: 'rpd_limit',
    tpmLimit: 'tpm_limit', tpdLimit: 'tpd_limit', monthlyTokenBudget: 'monthly_token_budget',
    contextWindow: 'context_window', enabled: 'enabled',
  } as const;
  const fields = Object.keys(parsed.data) as Array<keyof typeof columns>;
  const result = db.prepare(`UPDATE models SET ${fields.map(field => `${columns[field]} = ?`).join(', ')} WHERE id = ? AND platform = ?`)
    .run(...fields.map(field => field === 'enabled' ? Number(parsed.data[field]) : parsed.data[field]), modelDbId, platform.data);
  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Model not found' } });
    return;
  }
  const model = db.prepare(`
    SELECT m.*, fc.priority, fc.enabled AS fallback_enabled FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id WHERE m.id = ?
  `).get(modelDbId);
  res.json(serializeModel(model));
});

endpointsRouter.delete('/:platform/models/:modelDbId', (req: Request, res: Response) => {
  const platform = platformSchema.safeParse(req.params.platform);
  if (!platform.success || !endpointExists(platform.data)) {
    res.status(404).json({ error: { message: 'Endpoint not found' } });
    return;
  }
  const modelDbId = parsePositiveResourceId(req.params.modelDbId);
  if (modelDbId === null) {
    res.status(400).json({ error: { message: 'Invalid model id' } });
    return;
  }

  const db = getDb();
  const remove = db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM models WHERE id = ? AND platform = ?').get(modelDbId, platform.data)) return null;
    db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(modelDbId);
    return db.prepare('DELETE FROM models WHERE id = ? AND platform = ?').run(modelDbId, platform.data);
  });
  const result = remove();
  if (!result || result.changes === 0) {
    res.status(404).json({ error: { message: 'Model not found' } });
    return;
  }
  res.json({ success: true });
});
