import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import type { Platform, KeyStatus } from '@llmharbor/shared/types.js';
import { redactSensitive } from '../lib/errors.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CONSECUTIVE_FAILURES_TO_DISABLE = 3;

// Track consecutive failures per key
const failureCount = new Map<number, number>();
const activeKeyChecks = new Set<Promise<KeyStatus>>();
const activeKeyCheckControllers = new Set<AbortController>();
let acceptingHealthChecks = true;
export function resetKeyHealthFailures(keyId: number): void { failureCount.delete(keyId); }

export function checkKeyHealth(keyId: number, signal?: AbortSignal): Promise<KeyStatus> {
  if (!acceptingHealthChecks) return Promise.resolve('error');
  const controller = new AbortController();
  activeKeyCheckControllers.add(controller);
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const operation = checkKeyHealthInternal(keyId, combinedSignal).finally(() => {
    activeKeyChecks.delete(operation);
    activeKeyCheckControllers.delete(controller);
  });
  activeKeyChecks.add(operation);
  return operation;
}

async function checkKeyHealthInternal(keyId: number, signal?: AbortSignal): Promise<KeyStatus> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as any;
  if (!row) return 'error';

  if (row.source === 'oauth' || row.oauth_account_id) {
    // OAuth credentials are refreshed/validated on the request path. Do not
    // turn a provider-confirmed 401 back into "healthy" without a successful
    // refresh; oauth-refresh updates the projected key after it rotates.
    const account = row.oauth_account_id
      ? db.prepare('SELECT enabled, metadata_json FROM oauth_accounts WHERE id = ?').get(row.oauth_account_id) as { enabled: number; metadata_json: string | null } | undefined
      : undefined;
    let needsReconnect = false;
    try {
      needsReconnect = Boolean(account?.metadata_json && JSON.parse(account.metadata_json).oauthNeedsReconnect);
    } catch {
      needsReconnect = true;
    }
    const existing: KeyStatus = ['healthy', 'rate_limited', 'invalid', 'error', 'unknown'].includes(row.status)
      ? row.status
      : 'error';
    const status: KeyStatus = !account || !account.enabled || needsReconnect ? 'invalid' : existing;
    db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run(status, keyId);
    if (status === 'healthy') failureCount.delete(keyId);
    return status;
  }

  const provider = getProvider(row.platform as Platform);
  if (!provider) return 'error';

  try {
    const apiKey = row.source === 'anonymous' ? '' : decrypt(row.encrypted_key, row.iv, row.auth_tag);
    const isValid = await provider.validateKey(apiKey, signal);

    // A check started before secret replacement must not invalidate the new
    // credential or contribute to its consecutive-failure count.
    const current = db.prepare('SELECT encrypted_key, iv, auth_tag, status FROM api_keys WHERE id = ?').get(keyId) as typeof row | undefined;
    if (!current) return 'error';
    if (current.encrypted_key !== row.encrypted_key || current.iv !== row.iv || current.auth_tag !== row.auth_tag) return current.status as KeyStatus;

    const status: KeyStatus = isValid ? 'healthy' : 'invalid';

    db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run(status, keyId);

    if (isValid) {
      failureCount.delete(keyId);
    } else {
      const count = (failureCount.get(keyId) ?? 0) + 1;
      failureCount.set(keyId, count);

      if (count >= CONSECUTIVE_FAILURES_TO_DISABLE) {
        db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(keyId);
        console.log(`[Health] Auto-disabled key ${keyId} after ${count} consecutive failures`);
      }
    }

    return status;
  } catch (err: any) {
    if (signal?.aborted) return row.status as KeyStatus;
    // Transport errors (DNS/timeout/TLS) — provider unreachable, not necessarily
    // a bad key. Mark status='error' but do NOT increment failure counter — auto-
    // disable is reserved for confirmed 401/403 (returned by validateKey as false).
    console.error(`[Health] Key ${keyId} transport error:`, redactSensitive(err.message));
    db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ? AND encrypted_key = ? AND iv = ? AND auth_tag = ?")
      .run('error', keyId, row.encrypted_key, row.iv, row.auth_tag);
    return 'error';
  }
}

let allKeysCheck: Promise<void> | null = null;
let allKeysController: AbortController | null = null;

async function runAllKeyChecks(signal: AbortSignal): Promise<void> {
  const db = getDb();
  const keys = db.prepare('SELECT id, platform FROM api_keys WHERE enabled = 1').all() as { id: number; platform: string }[];

  console.log(`[Health] Checking ${keys.length} keys...`);

  let next = 0;
  const workers = Array.from({ length: Math.min(4, keys.length) }, async () => {
    while (next < keys.length) {
      if (signal.aborted) return;
      const key = keys[next++];
      await checkKeyHealth(key.id, signal);
    }
  });
  await Promise.all(workers);

  console.log(`[Health] Check complete.`);
}

export function checkAllKeys(): Promise<void> {
  if (allKeysCheck) return allKeysCheck;
  const controller = new AbortController();
  allKeysController = controller;
  allKeysCheck = runAllKeyChecks(controller.signal).finally(() => {
    if (allKeysController === controller) allKeysController = null;
    allKeysCheck = null;
  });
  return allKeysCheck;
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startHealthChecker(): void {
  if (intervalId) return;
  console.log(`[Health] Starting health checker (every ${CHECK_INTERVAL_MS / 1000}s)`);
  intervalId = setInterval(() => {
    checkAllKeys().catch(err => console.error('[Health] Check failed:', redactSensitive(err)));
  }, CHECK_INTERVAL_MS);
  intervalId.unref?.();
}

export async function stopHealthChecker(): Promise<void> {
  acceptingHealthChecks = false;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  allKeysController?.abort(new Error('Health checker stopped.'));
  for (const controller of activeKeyCheckControllers) {
    controller.abort(new Error('Health checker stopped.'));
  }
  // Do not close SQLite while an already-started health pass can still write.
  // Individual provider calls retain their own bounded timeouts.
  if (allKeysCheck) await allKeysCheck.catch(() => undefined);
  await Promise.allSettled(Array.from(activeKeyChecks));
}
