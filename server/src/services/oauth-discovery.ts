import type Database from 'better-sqlite3';
import { decrypt } from '../lib/crypto.js';
import { safeUpstreamFailure } from '../lib/errors.js';
import { ProviderError, ProviderProtocolError } from '../providers/base.js';
import { FREEBUFF_CATALOG_MODELS } from '../providers/freebuff.js';
import { ensureFreshOAuthAccount } from './oauth-refresh.js';

export type OAuthLimitWindow = {
  label: string;
  usedPercent: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
};

export type OAuthDiscoveredModel = {
  id: string;
  displayName: string;
  platform: 'openai' | 'google-oauth' | 'freebuff';
  priority: number;
  speedRank: number;
  sizeLabel: string;
  contextWindow: number | null;
  supported: boolean;
  visibility?: string | null;
};

export type OAuthDiscoveryResult = {
  models: OAuthDiscoveredModel[];
  limits: OAuthLimitWindow[];
  metadata: Record<string, unknown>;
};

const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=999.0.0';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/codex/usage';
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
export const DISCOVERY_BLACKLIST = new Set(['gpt-5-codex', 'gpt-5.1-codex']);

function boundedDiscoverySignal(signal?: AbortSignal, timeoutMs = 15_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function codeAssistPlatform() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 2 : 1;
  if (process.platform === 'linux') return process.arch === 'arm64' ? 4 : 3;
  if (process.platform === 'win32') return 5;
  return 0;
}

function codeAssistMetadata() {
  return {
    ideType: 9,
    platform: codeAssistPlatform(),
    pluginType: 2,
  };
}

function codeAssistModelRank(modelId: string, index: number) {
  const lower = modelId.toLowerCase();
  if (lower.includes('claude') && lower.includes('opus')) return 1;
  if (lower.includes('gemini') && lower.includes('pro')) return 2;
  if (lower.includes('claude') && lower.includes('sonnet')) return 3;
  if (lower.includes('gemini') && lower.includes('flash')) return 6;
  return 20 + index;
}

function codeAssistSpeedRank(modelId: string) {
  const lower = modelId.toLowerCase();
  if (lower.includes('lite')) return 1;
  if (lower.includes('flash')) return 2;
  if (lower.includes('sonnet')) return 4;
  if (lower.includes('pro') || lower.includes('opus')) return 6;
  return 3;
}

function codeAssistSizeLabel(modelId: string) {
  const lower = modelId.toLowerCase();
  if (lower.includes('lite')) return 'Small';
  if (lower.includes('flash') || lower.includes('sonnet')) return 'Medium';
  return 'Frontier';
}

function isCodeAssistModel(modelId: string) {
  const lower = modelId.toLowerCase();
  return lower.includes('gemini') || lower.includes('claude') || lower.includes('gemma');
}

function limitWindow(label: string, value: any): OAuthLimitWindow | null {
  if (!value || typeof value !== 'object') return null;
  return {
    label,
    usedPercent: typeof value.used_percent === 'number' ? value.used_percent : null,
    resetAfterSeconds: typeof value.reset_after_seconds === 'number' ? value.reset_after_seconds : null,
    resetAt: typeof value.reset_at === 'number' ? value.reset_at : null,
  };
}

function parseOpenAILimits(usage: any): OAuthLimitWindow[] {
  const rate = usage?.rate_limit;
  return [
    limitWindow('Primary window', rate?.primary_window),
    limitWindow('Secondary window', rate?.secondary_window),
  ].filter(Boolean) as OAuthLimitWindow[];
}

function parseGoogleLimits(load: any): OAuthLimitWindow[] {
  const credits = load?.paidTier?.availableCredits ?? load?.currentTier?.availableCredits ?? [];
  const windows: OAuthLimitWindow[] = [];
  for (const credit of Array.isArray(credits) ? credits : []) {
    const amount = Number.parseInt(String(credit.creditAmount ?? '0'), 10);
    if (!Number.isNaN(amount)) {
      windows.push({ label: String(credit.creditType ?? 'Credits'), usedPercent: null, resetAfterSeconds: null, resetAt: null });
    }
  }
  if (windows.length === 0 && (load?.currentTier || load?.paidTier)) {
    windows.push({ label: load?.paidTier?.name ?? load?.currentTier?.name ?? 'Account quota', usedPercent: null, resetAfterSeconds: null, resetAt: null });
  }
  return windows;
}


export function updateOAuthModels(db: Database.Database, models: OAuthDiscoveredModel[], accountId?: number) {
  const previousPlatforms = accountId === undefined
    ? []
    : (db.prepare('SELECT DISTINCT platform FROM oauth_account_models WHERE oauth_account_id = ?').all(accountId) as Array<{ platform: OAuthDiscoveredModel['platform'] }>).map(row => row.platform);
  if (accountId !== undefined) {
    const replaceEligibility = db.transaction(() => {
      db.prepare('DELETE FROM oauth_account_models WHERE oauth_account_id = ?').run(accountId);
      const insert = db.prepare(`
        INSERT INTO oauth_account_models (oauth_account_id, platform, model_id, supported, discovered_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `);
      for (const model of models) insert.run(accountId, model.platform, model.id, model.supported ? 1 : 0);
    });
    replaceEligibility();
  }

  db.prepare(`
    UPDATE models
       SET enabled = 0
     WHERE platform = 'openai'
       AND model_id IN ('gpt-5-codex', 'gpt-5.1-codex')
       AND display_name LIKE '%browser account%'
  `).run();
  db.prepare(`
    DELETE FROM fallback_config
     WHERE model_db_id IN (
       SELECT id FROM models
        WHERE platform = 'openai'
          AND model_id IN ('gpt-5-codex', 'gpt-5.1-codex')
          AND display_name LIKE '%browser account%'
     )
  `).run();

  const platforms = [...new Set([...previousPlatforms, ...models.map(model => model.platform)])];
  if (accountId === undefined) {
    if (models.length === 0) return;
    for (const platform of platforms) {
      db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = ? AND display_name LIKE '%browser account%')").run(platform);
      db.prepare("DELETE FROM models WHERE platform = ? AND display_name LIKE '%browser account%' AND model_id NOT IN ('gpt-5-codex', 'gpt-5.1-codex')").run(platform);
    }
  }
  const insertModel = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'account plan', ?, ?)
    ON CONFLICT(platform, model_id) DO UPDATE SET
      display_name = CASE WHEN models.display_name LIKE '%browser account%' THEN excluded.display_name ELSE models.display_name END,
      intelligence_rank = CASE WHEN models.display_name LIKE '%browser account%' THEN excluded.intelligence_rank ELSE models.intelligence_rank END,
      speed_rank = CASE WHEN models.display_name LIKE '%browser account%' THEN excluded.speed_rank ELSE models.speed_rank END,
      size_label = CASE WHEN models.display_name LIKE '%browser account%' THEN excluded.size_label ELSE models.size_label END,
      context_window = CASE WHEN models.display_name LIKE '%browser account%' THEN excluded.context_window ELSE models.context_window END,
      monthly_token_budget = CASE WHEN models.display_name LIKE '%browser account%' THEN excluded.monthly_token_budget ELSE models.monthly_token_budget END,
      enabled = CASE WHEN models.display_name LIKE '%browser account%' THEN excluded.enabled ELSE models.enabled END
  `);
  const insertFallback = db.prepare('INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
  let priority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS priority FROM fallback_config').get() as { priority: number }).priority;
  for (const model of models) {
    insertModel.run(model.platform, model.id, model.displayName, model.priority, model.speedRank, model.sizeLabel, model.contextWindow, model.supported ? 1 : 0);
    const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(model.platform, model.id) as { id: number } | undefined;
    if (row && model.supported) insertFallback.run(row.id, ++priority);
  }

  if (accountId !== undefined) {
    // A platform catalog is the union of all connected accounts. A model is
    // routeable only while at least one enabled account explicitly advertises
    // it; refreshing one account must not erase another account's inventory.
    const browserRows = db.prepare(`
      SELECT id, platform, model_id
        FROM models
       WHERE platform = ? AND display_name LIKE '%browser account%'
    `);
    const supported = db.prepare(`
      SELECT 1
        FROM oauth_account_models oam
        JOIN oauth_accounts oa ON oa.id = oam.oauth_account_id
       WHERE oam.platform = ? AND oam.model_id = ? AND oam.supported = 1 AND oa.enabled = 1
       LIMIT 1
    `);
    const reconcile = db.transaction(() => {
      for (const platform of platforms) {
        for (const row of browserRows.all(platform) as Array<{ id: number; platform: string; model_id: string }>) {
          const enabled = Boolean(supported.get(row.platform, row.model_id));
          db.prepare('UPDATE models SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, row.id);
          if (enabled) insertFallback.run(row.id, ++priority);
          else db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(row.id);
        }
      }
    });
    reconcile();
  }
}

export function disableOAuthModelsForPlatform(db: Database.Database, platform: OAuthDiscoveredModel['platform'], reason: string) {
  db.prepare(`
    DELETE FROM fallback_config
     WHERE model_db_id IN (
       SELECT id FROM models WHERE platform = ? AND display_name LIKE '%browser account%'
     )
  `).run(platform);
  db.prepare(`
    UPDATE models
       SET enabled = 0,
           display_name = display_name || CASE WHEN display_name LIKE '%(discovery unavailable)%' THEN '' ELSE ' (discovery unavailable)' END
     WHERE platform = ?
       AND display_name LIKE '%browser account%'
  `).run(platform);
  return { platform, reason };
}

function removeFailedAccountInventory(
  db: Database.Database,
  accountId: number,
  platform: OAuthDiscoveredModel['platform'],
  reason: string,
) {
  const accountInventory = db.prepare(
    'SELECT COUNT(*) AS count FROM oauth_account_models WHERE oauth_account_id = ?',
  ).get(accountId) as { count: number };
  if (accountInventory.count > 0) {
    updateOAuthModels(db, [], accountId);
    return;
  }

  // Pre-migration accounts have no per-account inventory. Preserve a catalog
  // that may belong to another enabled account, but retain the historical
  // single-account behavior when there is no ambiguity.
  const enabledAccounts = db.prepare(`
    SELECT COUNT(*) AS count
      FROM oauth_accounts
     WHERE enabled = 1
       AND provider = (SELECT provider FROM oauth_accounts WHERE id = ?)
  `).get(accountId) as { count: number };
  if (enabledAccounts.count <= 1) disableOAuthModelsForPlatform(db, platform, reason);
}

export async function discoverOAuthAccount(_db: Database.Database, row: any, signal?: AbortSignal): Promise<OAuthDiscoveryResult> {
  const token = decrypt(row.encrypted_access_token, row.access_iv, row.access_auth_tag);
  if (row.provider === 'openai') {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'LLMHarbor/0.1.0', originator: 'codex_cli_rs' };
    const modelsRes = await fetch(CODEX_MODELS_URL, { headers, signal: boundedDiscoverySignal(signal) });
    if (!modelsRes.ok) {
      await modelsRes.body?.cancel().catch(() => {});
      throw new ProviderError(`ChatGPT Codex model discovery returned HTTP ${modelsRes.status}.`, { statusCode: modelsRes.status });
    }
    const modelsJson = await modelsRes.json().catch(() => {
      throw new ProviderProtocolError('ChatGPT Codex model discovery returned malformed JSON.');
    }) as any;
    const usageRes = await fetch(CODEX_USAGE_URL, { headers, signal: boundedDiscoverySignal(signal) });
    const usageJson = usageRes.ok
      ? await usageRes.json().catch(() => ({})) as any
      : {};
    if (!usageRes.ok) await usageRes.body?.cancel().catch(() => {});
    const models = (Array.isArray(modelsJson.models) ? modelsJson.models : [])
      .filter((model: any) => typeof model?.slug === 'string' && model.slug.length > 0)
      .filter((model: any) => !DISCOVERY_BLACKLIST.has(String(model.slug)))
      .map((model: any, index: number): OAuthDiscoveredModel => ({
        id: String(model.slug),
        displayName: `${model.display_name ?? model.slug} (ChatGPT browser account)`,
        platform: 'openai',
        priority: typeof model.priority === 'number' ? model.priority : index + 1,
        speedRank: String(model.slug).includes('mini') ? 2 : 5,
        sizeLabel: String(model.slug).includes('mini') ? 'Medium' : 'Frontier',
        contextWindow: typeof model.context_window === 'number' ? model.context_window : null,
        supported: true,
        visibility: model.visibility ?? null,
      }));
    return { models, limits: parseOpenAILimits(usageJson), metadata: { codexUsage: usageJson, codexModelsUpdatedAt: new Date().toISOString() } };
  }

  if (row.provider === 'antigravity') {
    let loadJson: any = null;
    let loadLastError = '';
    let loadLastStatus: number | null = null;
    for (const endpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
      let loadRes: Response;
      try {
        loadRes = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
          method: 'POST',
          signal: boundedDiscoverySignal(signal),
          headers: { ...CODE_ASSIST_HEADERS, Authorization: `Bearer ${token}` },
          body: JSON.stringify({ metadata: codeAssistMetadata(), mode: 1 }),
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        loadLastError = 'transport failure';
        continue;
      }
      if (!loadRes.ok) {
        loadLastStatus = loadRes.status;
        await loadRes.body?.cancel().catch(() => {});
        loadLastError = `HTTP ${loadRes.status}`;
        continue;
      }
      try {
        loadJson = await loadRes.json() as any;
      } catch {
        loadLastError = 'malformed response';
        continue;
      }
      break;
    }
    if (!loadJson) throw new ProviderError(`Google Code Assist discovery failed on all loadCodeAssist endpoints (${loadLastError || 'no response'}).`, {
      ...(loadLastStatus === null ? {} : { statusCode: loadLastStatus }),
      retryable: loadLastStatus === 401 || loadLastStatus === 403 ? false : true,
    });
    const validationRequired = Array.isArray(loadJson.ineligibleTiers)
      ? loadJson.ineligibleTiers.find((tier: any) => tier?.reasonCode === 'VALIDATION_REQUIRED')
      : undefined;
    if (validationRequired) {
      throw new ProviderError('Google Code Assist account verification is required.', {
        statusCode: 403,
        retryable: false,
        code: 'oauth_account_verification_required',
      });
    }
    const discoveredProject = loadJson.cloudaicompanionProject?.id ?? loadJson.cloudaicompanionProject;

    let availableJson: any = null;
    let modelsLastError = '';
    let modelsLastStatus: number | null = null;
    for (const endpoint of CODE_ASSIST_ENDPOINTS) {
      let modelsRes: Response;
      try {
        modelsRes = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
          method: 'POST',
          signal: boundedDiscoverySignal(signal),
          headers: { ...CODE_ASSIST_HEADERS, Authorization: `Bearer ${token}` },
          body: JSON.stringify(discoveredProject ? { project: discoveredProject } : {}),
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        modelsLastError = 'transport failure';
        continue;
      }
      if (!modelsRes.ok) {
        modelsLastStatus = modelsRes.status;
        await modelsRes.body?.cancel().catch(() => {});
        modelsLastError = `HTTP ${modelsRes.status}`;
        continue;
      }
      try {
        availableJson = await modelsRes.json() as any;
      } catch {
        modelsLastError = 'malformed response';
        continue;
      }
      break;
    }
    if (!availableJson?.models || typeof availableJson.models !== 'object') {
      if (modelsLastStatus !== null) {
        throw new ProviderError(`Google Code Assist model discovery failed (${modelsLastError}).`, {
          statusCode: modelsLastStatus,
          retryable: modelsLastStatus !== 401 && modelsLastStatus !== 403,
        });
      }
      throw new ProviderProtocolError(`Google Code Assist model discovery returned no usable model inventory (${modelsLastError || 'empty response'}).`);
    }

    const models = Object.entries(availableJson.models)
      .filter(([modelId]) => isCodeAssistModel(String(modelId)))
      .map(([modelId, modelData], index): OAuthDiscoveredModel => {
        const id = String(modelId);
        const data = (modelData && typeof modelData === 'object') ? modelData as any : {};
        return {
          id,
          displayName: `${data.displayName ?? id} (Antigravity browser account)`,
          platform: 'google-oauth',
          priority: codeAssistModelRank(id, index),
          speedRank: codeAssistSpeedRank(id),
          sizeLabel: codeAssistSizeLabel(id),
          contextWindow: typeof data.contextWindow === 'number' ? data.contextWindow : 1048576,
          supported: true,
          visibility: 'list',
        };
      });
    if (models.length === 0) throw new ProviderProtocolError('Google Code Assist returned no supported Gemini/Claude/Gemma models.');

    return {
      models,
      limits: parseGoogleLimits(loadJson),
      metadata: {
        cloudaicompanionProject: discoveredProject,
        currentTier: loadJson.currentTier?.id,
        currentTierName: loadJson.currentTier?.name,
        paidTier: loadJson.paidTier?.id,
        paidTierName: loadJson.paidTier?.name,
        codeAssistUpdatedAt: new Date().toISOString(),
        codeAssistModelCount: models.length,
      },
    };
  }

  if (row.provider === 'freebuff') {
    const models = FREEBUFF_CATALOG_MODELS.map((model): OAuthDiscoveredModel => ({
      id: model.id,
      displayName: model.displayName ?? `${model.id} (Freebuff browser account)`,
      platform: 'freebuff',
      priority: model.priority,
      speedRank: model.speedRank,
      sizeLabel: model.sizeLabel,
      contextWindow: model.contextWindow ?? null,
      supported: true,
      visibility: 'list',
    }));
    return {
      models,
      limits: [{ label: 'Freebuff browser account quota', usedPercent: null, resetAfterSeconds: null, resetAt: null }],
      metadata: { freebuffUpdatedAt: new Date().toISOString(), freebuffModelCount: models.length },
    };
  }

  return { models: [], limits: [], metadata: {} };
}

export async function refreshOAuthAccountInventory(db: Database.Database, accountId: number, signal?: AbortSignal) {
  const row = db.prepare('SELECT * FROM oauth_accounts WHERE id = ? AND enabled = 1').get(accountId) as any;
  if (!row) throw new Error('OAuth account not found');
  try {
    const freshRow = await ensureFreshOAuthAccount(db, accountId, signal);
    const discovered = await discoverOAuthAccount(db, freshRow, signal);
    updateOAuthModels(db, discovered.models, accountId);
    let metadata = {} as Record<string, unknown>;
    try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {}; } catch {}
    metadata = { ...metadata, ...discovered.metadata, oauthLimits: discovered.limits, oauthModelCount: discovered.models.length, oauthModelIds: discovered.models.filter(model => model.supported).map(model => model.id), oauthDiscoveryError: null, oauthNeedsReconnect: false };
    db.prepare("UPDATE oauth_accounts SET metadata_json = ?, last_discovered_at = datetime('now'), last_used_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(metadata), accountId);
    return { ...discovered, metadata };
  } catch (error: any) {
    if (row.provider === 'antigravity') {
      const rawMessage = String(error?.message ?? error);
      const message = safeUpstreamFailure(error, 'OAuth model discovery failed.');
      let metadata = {} as Record<string, unknown>;
      try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {}; } catch {}
      const statusCode = Number(error?.statusCode);
      const needsReconnect = statusCode === 401 || statusCode === 403
        || /UNAUTHENTICATED|PERMISSION_DENIED|invalid_grant|invalid authentication|permission|verification required|not eligible/i.test(rawMessage);
      if (needsReconnect) {
        removeFailedAccountInventory(db, accountId, 'google-oauth', message);
        metadata = {
          ...metadata,
          oauthLimits: [],
          oauthModelCount: 0,
          oauthModelIds: [],
          oauthDiscoveryError: message,
          oauthNeedsReconnect: true,
          codeAssistUpdatedAt: new Date().toISOString(),
        };
      } else {
        // A timeout/429/5xx must not erase the account's last-known-good model
        // inventory or quota snapshot. Routing can keep using it while the
        // next scheduled discovery retries.
        metadata = {
          ...metadata,
          oauthDiscoveryError: message,
          codeAssistUpdatedAt: new Date().toISOString(),
        };
      }
      db.prepare("UPDATE oauth_accounts SET metadata_json = ?, last_discovered_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(metadata), accountId);
    }
    throw error;
  }
}
