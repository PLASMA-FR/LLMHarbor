import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { canMakeRequest, canUseTokens, isOnCooldown } from './ratelimit.js';
import type { BaseProvider } from '../providers/base.js';
import { oauthTokenClient } from './oauth-clients.js';

interface ModelRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
}

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
  oauth_account_id?: number | null;
}

function refreshTokenForProvider(provider: string, rawRefreshToken: string) {
  // Antigravity-compatible tools may persist refresh tokens as
  // refreshToken|duetProject|managedProject. Google only accepts the first
  // segment at oauth2.googleapis.com/token.
  return provider === 'antigravity' ? rawRefreshToken.split('|')[0] : rawRefreshToken;
}

function normalizeQwenResourceUrl(resourceUrl: unknown) {
  if (typeof resourceUrl !== 'string' || resourceUrl.trim().length === 0) return null;
  const withoutTrailing = resourceUrl.trim().replace(/\/+$/, '');
  return withoutTrailing.endsWith('/v1') ? withoutTrailing : `${withoutTrailing}/v1`;
}

function metadataJsonWithQwenResource(account: any, tokenData: any) {
  if (account.provider !== 'qwen') return account.metadata_json ?? '{}';
  const resourceUrl = normalizeQwenResourceUrl(tokenData.resource_url ?? tokenData.resourceUrl);
  if (!resourceUrl) return account.metadata_json ?? '{}';
  let metadata: Record<string, unknown> = {};
  try { metadata = account.metadata_json ? JSON.parse(account.metadata_json) as Record<string, unknown> : {}; } catch {}
  metadata.resourceUrl = resourceUrl;
  metadata.qwenResourceUrl = resourceUrl;
  return JSON.stringify(metadata);
}

function markOAuthAccountNeedsReconnect(db: ReturnType<typeof getDb>, account: any, message: string) {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = account.metadata_json ? JSON.parse(account.metadata_json) as Record<string, unknown> : {};
  } catch {}
  metadata.oauthNeedsReconnect = true;
  metadata.oauthDiscoveryError = message;
  metadata.oauthModelCount = 0;
  metadata.oauthLastDiscoveredAt = new Date().toISOString();
  db.prepare(`
    UPDATE oauth_accounts
       SET metadata_json = ?, last_discovered_at = datetime('now')
     WHERE id = ?
  `).run(JSON.stringify(metadata), account.id);
  db.prepare(`
    UPDATE api_keys
       SET status = 'invalid', enabled = 0, last_checked_at = datetime('now')
     WHERE oauth_account_id = ?
  `).run(account.id);
}

interface OAuthAccountRow {
  id: number;
  provider: string;
  account_hint: string | null;
  metadata_json: string | null;
}

async function refreshOAuthKeyIfNeeded(key: KeyRow): Promise<string | null> {
  if (!key.oauth_account_id) return null;
  const db = getDb();
  const account = db.prepare('SELECT * FROM oauth_accounts WHERE id = ? AND enabled = 1').get(key.oauth_account_id) as any;
  if (!account) return null;
  const expiresAt = account.expires_at ? Date.parse(account.expires_at) : 0;
  if (!expiresAt || expiresAt - Date.now() > 5 * 60 * 1000) return null;
  if (!account.encrypted_refresh_token || !account.refresh_iv || !account.refresh_auth_tag) {
    const providerName = account.provider === 'antigravity' ? 'Antigravity' : account.provider === 'qwen' ? 'Qwen' : 'ChatGPT';
    const message = `${providerName} OAuth access token expired and no refresh token is available.`;
    markOAuthAccountNeedsReconnect(db, account, message);
    const err = new Error(`${message} Reconnect the browser account.`) as any;
    err.status = 401;
    throw err;
  }
  const rawRefreshToken = decrypt(account.encrypted_refresh_token, account.refresh_iv, account.refresh_auth_tag);
  const refreshToken = refreshTokenForProvider(account.provider, rawRefreshToken);
  const client = oauthTokenClient(account.provider);
  if (!client) return null;
  if (client.requiresClientSecret && !client.clientSecret) return null;
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
    const message = `${client.name} token refresh failed with HTTP ${upstream.status}. ${(await upstream.text().catch(() => '')).slice(0, 300)}`;
    markOAuthAccountNeedsReconnect(db, account, message);
    const err = new Error(`${message} Reconnect the browser account.`) as any;
    err.status = 401;
    throw err;
  }
  const tokenData = await upstream.json() as any;
  if (!tokenData.access_token) {
    const message = `${client.name} token refresh response did not contain an access token.`;
    markOAuthAccountNeedsReconnect(db, account, message);
    const err = new Error(`${message} Reconnect the browser account.`) as any;
    err.status = 401;
    throw err;
  }
  const access = encrypt(String(tokenData.access_token));
  const nextRefresh = tokenData.refresh_token ? encrypt(String(tokenData.refresh_token)) : null;
  const expires = typeof tokenData.expires_in === 'number' ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : account.expires_at;
  const metadataJson = metadataJsonWithQwenResource(account, tokenData);
  db.prepare(`
    UPDATE oauth_accounts
    SET encrypted_access_token = ?, access_iv = ?, access_auth_tag = ?,
        encrypted_refresh_token = COALESCE(?, encrypted_refresh_token),
        refresh_iv = COALESCE(?, refresh_iv),
        refresh_auth_tag = COALESCE(?, refresh_auth_tag),
        expires_at = ?, metadata_json = ?, last_used_at = datetime('now')
    WHERE id = ?
  `).run(access.encrypted, access.iv, access.authTag, nextRefresh?.encrypted ?? null, nextRefresh?.iv ?? null, nextRefresh?.authTag ?? null, expires, metadataJson, account.id);
  db.prepare(`
    UPDATE api_keys
    SET encrypted_key = ?, iv = ?, auth_tag = ?, status = 'healthy', last_checked_at = datetime('now')
    WHERE id = ?
  `).run(access.encrypted, access.iv, access.authTag, key.id);
  return String(tokenData.access_token);
}

interface FallbackRow {
  model_db_id: number;
  priority: number;
  enabled: number;
}

export interface RouteResult {
  provider: BaseProvider;
  modelId: string;
  modelDbId: number;
  apiKey: string;
  keyId: number;
  platform: string;
  displayName: string;
  oauth?: {
    accountId: number;
    provider: string;
    accountHint?: string | null;
    metadata?: Record<string, unknown>;
  };
}

function oauthOptionsForKey(db: ReturnType<typeof getDb>, key: KeyRow): RouteResult['oauth'] {
  if (!key.oauth_account_id) return undefined;
  const account = db.prepare('SELECT id, provider, account_hint, metadata_json FROM oauth_accounts WHERE id = ? AND enabled = 1')
    .get(key.oauth_account_id) as OAuthAccountRow | undefined;
  if (!account) return undefined;
  let metadata: Record<string, unknown> = {};
  try {
    metadata = account.metadata_json ? JSON.parse(account.metadata_json) as Record<string, unknown> : {};
  } catch {}
  return {
    accountId: account.id,
    provider: account.provider,
    accountHint: account.account_hint,
    metadata,
  };
}

// Round-robin index per platform
const roundRobinIndex = new Map<string, number>();

// ── Dynamic priority: track 429s per model and demote accordingly ──
// Key: model_db_id → { count, lastHit, penalty }
const rateLimitPenalties = new Map<number, { count: number; lastHit: number; penalty: number }>();

// Penalty decays over time so models recover
const PENALTY_PER_429 = 3;        // each 429 adds this many priority positions
const MAX_PENALTY = 10;            // cap so a model doesn't sink forever
const DECAY_INTERVAL_MS = 2 * 60 * 1000; // penalty decays every 2 minutes
const DECAY_AMOUNT = 1;            // remove this much penalty per decay interval

/**
 * Record a 429 for a model — increases its penalty so it sinks in priority.
 */
export function recordRateLimitHit(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  const now = Date.now();
  if (existing) {
    existing.count++;
    existing.lastHit = now;
    existing.penalty = Math.min(existing.penalty + PENALTY_PER_429, MAX_PENALTY);
  } else {
    rateLimitPenalties.set(modelDbId, { count: 1, lastHit: now, penalty: PENALTY_PER_429 });
  }
}

/**
 * Record a success for a model — reduces its penalty so it rises back up.
 */
export function recordSuccess(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  if (existing) {
    existing.penalty = Math.max(0, existing.penalty - 1);
    if (existing.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
    }
  }
}

/**
 * Get the current penalty for a model (with time-based decay).
 */
function getPenalty(modelDbId: number): number {
  const entry = rateLimitPenalties.get(modelDbId);
  if (!entry) return 0;

  // Apply time-based decay
  const now = Date.now();
  const elapsed = now - entry.lastHit;
  const decaySteps = Math.floor(elapsed / DECAY_INTERVAL_MS);
  if (decaySteps > 0) {
    entry.penalty = Math.max(0, entry.penalty - (decaySteps * DECAY_AMOUNT));
    entry.lastHit = now; // reset so we don't double-decay
    if (entry.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
      return 0;
    }
  }

  return entry.penalty;
}

/**
 * Get current penalties for all models (for the API/dashboard).
 */
export function getAllPenalties(): Array<{ modelDbId: number; count: number; penalty: number }> {
  const result: Array<{ modelDbId: number; count: number; penalty: number }> = [];
  for (const [modelDbId, entry] of rateLimitPenalties) {
    const penalty = getPenalty(modelDbId);
    if (penalty > 0) {
      result.push({ modelDbId, count: entry.count, penalty });
    }
  }
  return result.sort((a, b) => b.penalty - a.penalty);
}

/**
 * Route a request to the best available model.
 * Models are sorted by (base_priority + rate_limit_penalty) so frequently
 * rate-limited models automatically sink below working ones.
 *
 * If preferredModelDbId is set, that model gets tried FIRST (sticky sessions).
 * This prevents hallucination from model switching mid-conversation.
 *
 * @param estimatedTokens - estimated total tokens for rate limit check
 * @param skipKeys - set of "platform:modelId:keyId" to skip (failed on this request)
 * @param preferredModelDbId - try this model first (sticky session)
 */
export type RouteModelAccessFilter = (model: { id: number; platform: string; modelId: string; displayName: string }) => boolean;

export function routeRequest(
  estimatedTokens = 1000,
  skipKeys?: Set<string>,
  preferredModelDbId?: number,
  strictPreferredModel = false,
  accessFilter?: RouteModelAccessFilter,
): RouteResult {
  const db = getDb();

  // Get fallback chain ordered by priority
  const fallbackChain = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled
    FROM fallback_config fc
    ORDER BY fc.priority ASC
  `).all() as FallbackRow[];

  // Apply dynamic penalties: sort by (base priority + penalty)
  const sortedChain = fallbackChain.map(entry => ({
    ...entry,
    effectivePriority: entry.priority + getPenalty(entry.model_db_id),
  })).sort((a, b) => a.effectivePriority - b.effectivePriority);

  // Sticky session: move preferred model to front of chain. Explicit model
  // requests use strict mode so provider errors/rate limits never silently
  // switch to a different model id.
  if (preferredModelDbId) {
    const idx = sortedChain.findIndex(e => e.model_db_id === preferredModelDbId);
    if (strictPreferredModel) {
      if (idx === -1) {
        const err = new Error('Requested model is not available in the fallback chain.') as any;
        err.status = 404;
        throw err;
      }
      const preferred = sortedChain[idx];
      sortedChain.length = 0;
      sortedChain.push(preferred);
    } else if (idx > 0) {
      const [preferred] = sortedChain.splice(idx, 1);
      sortedChain.unshift(preferred);
    }
  }

  let sawDeniedRouteableCandidate = false;
  let sawAllowedRouteableCandidate = false;

  for (const entry of sortedChain) {
    if (!entry.enabled) continue;

    // Get model details
    const model = db.prepare('SELECT * FROM models WHERE id = ? AND enabled = 1').get(entry.model_db_id) as ModelRow | undefined;
    if (!model) continue;

    // Check if we have a provider for this platform
    const provider = getProvider(model.platform as any);
    if (!provider) continue;

    // Get enabled keys that have not already failed validation or decryption.
    const keys = db.prepare(
      `SELECT ak.*
         FROM api_keys ak
         LEFT JOIN oauth_accounts oa ON oa.id = ak.oauth_account_id
        WHERE ak.platform = ?
          AND ak.enabled = 1
          AND (ak.status IN ('healthy', 'unknown') OR ak.source = 'oauth')
          AND (
            ak.source != 'oauth'
            OR (oa.enabled = 1 AND COALESCE(json_extract(oa.metadata_json, '$.oauthNeedsReconnect'), 0) != 1)
          )`
    ).all(model.platform) as KeyRow[];

    if (keys.length === 0) continue;

    if (accessFilter && !accessFilter({ id: model.id, platform: model.platform, modelId: model.model_id, displayName: model.display_name })) {
      sawDeniedRouteableCandidate = true;
      continue;
    }

    sawAllowedRouteableCandidate = true;

    // Get limits once for this model
    const limits = {
      rpm: model.rpm_limit,
      rpd: model.rpd_limit,
      tpm: model.tpm_limit,
      tpd: model.tpd_limit,
    };

    // Try all keys for this model before giving up on it
    const rrKey = `${model.platform}:${model.model_id}`;
    let idx = roundRobinIndex.get(rrKey) ?? 0;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = keys[idx % keys.length];
      idx++;

      const skipId = `${model.platform}:${model.model_id}:${key.id}`;
      if (skipKeys?.has(skipId)) continue;

      // Check cooldown (from previous 429s)
      if (isOnCooldown(model.platform, model.model_id, key.id)) continue;

      if (!canMakeRequest(model.platform, model.model_id, key.id, limits)) continue;
      if (!canUseTokens(model.platform, model.model_id, key.id, estimatedTokens, limits)) continue;

      let decryptedKey: string;
      try {
        decryptedKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
      } catch {
        db.prepare("UPDATE api_keys SET status = 'error', last_checked_at = datetime('now') WHERE id = ?")
          .run(key.id);
        continue;
      }

      // We found a working key for this model!
      roundRobinIndex.set(rrKey, idx);
      return {
        provider,
        modelId: model.model_id,
        modelDbId: model.id,
        apiKey: decryptedKey,
        keyId: key.id,
        platform: model.platform,
        displayName: model.display_name,
        oauth: oauthOptionsForKey(db, key),
      };
    }

    // If we reach here, this specific model has NO available keys.
    // Update round-robin index even if we failed so we don't get stuck.
    roundRobinIndex.set(rrKey, idx);
    
    // We don't explicitly penalize the model here because the fact that we 
    // couldn't find a key means we will naturally move to the next model 
    // in the `sortedChain` for THIS specific request.
  }

  if (sawDeniedRouteableCandidate && !sawAllowedRouteableCandidate) {
    const err = new Error('No routeable models are allowed by this local API key access policy.') as any;
    err.status = 403;
    err.code = 'client_access_policy_denied';
    throw err;
  }

  const err = new Error('All models exhausted. Add more API keys or wait for rate limits to reset.') as any;
  err.status = 429;
  throw err;
}

export async function routeRequestAsync(
  estimatedTokens = 1000,
  skipKeys?: Set<string>,
  preferredModelDbId?: number,
  strictPreferredModel = false,
  accessFilter?: RouteModelAccessFilter,
): Promise<RouteResult> {
  const route = routeRequest(estimatedTokens, skipKeys, preferredModelDbId, strictPreferredModel, accessFilter);
  const key = getDb().prepare('SELECT * FROM api_keys WHERE id = ?').get(route.keyId) as KeyRow | undefined;
  if (key?.oauth_account_id) {
    const refreshed = await refreshOAuthKeyIfNeeded(key);
    if (refreshed) return { ...route, apiKey: refreshed, oauth: oauthOptionsForKey(getDb(), key) };
  }
  return route;
}
