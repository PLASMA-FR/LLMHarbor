import { sendValidationError } from '../lib/validation.js';
import { Router } from 'express';
import { createHash } from 'node:crypto';
import { parsePositiveResourceId } from '../lib/resourceId.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getAllPenalties, getAllRouteFailureCircuits } from '../services/router.js';
import { canMakeRequest, canUseTokens, isOnCooldown } from '../services/ratelimit.js';
import { hasProvider } from '../providers/index.js';

export const fallbackRouter = Router();

function routingVersion(): string {
  const rows = getDb().prepare('SELECT model_db_id, priority, enabled FROM fallback_config ORDER BY model_db_id').all();
  return `"${createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 32)}"`;
}

fallbackRouter.patch('/models/:id', (req, res) => {
  const id = parsePositiveResourceId(req.params.id);
  if (id === null) { res.status(400).json({ error: { message: 'Provide a positive model ID.', param: 'id' } }); return; }
  const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
  if (!parsed.success) { sendValidationError(res, parsed.error); return; }
  const result = getDb().prepare('UPDATE fallback_config SET enabled = ? WHERE model_db_id = ?').run(Number(parsed.data.enabled), id);
  if (!result.changes) { res.status(404).json({ error: { message: 'Routing entry not found.' } }); return; }
  const row = getDb().prepare('SELECT priority, enabled FROM fallback_config WHERE model_db_id = ?').get(id) as { priority: number; enabled: number };
  res.setHeader('ETag', routingVersion());
  res.json({ modelDbId: id, priority: row.priority, enabled: row.enabled === 1 });
});

// Get fallback chain (with dynamic penalties)
fallbackRouter.get('/', (_req: Request, res: Response) => {
  res.setHeader('ETag', routingVersion());
  const db = getDb();
  const rows = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled, m.enabled AS model_enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit,
           m.monthly_token_budget
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    ORDER BY fc.priority ASC, fc.model_db_id ASC
  `).all() as any[];

  const keysForModel = db.prepare(`
    SELECT ak.id, ak.enabled, ak.status, ak.source,
           oa.enabled AS oauth_enabled, oa.metadata_json,
           CASE WHEN ak.oauth_account_id IS NULL THEN 0 ELSE (
             SELECT COUNT(*) FROM oauth_account_models known
              WHERE known.oauth_account_id = ak.oauth_account_id
           ) END AS oauth_known_models,
           CASE WHEN ak.oauth_account_id IS NULL THEN 1 ELSE EXISTS (
             SELECT 1 FROM oauth_account_models eligible
              WHERE eligible.oauth_account_id = ak.oauth_account_id
                AND eligible.platform = ak.platform
                AND eligible.model_id = ?
                AND eligible.supported = 1
           ) END AS oauth_model_eligible
      FROM api_keys ak
      LEFT JOIN oauth_accounts oa ON oa.id = ak.oauth_account_id
     WHERE ak.platform = ?
  `);
  const customEndpointState = db.prepare('SELECT enabled FROM custom_endpoints WHERE platform = ?');

  // Get current dynamic penalties
  const penalties = getAllPenalties();
  const penaltyMap = new Map(penalties.map(p => [p.modelDbId, p]));
  const failureCircuitMap = new Map(getAllRouteFailureCircuits().map(circuit => [circuit.modelDbId, circuit]));

  res.json(rows.map(r => {
    const penalty = penaltyMap.get(r.model_db_id);
    const failureCircuit = failureCircuitMap.get(r.model_db_id);
    const configuredKeys = keysForModel.all(r.model_id, r.platform) as any[];
    const enabledKeys = configuredKeys.filter(key => key.enabled === 1);
    const routeableKeys = enabledKeys.filter(key => {
      if (!(key.status === 'healthy' || key.status === 'unknown'
        || (key.source === 'oauth' && key.status !== 'invalid' && key.status !== 'error'))) return false;
      if (key.source !== 'oauth') return true;
      let metadata: Record<string, unknown> = {};
      try { metadata = key.metadata_json ? JSON.parse(key.metadata_json) : {}; } catch {}
      return key.oauth_enabled === 1
        && metadata.oauthNeedsReconnect !== true
        && (key.oauth_known_models === 0 || key.oauth_model_eligible === 1);
    });
    const activeCooldowns = routeableKeys.filter(key => isOnCooldown(r.platform, r.model_id, key.id)).length;
    const limits = { rpm: r.rpm_limit, rpd: r.rpd_limit, tpm: r.tpm_limit, tpd: r.tpd_limit };
    const availableKeys = routeableKeys.filter(key => (
      !isOnCooldown(r.platform, r.model_id, key.id)
      && canMakeRequest(r.platform, r.model_id, key.id, limits)
      && canUseTokens(r.platform, r.model_id, key.id, 1, limits)
    ));
    const endpoint = customEndpointState.get(r.platform) as { enabled: number } | undefined;
    const providerAvailable = hasProvider(r.platform);
    const routeableKeyCount = routeableKeys.length;
    const skipReason = r.enabled !== 1
      ? 'Disabled in fallback configuration'
      : r.model_enabled !== 1
        ? 'Model is disabled'
        : endpoint?.enabled === 0
          ? 'Custom endpoint is disabled'
            : !providerAvailable
              ? 'Provider adapter is unavailable'
            : failureCircuit && failureCircuit.until > Date.now()
              ? 'Temporarily isolated after repeated upstream failures'
            : configuredKeys.length === 0
              ? 'No configured credential'
              : enabledKeys.length === 0
                ? 'All credentials are disabled'
                : routeableKeyCount === 0
                  ? 'No healthy credential supports this model'
                  : availableKeys.length === 0 && activeCooldowns >= routeableKeyCount
                    ? 'All routeable credentials are cooling down'
                    : availableKeys.length === 0
                      ? 'All routeable credentials are at a configured quota limit'
                      : null;
    return {
      modelDbId: r.model_db_id,
      priority: r.priority,
      effectivePriority: r.priority + (penalty?.penalty ?? 0),
      penalty: penalty?.penalty ?? 0,
      rateLimitHits: penalty?.count ?? 0,
      routeFailureCount: failureCircuit?.count ?? 0,
      routeFailureUntil: failureCircuit?.until ? new Date(failureCircuit.until).toISOString() : null,
      enabled: r.enabled === 1,
      modelEnabled: r.model_enabled === 1,
      eligible: skipReason === null,
      skipReason,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      intelligenceRank: r.intelligence_rank,
      speedRank: r.speed_rank,
      sizeLabel: r.size_label,
      rpmLimit: r.rpm_limit,
      rpdLimit: r.rpd_limit,
      monthlyTokenBudget: r.monthly_token_budget,
      keyCount: routeableKeyCount,
      configuredKeyCount: configuredKeys.length,
      enabledKeyCount: enabledKeys.length,
      routeableKeyCount,
      availableKeyCount: availableKeys.length,
      activeCooldowns,
    };
  }));
});

const updateSchema = z.array(z.object({
  modelDbId: z.number().int().positive(),
  priority: z.number().int().positive(),
  enabled: z.boolean(),
}).strict()).min(1);

// Update fallback chain (full replace)
fallbackRouter.put('/', (req: Request, res: Response) => {
  if (req.get('If-Match') && req.get('If-Match') !== routingVersion()) {
    res.status(409).json({ error: { message: 'Routing changed while you were editing. Reload the latest order before saving.', code: 'routing_conflict', type: 'conflict' } });
    return;
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }

  const db = getDb();
  const modelIds = parsed.data.map(entry => entry.modelDbId);
  const priorities = parsed.data.map(entry => entry.priority);
  if (new Set(modelIds).size !== modelIds.length || new Set(priorities).size !== priorities.length) {
    res.status(400).json({ error: { message: 'Fallback entries must have unique model IDs and priorities.', type: 'invalid_request_error', code: 'duplicate_fallback_entry' } });
    return;
  }
  const placeholders = modelIds.map(() => '?').join(', ');
  const known = db.prepare(`SELECT model_db_id FROM fallback_config WHERE model_db_id IN (${placeholders})`).all(...modelIds) as Array<{ model_db_id: number }>;
  if (known.length !== modelIds.length) {
    const knownIds = new Set(known.map(row => row.model_db_id));
    const unknown = modelIds.filter(id => !knownIds.has(id));
    res.status(400).json({ error: { message: `Unknown fallback model ID(s): ${unknown.join(', ')}`, type: 'invalid_request_error', code: 'unknown_fallback_model' } });
    return;
  }
  const update = db.prepare(`
    UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?
  `);

  const updateAll = db.transaction(() => {
    for (const entry of parsed.data) {
      update.run(entry.priority, entry.enabled ? 1 : 0, entry.modelDbId);
    }
  });
  updateAll();
  res.setHeader('ETag', routingVersion());
  res.json({ success: true });
});

// Sort presets — `orderBy` is selected from a fixed whitelist, never from
// user input directly, so the interpolation below is safe.
const SORT_PRESETS: Record<string, string> = {
  intelligence: 'm.intelligence_rank ASC',
  speed: 'm.speed_rank ASC',
  budget: "CASE m.monthly_token_budget WHEN '~120M' THEN 1 WHEN '~50-100M' THEN 2 WHEN '~30M' THEN 3 WHEN '~18-45M' THEN 4 WHEN '~18M' THEN 5 WHEN '~15M' THEN 6 WHEN '~12M' THEN 7 WHEN '~6M' THEN 8 WHEN '~5-10M' THEN 9 WHEN '~4M' THEN 10 ELSE 11 END ASC",
};

fallbackRouter.get('/presets/:preset', (req, res) => {
  const preset = String(req.params.preset);
  if (!Object.hasOwn(SORT_PRESETS, preset)) {
    res.status(400).json({ error: { message: 'Choose intelligence, speed, or budget.', param: 'preset' } }); return;
  }
  const models = getDb().prepare(`SELECT m.id FROM models m ORDER BY ${SORT_PRESETS[preset]}, m.id ASC`).all() as Array<{ id: number }>;
  res.json({ preset, order: models.map(model => model.id) });
});

fallbackRouter.post('/sort/:preset', (req: Request, res: Response) => {
  const preset = String(req.params.preset);
  const orderBy = Object.hasOwn(SORT_PRESETS, preset) ? SORT_PRESETS[preset] : undefined;
  if (!orderBy) {
    res.status(400).json({ error: { message: `Unknown preset: ${preset}. Use: intelligence, speed, budget` } });
    return;
  }

  const db = getDb();
  const models = db.prepare(`SELECT m.id FROM models m ORDER BY ${orderBy}, m.id ASC`).all() as { id: number }[];

  const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
  const reorder = db.transaction(() => {
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });
  reorder();

  res.json({ success: true, preset });
});

// Token usage per model for the stacked bar
fallbackRouter.get('/token-usage', (_req: Request, res: Response) => {
  const db = getDb();

  // Get platforms that have enabled keys
  const platforms = db.prepare(`
    SELECT DISTINCT ak.platform
    FROM api_keys ak
    WHERE ak.enabled = 1
  `).all() as { platform: string }[];
  const platformSet = new Set(platforms.map(p => p.platform));

  // Get monthly budget per model, ordered by fallback priority
  const models = db.prepare(`
    SELECT m.platform, m.model_id, m.display_name, m.monthly_token_budget,
           fc.priority
    FROM models m
    JOIN fallback_config fc ON fc.model_db_id = m.id
    WHERE m.enabled = 1
    ORDER BY fc.priority ASC
  `).all() as { platform: string; model_id: string; display_name: string; monthly_token_budget: string; priority: number }[];

  function parseBudget(s: string): number {
    const m = s.match(/~?([\d.]+)(?:-([\d.]+))?([MK])?/);
    if (!m) return 0;
    const high = parseFloat(m[2] ?? m[1]);
    const unit = m[3] === 'M' ? 1_000_000 : m[3] === 'K' ? 1_000 : 1;
    return high * unit;
  }

  // Build per-model breakdown (only platforms with keys)
  const modelBudgets = models
    .filter(m => platformSet.has(m.platform))
    .map(m => ({
      displayName: m.display_name,
      platform: m.platform,
      budget: parseBudget(m.monthly_token_budget),
    }));

  const totalBudget = modelBudgets.reduce((s, m) => s + m.budget, 0);

  // Tokens used this month
  const usage = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens + output_tokens), 0) as total_used
    FROM requests
    WHERE is_final = 1 AND created_at >= datetime('now', 'start of month')
  `).get() as { total_used: number };

  res.json({
    totalBudget,
    totalUsed: usage.total_used,
    models: modelBudgets,
  });
});
