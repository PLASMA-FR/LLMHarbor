import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { canMakeRequest, canUseTokens, isOnCooldown, releaseProviderCapacity, reserveProviderCapacity } from './ratelimit.js';
import { ProviderError, type BaseProvider } from '../providers/base.js';
import { getRouteCredentials, oauthOptionsForCredential, prepareProviderCredential } from './credentials.js';

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
  capacityReservationId?: string;
  oauth?: {
    accountId: number;
    provider: string;
    accountHint?: string | null;
    metadata?: Record<string, unknown>;
  };
}

export class RoutePreparationError extends ProviderError {
  readonly failedRoute: RouteResult;

  constructor(error: unknown, failedRoute: RouteResult) {
    const upstream = error instanceof ProviderError ? error : null;
    super(error instanceof Error ? error.message : 'Provider credential preparation failed.', {
      statusCode: upstream?.statusCode ?? undefined,
      // Credential refresh/preparation failures belong to this route. Even a
      // definitive invalid_grant must allow a different credential or model.
      retryable: true,
      code: upstream?.code ?? 'route_preparation_failed',
    });
    this.name = 'RoutePreparationError';
    this.failedRoute = failedRoute;
    this.cause = error;
  }
}

// Round-robin index per platform
const roundRobinIndex = new Map<string, number>();

// ── Dynamic priority: track 429s per model and demote accordingly ──
// Key: model_db_id → { count, lastHit, penalty }
const rateLimitPenalties = new Map<number, { count: number; lastHit: number; penalty: number }>();
const routeFailureCircuits = new Map<number, { count: number; lastFailure: number; until: number }>();
const ROUTE_FAILURE_RESET_MS = 5 * 60 * 1000;
const ROUTE_FAILURE_BASE_COOLDOWN_MS = 15_000;
const ROUTE_FAILURE_MAX_COOLDOWN_MS = 2 * 60 * 1000;

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
  routeFailureCircuits.delete(modelDbId);
  const existing = rateLimitPenalties.get(modelDbId);
  if (existing) {
    existing.penalty = Math.max(0, existing.penalty - 1);
    if (existing.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
    }
  }
}

/** A short, non-rate-limit circuit for repeatedly broken upstream routes. */
export function recordRouteFailure(modelDbId: number): void {
  const now = Date.now();
  const previous = routeFailureCircuits.get(modelDbId);
  const count = previous && now - previous.lastFailure < ROUTE_FAILURE_RESET_MS
    ? previous.count + 1
    : 1;
  // One failure may be request-specific. Open only after a repeated failure,
  // then back off independently from quota/rate-limit metrics.
  const cooldown = count < 2
    ? 0
    : Math.min(ROUTE_FAILURE_BASE_COOLDOWN_MS * (2 ** Math.min(count - 2, 3)), ROUTE_FAILURE_MAX_COOLDOWN_MS);
  routeFailureCircuits.set(modelDbId, { count, lastFailure: now, until: now + cooldown });
}

export function getRouteFailureCircuit(modelDbId: number): { count: number; until: number } | null {
  const entry = routeFailureCircuits.get(modelDbId);
  if (!entry) return null;
  const now = Date.now();
  if (now - entry.lastFailure >= ROUTE_FAILURE_RESET_MS) {
    routeFailureCircuits.delete(modelDbId);
    return null;
  }
  return { count: entry.count, until: entry.until };
}

export function getAllRouteFailureCircuits(): Array<{ modelDbId: number; count: number; until: number }> {
  const result: Array<{ modelDbId: number; count: number; until: number }> = [];
  for (const modelDbId of routeFailureCircuits.keys()) {
    const entry = getRouteFailureCircuit(modelDbId);
    if (entry) result.push({ modelDbId, ...entry });
  }
  return result;
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
export type RouteKeyAccessFilter = (key: { id: number; platform: string; source?: string; oauthProvider?: string | null }) => boolean;

export function routeRequest(
  estimatedTokens = 1000,
  skipKeys?: Set<string>,
  preferredModelDbId?: number,
  strictPreferredModel = false,
  accessFilter?: RouteModelAccessFilter,
  keyAccessFilter?: RouteKeyAccessFilter,
): RouteResult {
  const db = getDb();

  // Get fallback chain ordered by priority
  const fallbackChain = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled
    FROM fallback_config fc
    ORDER BY fc.priority ASC, fc.model_db_id ASC
  `).all() as FallbackRow[];

  // Apply dynamic penalties: sort by (base priority + penalty)
  const sortedChain = fallbackChain.map(entry => ({
    ...entry,
    effectivePriority: entry.priority + getPenalty(entry.model_db_id),
  })).sort((a, b) => a.effectivePriority - b.effectivePriority || a.priority - b.priority || a.model_db_id - b.model_db_id);

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
  let sawTemporaryCapacityBlock = false;
  let sawCredentialFailure = false;

  for (const entry of sortedChain) {
    if (!entry.enabled) continue;
    const failureCircuit = getRouteFailureCircuit(entry.model_db_id);
    if (!strictPreferredModel && failureCircuit && failureCircuit.until > Date.now()) {
      sawTemporaryCapacityBlock = true;
      continue;
    }

    // Get model details
    const model = db.prepare('SELECT * FROM models WHERE id = ? AND enabled = 1').get(entry.model_db_id) as ModelRow | undefined;
    if (!model) continue;

    // Check if we have a provider for this platform
    const provider = getProvider(model.platform as any);
    if (!provider) continue;

    // Get enabled keys that have not already failed validation or decryption.
    const keys = getRouteCredentials(model.platform, model.model_id);

    const eligibleKeys = keyAccessFilter
      ? keys.filter(key => keyAccessFilter({ id: key.id, platform: key.platform, source: key.source, oauthProvider: key.oauth_provider }))
      : keys;

    if (eligibleKeys.length === 0) continue;

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

    for (let attempt = 0; attempt < eligibleKeys.length; attempt++) {
      const key = eligibleKeys[idx % eligibleKeys.length];
      idx++;

      const skipId = `${model.platform}:${model.model_id}:${key.id}`;
      const routeSkipId = `${model.platform}:${model.model_id}:*`;
      const credentialSkipId = `${model.platform}:*:${key.id}`;
      if (skipKeys?.has(skipId) || skipKeys?.has(routeSkipId) || skipKeys?.has(credentialSkipId)) {
        sawTemporaryCapacityBlock = true;
        continue;
      }

      // Check cooldown (from previous 429s)
      if (isOnCooldown(model.platform, model.model_id, key.id)) {
        sawTemporaryCapacityBlock = true;
        continue;
      }

      if (!canMakeRequest(model.platform, model.model_id, key.id, limits)) {
        sawTemporaryCapacityBlock = true;
        continue;
      }
      if (!canUseTokens(model.platform, model.model_id, key.id, estimatedTokens, limits)) {
        sawTemporaryCapacityBlock = true;
        continue;
      }

      let decryptedKey: string;
      try {
        decryptedKey = key.source === 'anonymous' ? '' : decrypt(key.encrypted_key, key.iv, key.auth_tag);
      } catch {
        sawCredentialFailure = true;
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
        oauth: oauthOptionsForCredential(key),
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

  const noEligibleRoute = !sawAllowedRouteableCandidate || (sawCredentialFailure && !sawTemporaryCapacityBlock);
  const err = new Error(noEligibleRoute
    ? 'No eligible route is currently available. Enable a model and add a healthy provider credential.'
    : 'All eligible routes are temporarily unavailable because of configured limits or cooldowns.') as any;
  err.status = noEligibleRoute ? 503 : 429;
  err.code = noEligibleRoute ? (sawCredentialFailure ? 'no_usable_credentials' : 'no_eligible_route') : 'route_capacity_exhausted';
  throw err;
}

export async function routeRequestAsync(
  estimatedTokens = 1000,
  skipKeys?: Set<string>,
  preferredModelDbId?: number,
  strictPreferredModel = false,
  accessFilter?: RouteModelAccessFilter,
  signal?: AbortSignal,
  keyAccessFilter?: RouteKeyAccessFilter,
): Promise<RouteResult> {
  const selectionSkips = skipKeys ?? new Set<string>();
  const preparationFailures = new Map<string, number>();
  let lastPreparationError: RoutePreparationError | null = null;
  for (let preparationAttempt = 0; preparationAttempt < 32; preparationAttempt++) {
    signal?.throwIfAborted();
    let route: RouteResult;
    try {
      route = routeRequest(estimatedTokens, selectionSkips, preferredModelDbId, strictPreferredModel, accessFilter, keyAccessFilter);
    } catch (selectionError) {
      if (lastPreparationError) throw lastPreparationError;
      throw selectionError;
    }
    const capacityReservationId = reserveProviderCapacity(route.platform, route.modelId, route.keyId, estimatedTokens);
    const reservedRoute = { ...route, capacityReservationId };
    try {
      const credential = await prepareProviderCredential(route.keyId, signal);
      return { ...reservedRoute, ...credential };
    } catch (error) {
      releaseProviderCapacity(capacityReservationId);
      if (signal?.aborted) throw error;
      selectionSkips.add(`${route.platform}:*:${route.keyId}`);
      const routeId = `${route.platform}:${route.modelId}`;
      const failures = (preparationFailures.get(routeId) ?? 0) + 1;
      preparationFailures.set(routeId, failures);
      if (failures >= 8) selectionSkips.add(`${routeId}:*`);
      lastPreparationError = new RoutePreparationError(error, reservedRoute);
    }
  }
  throw lastPreparationError ?? new ProviderError('OAuth route preparation budget was exhausted.', {
    retryable: true,
    code: 'route_preparation_exhausted',
  });
}
