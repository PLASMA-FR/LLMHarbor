import type Database from 'better-sqlite3';
import { decrypt, encrypt } from '../lib/crypto.js';
import { ProviderError } from '../providers/base.js';
import { oauthTokenClient } from './oauth-clients.js';

const refreshInFlight = new Map<number, Promise<any>>();
const refreshControllers = new Map<number, AbortController>();
let acceptingRefreshes = true;

function refreshDue(account: any): boolean {
  const expiresAt = account.expires_at ? Date.parse(account.expires_at) : 0;
  return Boolean(expiresAt && expiresAt - Date.now() <= 5 * 60 * 1000);
}

function rawRefreshToken(provider: string, encrypted: string, iv: string, authTag: string): string {
  const value = decrypt(encrypted, iv, authTag);
  return provider === 'antigravity' ? value.split('|')[0] : value;
}

function markNeedsReconnect(db: Database.Database, account: any, message: string): void {
  let metadata: Record<string, unknown> = {};
  try { metadata = account.metadata_json ? JSON.parse(account.metadata_json) : {}; } catch {}
  metadata.oauthNeedsReconnect = true;
  metadata.oauthDiscoveryError = message;
  metadata.oauthModelCount = 0;
  metadata.oauthLastDiscoveredAt = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE oauth_accounts SET metadata_json = ?, last_discovered_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(metadata), account.id);
    db.prepare("UPDATE api_keys SET status = 'invalid', enabled = 0, last_checked_at = datetime('now') WHERE oauth_account_id = ?")
      .run(account.id);
  })();
}

async function refreshAccount(db: Database.Database, accountId: number, signal: AbortSignal): Promise<any> {
  // Always re-read inside the single-flight operation. A request that acquired
  // the lock after another refresh must observe the rotated refresh token.
  const account = db.prepare('SELECT * FROM oauth_accounts WHERE id = ? AND enabled = 1').get(accountId) as any;
  if (!account) throw new ProviderError('OAuth account is unavailable.', { retryable: false, code: 'oauth_account_unavailable' });
  if (!refreshDue(account)) return account;

  if (!account.encrypted_refresh_token || !account.refresh_iv || !account.refresh_auth_tag) {
    const message = 'OAuth access token expired and no refresh token is available.';
    markNeedsReconnect(db, account, message);
    throw new ProviderError(`${message} Reconnect the browser account.`, { statusCode: 401, retryable: false, code: 'oauth_reconnect_required' });
  }
  const client = oauthTokenClient(account.provider);
  if (!client || (client.requiresClientSecret && !client.clientSecret)) {
    throw new ProviderError('OAuth refresh client configuration is unavailable.', { retryable: false, code: 'oauth_configuration_error' });
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: client.clientId,
    refresh_token: rawRefreshToken(account.provider, account.encrypted_refresh_token, account.refresh_iv, account.refresh_auth_tag),
  });
  if (client.clientSecret) params.set('client_secret', client.clientSecret);
  const upstream = await fetch(client.tokenUrl, {
    method: 'POST',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const responseText = await upstream.text().catch(() => '');
  let tokenData: any = {};
  try { tokenData = responseText ? JSON.parse(responseText) : {}; } catch {}
  if (!upstream.ok) {
    const structuredDetail = [tokenData.error, tokenData.error_description].filter((value: unknown) => typeof value === 'string' && value).join(': ');
    const detail = String(structuredDetail || responseText || upstream.statusText).slice(0, 300);
    const message = `${client.name} token refresh failed with HTTP ${upstream.status}.`;
    // Rotating tokens are disabled only when the authorization server
    // definitively rejects the grant. Transient 429/5xx/403 failures remain
    // enabled and retryable rather than forcing an unnecessary reconnect.
    const reconnect = upstream.status === 401 || /\binvalid_grant\b/i.test(detail);
    if (reconnect) markNeedsReconnect(db, account, `${client.name} authorization expired. Reconnect the browser account.`);
    throw new ProviderError(reconnect ? `${message} Reconnect the browser account.` : message, {
      statusCode: upstream.status,
      retryable: !reconnect,
      code: reconnect ? 'oauth_reconnect_required' : 'oauth_refresh_failed',
    });
  }
  if (typeof tokenData.access_token !== 'string' || !tokenData.access_token) {
    throw new ProviderError(`${client.name} token refresh response did not contain an access token.`, {
      retryable: true,
      code: 'malformed_oauth_refresh_response',
    });
  }

  const access = encrypt(tokenData.access_token);
  const nextRefresh = typeof tokenData.refresh_token === 'string' && tokenData.refresh_token
    ? encrypt(tokenData.refresh_token)
    : null;
  const expiresAt = typeof tokenData.expires_in === 'number' && Number.isFinite(tokenData.expires_in)
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : account.expires_at;
  db.transaction(() => {
    db.prepare(`
      UPDATE oauth_accounts
         SET encrypted_access_token = ?, access_iv = ?, access_auth_tag = ?,
             encrypted_refresh_token = COALESCE(?, encrypted_refresh_token),
             refresh_iv = COALESCE(?, refresh_iv),
             refresh_auth_tag = COALESCE(?, refresh_auth_tag),
             expires_at = ?, last_used_at = datetime('now')
       WHERE id = ?
    `).run(access.encrypted, access.iv, access.authTag, nextRefresh?.encrypted ?? null, nextRefresh?.iv ?? null, nextRefresh?.authTag ?? null, expiresAt, account.id);
    db.prepare(`
      UPDATE api_keys
         SET encrypted_key = ?, iv = ?, auth_tag = ?, status = 'healthy', last_checked_at = datetime('now')
       WHERE oauth_account_id = ?
    `).run(access.encrypted, access.iv, access.authTag, account.id);
  })();
  return db.prepare('SELECT * FROM oauth_accounts WHERE id = ?').get(account.id);
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Request cancelled.'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('Request cancelled.')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export function ensureFreshOAuthAccount(db: Database.Database, accountId: number, signal?: AbortSignal): Promise<any> {
  if (!acceptingRefreshes) return Promise.reject(new Error('OAuth refresh service is shutting down.'));
  let refresh = refreshInFlight.get(accountId);
  if (!refresh) {
    const controller = new AbortController();
    refreshControllers.set(accountId, controller);
    refresh = refreshAccount(db, accountId, controller.signal).finally(() => {
      if (refreshInFlight.get(accountId) === refresh) {
        refreshInFlight.delete(accountId);
        refreshControllers.delete(accountId);
      }
    });
    refreshInFlight.set(accountId, refresh);
  }
  return awaitWithSignal(refresh, signal);
}

/**
 * Refresh an OAuth account after the upstream rejects an access token before
 * its recorded expiry. The expiry update occurs before entering the normal
 * per-account single-flight path, so concurrent 401s still perform one token
 * exchange and all waiters observe the rotated token.
 */
export async function forceRefreshOAuthAccount(db: Database.Database, accountId: number, signal?: AbortSignal): Promise<any> {
  const existing = refreshInFlight.get(accountId);
  if (existing) return awaitWithSignal(existing, signal);
  db.prepare("UPDATE oauth_accounts SET expires_at = datetime('now', '-1 minute') WHERE id = ? AND enabled = 1")
    .run(accountId);
  return ensureFreshOAuthAccount(db, accountId, signal);
}

export async function stopOAuthRefreshes(): Promise<void> {
  acceptingRefreshes = false;
  for (const controller of refreshControllers.values()) {
    controller.abort(new Error('OAuth refresh service stopped.'));
  }
  await Promise.allSettled(Array.from(refreshInFlight.values()));
}
