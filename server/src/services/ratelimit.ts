// Sliding window rate limit tracker with SQLite persistence.

import { getDb } from '../db/index.js';

// Successful usage lives in SQLite. Only failed writes are retained in memory,
// bounded to the longest configured window, so unlimited routes cannot grow an
// unbounded duplicate event log over process uptime.
const unpersistedRequests = new Map<string, number[]>();
const unpersistedTokens = new Map<string, Array<{ ts: number; tokens: number }>>();
const unpersistedOverflowUntil = new Map<string, number>();
const MAX_UNPERSISTED_EVENTS_PER_ROUTE = 10_000;
interface CapacityReservation {
  routeKey: string;
  tokens: number;
  requestReserved: boolean;
}
const capacityReservations = new Map<string, CapacityReservation>();
const reservedCapacity = new Map<string, { requests: number; tokens: number }>();
let nextReservationId = 1;
let lastPersistedUsageCleanupAt = 0;
let lastPersistenceWarningAt = 0;
type RateLimitDb = ReturnType<typeof getDb>;
type UsageKind = 'request' | 'tokens';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const HOUR = 60 * MINUTE;

function warnPersistenceUnavailable(now = Date.now()): void {
  if (now - lastPersistenceWarningAt < MINUTE) return;
  lastPersistenceWarningAt = now;
  console.error('[RateLimit] SQLite usage persistence is unavailable; configured limits are being enforced conservatively.');
}

function withDb<T>(fn: (db: RateLimitDb) => T): T | undefined {
  try {
    return fn(getDb());
  } catch {
    return undefined;
  }
}

function recordUsage(
  platform: string,
  modelId: string,
  keyId: number,
  kind: UsageKind,
  tokens: number,
  now: number,
): boolean {
  const persisted = withDb(db => {
    db.prepare(`
      INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, keyId, kind, tokens, now);
    // Cleanup is maintenance, not part of every request. Running DELETE on
    // each usage write created needless WAL churn under concurrent streams.
    if (now - lastPersistedUsageCleanupAt >= HOUR) {
      try {
        db.prepare('DELETE FROM rate_limit_usage WHERE created_at_ms <= ?').run(now - DAY);
        lastPersistedUsageCleanupAt = now;
      } catch { /* Usage already persisted; retry maintenance without counting it twice. */ }
    }
    return true;
  });
  if (persisted !== true) warnPersistenceUnavailable(now);
  return persisted === true;
}

function countPersistedRequests(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): number | undefined {
  return withDb(db => {
    const row = db.prepare(`
      SELECT COUNT(*) AS used
        FROM rate_limit_usage
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
         AND kind = 'request'
         AND created_at_ms > ?
    `).get(platform, modelId, keyId, now - windowMs) as { used: number };
    return row.used;
  });
}

function sumPersistedTokens(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): number | undefined {
  return withDb(db => {
    const row = db.prepare(`
      SELECT COALESCE(SUM(tokens), 0) AS used
        FROM rate_limit_usage
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
         AND kind = 'tokens'
         AND created_at_ms > ?
    `).get(platform, modelId, keyId, now - windowMs) as { used: number };
    return row.used;
  });
}

function noteUnpersistedRequest(key: string, now: number): void {
  const events = (unpersistedRequests.get(key) ?? []).filter(ts => ts > now - DAY);
  if (events.length >= MAX_UNPERSISTED_EVENTS_PER_ROUTE) {
    unpersistedOverflowUntil.set(key, now + DAY);
  } else {
    events.push(now);
    unpersistedRequests.set(key, events);
  }
}

function noteUnpersistedTokens(key: string, tokens: number, now: number): void {
  const events = (unpersistedTokens.get(key) ?? []).filter(event => event.ts > now - DAY);
  if (events.length >= MAX_UNPERSISTED_EVENTS_PER_ROUTE) {
    unpersistedOverflowUntil.set(key, now + DAY);
  } else {
    events.push({ ts: now, tokens });
    unpersistedTokens.set(key, events);
  }
}

function hasUnpersistedOverflow(key: string, now: number): boolean {
  const until = unpersistedOverflowUntil.get(key);
  if (!until) return false;
  if (until <= now) {
    unpersistedOverflowUntil.delete(key);
    return false;
  }
  return true;
}

function unpersistedRequestCount(key: string, windowMs: number, now: number): number {
  if (hasUnpersistedOverflow(key, now)) return Number.POSITIVE_INFINITY;
  const events = (unpersistedRequests.get(key) ?? []).filter(ts => ts > now - DAY);
  if (events.length === 0) unpersistedRequests.delete(key);
  else unpersistedRequests.set(key, events);
  return events.filter(ts => ts > now - windowMs).length;
}

function unpersistedTokenCount(key: string, windowMs: number, now: number): number {
  if (hasUnpersistedOverflow(key, now)) return Number.POSITIVE_INFINITY;
  const events = (unpersistedTokens.get(key) ?? []).filter(event => event.ts > now - DAY);
  if (events.length === 0) unpersistedTokens.delete(key);
  else unpersistedTokens.set(key, events);
  return events.filter(event => event.ts > now - windowMs).reduce((sum, event) => sum + event.tokens, 0);
}

function requestCount(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): number {
  const persisted = countPersistedRequests(platform, modelId, keyId, windowMs, now);
  const key = reservationKey(platform, modelId, keyId);
  if (persisted === undefined) {
    warnPersistenceUnavailable(now);
    return Number.POSITIVE_INFINITY;
  }
  return persisted + unpersistedRequestCount(key, windowMs, now);
}

function tokenCount(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): number {
  const persisted = sumPersistedTokens(platform, modelId, keyId, windowMs, now);
  const key = reservationKey(platform, modelId, keyId);
  if (persisted === undefined) {
    warnPersistenceUnavailable(now);
    return Number.POSITIVE_INFINITY;
  }
  return persisted + unpersistedTokenCount(key, windowMs, now);
}

function reservationKey(platform: string, modelId: string, keyId: number): string {
  return `${platform}:${modelId}:${keyId}`;
}

export function canMakeRequest(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
): boolean {
  const now = Date.now();
  const reserved = reservedCapacity.get(reservationKey(platform, modelId, keyId))?.requests ?? 0;

  if (limits.rpm !== null) {
    if (requestCount(platform, modelId, keyId, MINUTE, now) + reserved >= limits.rpm) return false;
  }

  if (limits.rpd !== null) {
    if (requestCount(platform, modelId, keyId, DAY, now) + reserved >= limits.rpd) return false;
  }

  return true;
}

export function canUseTokens(
  platform: string,
  modelId: string,
  keyId: number,
  estimatedTokens: number,
  limits: { tpm: number | null; tpd: number | null },
): boolean {
  const now = Date.now();
  const reserved = reservedCapacity.get(reservationKey(platform, modelId, keyId))?.tokens ?? 0;

  if (limits.tpm !== null) {
    const used = tokenCount(platform, modelId, keyId, MINUTE, now);
    if (used + reserved + estimatedTokens > limits.tpm) return false;
  }

  if (limits.tpd !== null) {
    const used = tokenCount(platform, modelId, keyId, DAY, now);
    if (used + reserved + estimatedTokens > limits.tpd) return false;
  }

  return true;
}

export function reserveProviderCapacity(platform: string, modelId: string, keyId: number, estimatedTokens: number): string {
  const routeKey = reservationKey(platform, modelId, keyId);
  const totals = reservedCapacity.get(routeKey) ?? { requests: 0, tokens: 0 };
  totals.requests++;
  totals.tokens += Math.max(0, estimatedTokens);
  reservedCapacity.set(routeKey, totals);
  const id = `provider-${process.pid}-${nextReservationId++}`;
  capacityReservations.set(id, { routeKey, tokens: Math.max(0, estimatedTokens), requestReserved: true });
  return id;
}

export function commitProviderRequestReservation(id: string | undefined): void {
  if (!id) return;
  const reservation = capacityReservations.get(id);
  if (!reservation?.requestReserved) return;
  reservation.requestReserved = false;
  const totals = reservedCapacity.get(reservation.routeKey);
  if (totals) totals.requests = Math.max(0, totals.requests - 1);
}

export function releaseProviderCapacity(id: string | undefined): void {
  if (!id) return;
  const reservation = capacityReservations.get(id);
  if (!reservation) return;
  const totals = reservedCapacity.get(reservation.routeKey);
  if (totals) {
    if (reservation.requestReserved) totals.requests = Math.max(0, totals.requests - 1);
    totals.tokens = Math.max(0, totals.tokens - reservation.tokens);
    if (totals.requests === 0 && totals.tokens === 0) reservedCapacity.delete(reservation.routeKey);
  }
  capacityReservations.delete(id);
}

export function recordRequest(platform: string, modelId: string, keyId: number) {
  const now = Date.now();
  if (!recordUsage(platform, modelId, keyId, 'request', 0, now)) {
    noteUnpersistedRequest(reservationKey(platform, modelId, keyId), now);
  }
}

export function recordTokens(
  platform: string,
  modelId: string,
  keyId: number,
  tokens: number,
) {
  const now = Date.now();
  if (!recordUsage(platform, modelId, keyId, 'tokens', tokens, now)) {
    noteUnpersistedTokens(reservationKey(platform, modelId, keyId), tokens, now);
  }
}

// Cooldown: when a provider returns 429, block that model+key for a period
const cooldowns = new Map<string, number>(); // key -> expiry timestamp

// Escalating cooldown: track hits per key over a rolling 24h window so a
// daily-quota exhaustion (OpenRouter free: 50/day, Cohere free: 33/day, etc.)
// quarantines the key for the rest of the day instead of looping through
// the 2-minute cooldown 20 times per request and consuming every fallback slot.
// In-memory only — state resets on restart, which is fine (a clean restart
// will re-escalate on the next 429 if the quota is genuinely exhausted).
const cooldownHits = new Map<string, number[]>(); // key -> timestamps of recent cooldown set events
const COOLDOWN_DURATIONS = [
  2 * MINUTE,   // 1st hit in 24h
  10 * MINUTE,  // 2nd
  HOUR,         // 3rd
  DAY,          // 4th and beyond
];

export function getNextCooldownDuration(platform: string, modelId: string, keyId: number): number {
  const key = `${platform}:${modelId}:${keyId}`;
  const now = Date.now();
  const hits = (cooldownHits.get(key) ?? []).filter(t => t > now - DAY);
  hits.push(now);
  cooldownHits.set(key, hits);
  const idx = Math.min(hits.length - 1, COOLDOWN_DURATIONS.length - 1);
  return COOLDOWN_DURATIONS[idx]!;
}

function persistedCooldownExpiry(
  platform: string,
  modelId: string,
  keyId: number,
): number | null | undefined {
  return withDb(db => {
    const row = db.prepare(`
      SELECT expires_at_ms
        FROM rate_limit_cooldowns
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
    `).get(platform, modelId, keyId) as { expires_at_ms: number } | undefined;
    return row?.expires_at_ms ?? null;
  });
}

function persistCooldown(platform: string, modelId: string, keyId: number, expiresAtMs: number) {
  withDb(db => {
    db.prepare(`
      INSERT INTO rate_limit_cooldowns (platform, model_id, key_id, expires_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(platform, model_id, key_id)
      DO UPDATE SET expires_at_ms = excluded.expires_at_ms
    `).run(platform, modelId, keyId, expiresAtMs);
  });
}

function clearPersistedCooldown(platform: string, modelId: string, keyId: number) {
  withDb(db => {
    db.prepare(`
      DELETE FROM rate_limit_cooldowns
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
    `).run(platform, modelId, keyId);
  });
}

export function setCooldown(platform: string, modelId: string, keyId: number, durationMs = 60_000) {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const expiresAtMs = Date.now() + durationMs;
  cooldowns.set(key, expiresAtMs);
  persistCooldown(platform, modelId, keyId, expiresAtMs);
}

export function isOnCooldown(platform: string, modelId: string, keyId: number): boolean {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const now = Date.now();
  const persistedExpiry = persistedCooldownExpiry(platform, modelId, keyId);
  if (persistedExpiry !== undefined && persistedExpiry !== null) {
    if (now > persistedExpiry) {
      cooldowns.delete(key);
      clearPersistedCooldown(platform, modelId, keyId);
      return false;
    }
    cooldowns.set(key, persistedExpiry);
    return true;
  }

  const expiry = cooldowns.get(key);
  if (!expiry) return false;
  if (now > expiry) {
    cooldowns.delete(key);
    return false;
  }
  return true;
}

export function getRateLimitStatus(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
) {
  const now = Date.now();

  return {
    rpm: { used: requestCount(platform, modelId, keyId, MINUTE, now), limit: limits.rpm },
    rpd: { used: requestCount(platform, modelId, keyId, DAY, now), limit: limits.rpd },
    tpm: { used: tokenCount(platform, modelId, keyId, MINUTE, now), limit: limits.tpm },
  };
}
