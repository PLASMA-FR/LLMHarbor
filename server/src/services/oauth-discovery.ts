import type Database from 'better-sqlite3';
import { decrypt, encrypt } from '../lib/crypto.js';
import { QWEN_DEFAULT_RESOURCE_URL, oauthTokenClient } from './oauth-clients.js';

export type OAuthLimitWindow = {
  label: string;
  usedPercent: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
};

export type OAuthDiscoveredModel = {
  id: string;
  displayName: string;
  platform: 'openai' | 'google-oauth' | 'qwen-oauth';
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
  'User-Agent': `antigravity/1.0.0 ${process.platform}/${process.arch}`,
  'X-Client-Name': 'antigravity',
  'X-Client-Version': '1.0.0',
  'x-goog-api-client': 'gl-node/18.18.2 fire/0.8.6 grpc/1.10.x',
};
export const DISCOVERY_BLACKLIST = new Set(['gpt-5-codex', 'gpt-5.1-codex']);

function oauthRefreshDue(row: any) {
  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : 0;
  return Boolean(expiresAt && expiresAt - Date.now() <= 5 * 60 * 1000);
}

function refreshTokenForProvider(provider: string, rawRefreshToken: string) {
  return provider === 'antigravity' ? rawRefreshToken.split('|')[0] : rawRefreshToken;
}

async function ensureFreshOAuthAccessToken(db: Database.Database, row: any) {
  if (!oauthRefreshDue(row)) return row;
  if (!row.encrypted_refresh_token || !row.refresh_iv || !row.refresh_auth_tag) return row;
  const client = oauthTokenClient(row.provider);
  if (!client) return row;
  if (client.requiresClientSecret && !client.clientSecret) return row;

  const rawRefreshToken = decrypt(row.encrypted_refresh_token, row.refresh_iv, row.refresh_auth_tag);
  const refreshToken = refreshTokenForProvider(row.provider, rawRefreshToken);
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: client.clientId,
    refresh_token: refreshToken,
  });
  if (client.clientSecret) params.set('client_secret', client.clientSecret);

  const upstream = await fetch(client.tokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!upstream.ok) {
    throw new Error(`${client.name} token refresh failed with HTTP ${upstream.status}. ${(await upstream.text().catch(() => '')).slice(0, 300)}`);
  }
  const tokenData = await upstream.json() as any;
  if (!tokenData.access_token) throw new Error(`${client.name} token refresh response did not contain an access token.`);

  const access = encrypt(String(tokenData.access_token));
  const nextRefresh = tokenData.refresh_token ? encrypt(String(tokenData.refresh_token)) : null;
  const expiresAt = typeof tokenData.expires_in === 'number'
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : row.expires_at;
  let metadataJson = row.metadata_json ?? '{}';
  if (row.provider === 'qwen' && (tokenData.resource_url || tokenData.resourceUrl)) {
    let metadata: Record<string, unknown> = {};
    try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {}; } catch {}
    const resourceUrl = normalizeQwenResourceUrl(metadata, tokenData.resource_url ?? tokenData.resourceUrl);
    metadata.resourceUrl = resourceUrl;
    metadata.qwenResourceUrl = resourceUrl;
    metadataJson = JSON.stringify(metadata);
  }

  db.prepare(`
    UPDATE oauth_accounts
       SET encrypted_access_token = ?, access_iv = ?, access_auth_tag = ?,
           encrypted_refresh_token = COALESCE(?, encrypted_refresh_token),
           refresh_iv = COALESCE(?, refresh_iv),
           refresh_auth_tag = COALESCE(?, refresh_auth_tag),
           expires_at = ?, metadata_json = ?, last_used_at = datetime('now')
     WHERE id = ?
  `).run(access.encrypted, access.iv, access.authTag, nextRefresh?.encrypted ?? null, nextRefresh?.iv ?? null, nextRefresh?.authTag ?? null, expiresAt, metadataJson, row.id);
  db.prepare(`
    UPDATE api_keys
       SET encrypted_key = ?, iv = ?, auth_tag = ?, status = 'healthy', last_checked_at = datetime('now')
     WHERE oauth_account_id = ?
  `).run(access.encrypted, access.iv, access.authTag, row.id);

  return {
    ...row,
    encrypted_access_token: access.encrypted,
    access_iv: access.iv,
    access_auth_tag: access.authTag,
    encrypted_refresh_token: nextRefresh?.encrypted ?? row.encrypted_refresh_token,
    refresh_iv: nextRefresh?.iv ?? row.refresh_iv,
    refresh_auth_tag: nextRefresh?.authTag ?? row.refresh_auth_tag,
    expires_at: expiresAt,
    metadata_json: metadataJson,
  };
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


function normalizeQwenResourceUrl(metadata: Record<string, unknown> = {}, fallback?: unknown) {
  let value = typeof metadata.resourceUrl === 'string' && metadata.resourceUrl.trim().length > 0
    ? metadata.resourceUrl.trim()
    : typeof metadata.qwenResourceUrl === 'string' && metadata.qwenResourceUrl.trim().length > 0
      ? metadata.qwenResourceUrl.trim()
      : typeof fallback === 'string' && fallback.trim().length > 0
        ? fallback.trim()
        : QWEN_DEFAULT_RESOURCE_URL;
  value = value.replace(/\/+$/, '');
  if (!value.endsWith('/v1')) value = `${value}/v1`;
  return value;
}

function qwenModelRank(modelId: string, index: number) {
  const lower = modelId.toLowerCase();
  if (lower.includes('coder') && lower.includes('plus')) return 3;
  if (lower.includes('coder')) return 4;
  if (lower.includes('max')) return 5;
  if (lower.includes('plus')) return 7;
  return 20 + index;
}

function qwenSpeedRank(modelId: string) {
  const lower = modelId.toLowerCase();
  if (lower.includes('turbo') || lower.includes('flash')) return 2;
  if (lower.includes('plus')) return 4;
  if (lower.includes('max')) return 6;
  return 4;
}

function qwenSizeLabel(modelId: string) {
  const lower = modelId.toLowerCase();
  if (lower.includes('turbo')) return 'Medium';
  if (lower.includes('coder') || lower.includes('max') || lower.includes('plus')) return 'Frontier';
  return 'Frontier';
}

function isQwenCompletionModel(modelId: string) {
  const lower = modelId.toLowerCase();
  return !lower.includes('embedding')
    && !lower.includes('rerank')
    && !lower.includes('audio')
    && !lower.includes('image')
    && !lower.includes('tts')
    && !lower.includes('asr');
}

export function updateOAuthModels(db: Database.Database, models: OAuthDiscoveredModel[]) {
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

  if (models.length === 0) return;
  const platforms = [...new Set(models.map(model => model.platform))];
  for (const platform of platforms) {
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = ? AND display_name LIKE '%browser account%')").run(platform);
    db.prepare("DELETE FROM models WHERE platform = ? AND display_name LIKE '%browser account%' AND model_id NOT IN ('gpt-5-codex', 'gpt-5.1-codex')").run(platform);
  }
  const insertModel = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'account plan', ?, ?)
    ON CONFLICT(platform, model_id) DO UPDATE SET
      display_name = excluded.display_name,
      intelligence_rank = excluded.intelligence_rank,
      speed_rank = excluded.speed_rank,
      size_label = excluded.size_label,
      context_window = excluded.context_window,
      monthly_token_budget = excluded.monthly_token_budget,
      enabled = excluded.enabled
  `);
  const insertFallback = db.prepare('INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
  let priority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS priority FROM fallback_config').get() as { priority: number }).priority;
  for (const model of models) {
    insertModel.run(model.platform, model.id, model.displayName, model.priority, model.speedRank, model.sizeLabel, model.contextWindow, model.supported ? 1 : 0);
    const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(model.platform, model.id) as { id: number } | undefined;
    if (row && model.supported) insertFallback.run(row.id, ++priority);
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

export async function discoverOAuthAccount(db: Database.Database, row: any): Promise<OAuthDiscoveryResult> {
  const token = decrypt(row.encrypted_access_token, row.access_iv, row.access_auth_tag);
  if (row.provider === 'openai') {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'LLMHarbor/0.1.0', originator: 'codex_cli_rs' };
    const modelsRes = await fetch(CODEX_MODELS_URL, { headers });
    if (!modelsRes.ok) throw new Error(`ChatGPT Codex model discovery failed with HTTP ${modelsRes.status}`);
    const modelsJson = await modelsRes.json() as any;
    const usageRes = await fetch(CODEX_USAGE_URL, { headers });
    const usageJson = usageRes.ok ? await usageRes.json() as any : {};
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
    for (const endpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
      const loadRes = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: { ...CODE_ASSIST_HEADERS, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ metadata: codeAssistMetadata(), mode: 1 }),
      });
      if (!loadRes.ok) {
        loadLastError = `HTTP ${loadRes.status}: ${(await loadRes.text().catch(() => '')).slice(0, 300)}`;
        continue;
      }
      loadJson = await loadRes.json() as any;
      break;
    }
    if (!loadJson) throw new Error(`Google Code Assist discovery failed on all loadCodeAssist endpoints. Last error: ${loadLastError || 'unknown error'}`);
    const discoveredProject = loadJson.cloudaicompanionProject?.id ?? loadJson.cloudaicompanionProject;

    let availableJson: any = null;
    let modelsLastError = '';
    for (const endpoint of CODE_ASSIST_ENDPOINTS) {
      const modelsRes = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: { ...CODE_ASSIST_HEADERS, Authorization: `Bearer ${token}` },
        body: JSON.stringify(discoveredProject ? { project: discoveredProject } : {}),
      });
      if (!modelsRes.ok) {
        modelsLastError = `HTTP ${modelsRes.status}: ${(await modelsRes.text().catch(() => '')).slice(0, 300)}`;
        continue;
      }
      availableJson = await modelsRes.json() as any;
      break;
    }
    if (!availableJson?.models || typeof availableJson.models !== 'object') {
      throw new Error(`Google Code Assist model discovery failed on all fetchAvailableModels endpoints. Last error: ${modelsLastError || 'empty model response'}`);
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
    if (models.length === 0) throw new Error('Google Code Assist returned no supported Gemini/Claude/Gemma models.');

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

  if (row.provider === 'qwen') {
    let metadata: Record<string, unknown> = {};
    try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {}; } catch {}
    const resourceUrl = normalizeQwenResourceUrl(metadata);
    const modelsRes = await fetch(`${resourceUrl}/models`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'LLMHarbor/0.1.0' },
    });
    if (!modelsRes.ok) throw new Error(`Qwen model discovery failed with HTTP ${modelsRes.status}. ${(await modelsRes.text().catch(() => '')).slice(0, 300)}`);
    const modelsJson = await modelsRes.json() as any;
    const models = (Array.isArray(modelsJson.data) ? modelsJson.data : [])
      .filter((model: any) => typeof model?.id === 'string' && model.id.length > 0)
      .filter((model: any) => isQwenCompletionModel(String(model.id)))
      .map((model: any, index: number): OAuthDiscoveredModel => {
        const id = String(model.id);
        return {
          id,
          displayName: `${model.display_name ?? id} (Qwen browser account)`,
          platform: 'qwen-oauth',
          priority: qwenModelRank(id, index),
          speedRank: qwenSpeedRank(id),
          sizeLabel: qwenSizeLabel(id),
          contextWindow: typeof model.context_window === 'number' ? model.context_window : null,
          supported: true,
          visibility: model.visibility ?? 'list',
        };
      });
    if (models.length === 0) throw new Error('Qwen returned no supported model.completion models.');
    return {
      models,
      limits: [],
      metadata: {
        qwenResourceUrl: resourceUrl,
        qwenModelsUpdatedAt: new Date().toISOString(),
        qwenModelCount: models.length,
      },
    };
  }

  return { models: [], limits: [], metadata: {} };
}

export async function refreshOAuthAccountInventory(db: Database.Database, accountId: number) {
  const row = db.prepare('SELECT * FROM oauth_accounts WHERE id = ? AND enabled = 1').get(accountId) as any;
  if (!row) throw new Error('OAuth account not found');
  try {
    const freshRow = await ensureFreshOAuthAccessToken(db, row);
    const discovered = await discoverOAuthAccount(db, freshRow);
    updateOAuthModels(db, discovered.models);
    let metadata = {} as Record<string, unknown>;
    try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {}; } catch {}
    metadata = { ...metadata, ...discovered.metadata, oauthLimits: discovered.limits, oauthModelCount: discovered.models.length, oauthDiscoveryError: null };
    db.prepare("UPDATE oauth_accounts SET metadata_json = ?, last_discovered_at = datetime('now'), last_used_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(metadata), accountId);
    return { ...discovered, metadata };
  } catch (error: any) {
    if (row.provider === 'antigravity' || row.provider === 'qwen') {
      const message = String(error?.message ?? error);
      const platform = row.provider === 'qwen' ? 'qwen-oauth' : 'google-oauth';
      disableOAuthModelsForPlatform(db, platform, message);
      let metadata = {} as Record<string, unknown>;
      try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {}; } catch {}
      metadata = {
        ...metadata,
        oauthLimits: [],
        oauthModelCount: 0,
        oauthDiscoveryError: message,
        oauthNeedsReconnect: /401|403|UNAUTHENTICATED|PERMISSION_DENIED|invalid_grant|invalid authentication|permission/i.test(message),
        ...(row.provider === 'qwen'
          ? { qwenModelsUpdatedAt: new Date().toISOString() }
          : { codeAssistUpdatedAt: new Date().toISOString() }),
      };
      db.prepare("UPDATE oauth_accounts SET metadata_json = ?, last_discovered_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(metadata), accountId);
    }
    throw error;
  }
}
