import { sendValidationError } from '../lib/validation.js';
import crypto from 'crypto';
import { createServer, type Server as HttpServer } from 'http';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { safeUpstreamFailure } from '../lib/errors.js';
import { parsePositiveResourceId } from '../lib/resourceId.js';
import { toUtcTimestamp } from '../lib/time.js';
import { refreshOAuthAccountInventory } from '../services/oauth-discovery.js';
import { ANTIGRAVITY_OAUTH_CLIENT_ID, ANTIGRAVITY_OAUTH_TOKEN_URL, OPENAI_OAUTH_CLIENT_ID, OPENAI_OAUTH_TOKEN_URL, oauthTokenClient } from '../services/oauth-clients.js';

export const oauthRouter = Router();

type BrowserOAuthProvider = {
  id: string;
  name: string;
  kind: string;
  loginMode: 'browser-oauth' | 'device-oauth';
  authorizationUrl: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  audience?: string;
  modelsUrl: string | null;
  scopes: string[];
  supportsDiscovery: boolean;
  notes: string;
};

const BROWSER_OAUTH_PROVIDERS: BrowserOAuthProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI / ChatGPT subscription',
    kind: 'openai',
    loginMode: 'browser-oauth',
    authorizationUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: OPENAI_OAUTH_TOKEN_URL,
    clientId: OPENAI_OAUTH_CLIENT_ID,
    modelsUrl: 'https://chatgpt.com/backend-api/codex/models?client_version=999.0.0',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    supportsDiscovery: true,
    notes: 'OpenCode-compatible ChatGPT browser OAuth: auth.openai.com, public native client, localhost:1455/auth/callback, encrypted local storage.',
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    kind: 'google',
    loginMode: 'browser-oauth',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: ANTIGRAVITY_OAUTH_TOKEN_URL,
    clientId: ANTIGRAVITY_OAUTH_CLIENT_ID,
    modelsUrl: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    scopes: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile', 'https://www.googleapis.com/auth/cclog', 'https://www.googleapis.com/auth/experimentsandconfigs'],
    supportsDiscovery: true,
    notes: 'Antigravity-native Google OAuth using the public native client from antigravity-claude-proxy: localhost:51121/oauth-callback, Code Assist scopes, live model discovery only, encrypted local storage.',
  },
  {
    id: 'freebuff',
    name: 'Freebuff / Codebuff browser account',
    kind: 'freebuff',
    loginMode: 'device-oauth',
    authorizationUrl: 'https://freebuff.com/api/auth/cli/code',
    modelsUrl: 'https://www.codebuff.com/api/v1/freebuff/session',
    scopes: ['Codebuff CLI browser session'],
    supportsDiscovery: true,
    notes: 'Device-code OAuth using the same browser-account auth token as Freebuff/Codebuff CLI. LLMHarbor stores the token encrypted and exposes Freebuff models through the OpenAI-compatible API.',
  },
];

const FREEBUFF_AUTH_BASE_URLS = ['https://freebuff.com', 'https://www.codebuff.com'];
const FREEBUFF_OAUTH_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Bun/1.3.11' };

const oauthStateSchema = z.string().min(16).max(512);
const oauthAuthorizationCodeSchema = z.string().min(1).max(16_384);

const callbackSchema = z.object({
  state: oauthStateSchema,
  code: oauthAuthorizationCodeSchema.optional(),
  error: z.string().max(256).optional(),
  error_description: z.string().max(2_048).optional(),
});

const manualBrowserCallbackSchema = z.union([
  z.object({ callbackUrl: z.string().trim().min(1).max(32_768) }).strict(),
  z.object({ state: oauthStateSchema, code: oauthAuthorizationCodeSchema }).strict(),
]);

const updateAccountSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
}).refine(body => body.label !== undefined || body.enabled !== undefined, {
  message: 'Provide label or enabled',
});

let openaiCallbackServer: HttpServer | null = null;
const googleCallbackServers = new Map<string, HttpServer>();
const oauthCallbackControllers = new Set<AbortController>();

function boundedRequestOperation(req: Request, res: Response, timeoutMs = 30_000): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException('Client disconnected.', 'AbortError'));
  const abortOnClose = () => {
    if (!res.writableEnded) abort();
  };
  req.once('aborted', abort);
  res.once('close', abortOnClose);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
  const onTimeout = () => {
    if (signal.reason?.name === 'TimeoutError' && !res.headersSent && !res.destroyed) {
      res.status(504).json({ error: {
        message: 'OAuth operation timed out. Try again.', type: 'upstream_error',
        code: 'oauth_timeout', request_id: String(res.locals.requestId ?? 'unknown'),
      } });
    }
  };
  signal.addEventListener('abort', onTimeout, { once: true });
  return {
    signal,
    cleanup: () => {
      req.off('aborted', abort);
      res.off('close', abortOnClose);
      signal.removeEventListener('abort', onTimeout);
    },
  };
}

function cleanupOAuthLoginStates(): void {
  getDb().prepare(`
    DELETE FROM oauth_login_states
     WHERE expires_at <= datetime('now')
        OR (consumed_at IS NOT NULL AND consumed_at <= datetime('now', '-1 day'))
  `).run();
}

function closeCallbackServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise(resolve => server.close(() => resolve()));
}

/** Stop localhost OAuth listeners and abort any in-flight token exchanges. */
export async function stopOAuthCallbackServers(): Promise<void> {
  for (const controller of oauthCallbackControllers) {
    if (!controller.signal.aborted) controller.abort(new Error('LLMHarbor is shutting down.'));
  }
  const active = [openaiCallbackServer, ...googleCallbackServers.values()]
    .filter((server): server is HttpServer => server !== null);
  openaiCallbackServer = null;
  googleCallbackServers.clear();
  await Promise.all(active.map(closeCallbackServer));
}

function runtimePlatformFor(providerId: string) {
  if (providerId === 'openai') return 'openai';
  if (providerId === 'antigravity') return 'google-oauth';
  if (providerId === 'freebuff') return 'freebuff';
  return providerId;
}

function syncProviderKeyForOAuthAccount(accountId: number, rawAccessToken?: string) {
  const db = getDb();
  const account = db.prepare('SELECT * FROM oauth_accounts WHERE id = ?').get(accountId) as any;
  if (!account) return;
  const provider = providerById(account.provider);
  const platform = runtimePlatformFor(account.provider);
  const label = `${provider?.name ?? account.provider} · ${account.account_hint ?? `account ${account.id}`}`;
  const enabled = account.enabled === 1 ? 1 : 0;
  const existing = db.prepare('SELECT id FROM api_keys WHERE oauth_account_id = ?').get(accountId) as { id: number } | undefined;

  if (existing) {
    if (rawAccessToken) {
      const access = encrypt(rawAccessToken);
      db.prepare(`
        UPDATE api_keys
        SET platform = ?, label = ?, encrypted_key = ?, iv = ?, auth_tag = ?, status = 'healthy', enabled = ?, source = 'oauth'
        WHERE oauth_account_id = ?
      `).run(platform, label, access.encrypted, access.iv, access.authTag, enabled, accountId);
    } else {
      db.prepare(`
        UPDATE api_keys
        SET platform = ?, label = ?, enabled = ?, source = 'oauth'
        WHERE oauth_account_id = ?
      `).run(platform, label, enabled, accountId);
    }
    return;
  }

  const access = rawAccessToken
    ? encrypt(rawAccessToken)
    : { encrypted: account.encrypted_access_token, iv: account.access_iv, authTag: account.access_auth_tag };
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, source, oauth_account_id)
    VALUES (?, ?, ?, ?, ?, 'healthy', ?, 'oauth', ?)
  `).run(platform, label, access.encrypted, access.iv, access.authTag, enabled, accountId);
}

async function finishBrowserOAuth(provider: BrowserOAuthProvider, state: string, code: string, signal?: AbortSignal) {
  if (!provider.clientId || !provider.tokenUrl) throw new Error(`${provider.name} is not a browser OAuth provider.`);
  const clientId = provider.clientId;
  const tokenUrl = provider.tokenUrl;
  const db = getDb();
  // Claim before the network exchange. OAuth authorization codes are
  // single-use, so a failed exchange requires starting login again; allowing
  // two callbacks to race would instead create duplicate accounts.
  const stateRow = db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM oauth_login_states
      WHERE state = ? AND provider = ? AND consumed_at IS NULL AND expires_at > datetime('now')
    `).get(state, provider.id) as any;
    if (!row) return null;
    const claimed = db.prepare(`
      UPDATE oauth_login_states
         SET consumed_at = datetime('now')
       WHERE state = ? AND provider = ? AND consumed_at IS NULL AND expires_at > datetime('now')
    `).run(state, provider.id);
    return claimed.changes === 1 ? row : null;
  })();
  if (!stateRow) throw new Error('OAuth login state expired. Return to LLMHarbor and start login again.');
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: stateRow.redirect_uri,
  });
  // OpenAI's native client and Google's Code Assist/Gemini client both use PKCE.
  // Google returns invalid_grant "Missing code verifier" if this is omitted.
  params.set('code_verifier', stateRow.code_verifier);
  if (provider.kind === 'google') {
    const secret = antigravityOAuthSecret(provider);
    if (!secret) throw new Error('Antigravity OAuth client secret was not found. Set LLMHARBOR_ANTIGRAVITY_OAUTH_CLIENT_SECRET.');
    params.set('client_secret', secret);
  }
  const upstream = await fetch(tokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {});
    throw new Error(`${provider.name} token exchange failed with HTTP ${upstream.status}.`);
  }
  const tokenData = await upstream.json().catch(() => {
    throw new Error(`${provider.name} token exchange returned malformed JSON.`);
  }) as any;
  if (!tokenData.access_token) throw new Error(`${provider.name} token response did not contain an access token.`);
  const access = encrypt(String(tokenData.access_token));
  const refresh = tokenData.refresh_token ? encrypt(String(tokenData.refresh_token)) : null;
  const expiresAt = typeof tokenData.expires_in === 'number' ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : null;
  const accountHint = accountHintForToken(provider, tokenData);
  let accountId = 0;
  getDb().transaction(() => {
    const result = getDb().prepare(`
      INSERT INTO oauth_accounts (provider, label, account_hint, encrypted_access_token, access_iv, access_auth_tag, encrypted_refresh_token, refresh_iv, refresh_auth_tag, expires_at, metadata_json, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(provider.id, `${provider.name} - ${accountHint}`, accountHint, access.encrypted, access.iv, access.authTag, refresh?.encrypted ?? null, refresh?.iv ?? null, refresh?.authTag ?? null, expiresAt, JSON.stringify(metadataForToken(provider, tokenData, 'browser-oauth')));
    accountId = Number(result.lastInsertRowid);
    syncProviderKeyForOAuthAccount(accountId, String(tokenData.access_token));
  })();
  try { await refreshOAuthAccountInventory(getDb(), accountId, signal); } catch {}
}

function ensureChatgptCallbackServer() {
  if (openaiCallbackServer?.listening) return Promise.resolve();
  const provider = providerById('openai');
  if (!provider) throw new Error('OpenAI provider is not registered');
  openaiCallbackServer = createServer(async (req, res) => {
    const controller = new AbortController();
    oauthCallbackControllers.add(controller);
    const url = new URL(req.url ?? '/', 'http://localhost:1455');
    if (url.pathname !== '/auth/callback') {
      oauthCallbackControllers.delete(controller);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    try {
      const error = url.searchParams.get('error');
      if (error) throw new Error(url.searchParams.get('error_description') || error);
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      if (!state || !code) throw new Error('Missing authorization code or state');
      await finishBrowserOAuth(provider, state, code, controller.signal);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>LLMHarbor connected</title><body style="font-family:system-ui;background:#0f1115;color:#f4f1ea;display:grid;place-items:center;min-height:100vh"><main><h1>Account connected</h1><p>You can close this window and return to LLMHarbor.</p><script>setTimeout(()=>window.close(),1800)</script></main></body>');
    } catch (error: any) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><title>LLMHarbor OAuth failed</title><body style="font-family:system-ui"><h1>Connection failed</h1><p>${escapeHtml(error?.message ?? error)}</p></body>`);
    } finally {
      oauthCallbackControllers.delete(controller);
    }
  });
  return new Promise<void>((resolve, reject) => {
    openaiCallbackServer!.once('error', reject);
    openaiCallbackServer!.listen(1455, '127.0.0.1', () => resolve());
  });
}


function antigravityOAuthSecret(provider?: BrowserOAuthProvider) {
  return oauthTokenClient(provider?.id ?? 'antigravity')?.clientSecret || provider?.clientSecret || '';
}

function antigravityCallbackPort() {
  return 51121;
}

function metadataForToken(provider: BrowserOAuthProvider, tokenData: any, connectedVia: 'browser-oauth' | 'device-oauth') {
  return {
    tokenType: tokenData.token_type ?? 'Bearer',
    connectedVia,
    runtimePlatform: runtimePlatformFor(provider.id),
  };
}

function accountHintForToken(provider: BrowserOAuthProvider, tokenData: any) {
  return tokenData.email ?? tokenData.account_hint ?? `${provider.name} account`;
}

function freebuffUserCode(loginUrl: string) {
  try {
    const url = new URL(loginUrl);
    return url.searchParams.get('code')
      ?? url.searchParams.get('user_code')
      ?? url.pathname.split('/').filter(Boolean).pop()
      ?? 'OPEN';
  } catch {
    return 'OPEN';
  }
}

function parseDeviceState(row: any) {
  try {
    const parsed = JSON.parse(row.code_verifier);
    if (parsed && typeof parsed === 'object') return parsed as { fingerprintId: string; fingerprintHash: string; expiresAt: string; authBaseUrl: string };
  } catch {}
  throw new Error('Device login state is invalid. Start login again.');
}

function deviceExpiresAtMs(value: unknown) {
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
  const text = String(value ?? '');
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : Date.now() + 10 * 60 * 1000;
}

async function startFreebuffDeviceOAuth(provider: BrowserOAuthProvider, signal?: AbortSignal) {
  const fingerprintId = `llmharbor-${crypto.randomBytes(12).toString('hex')}`;
  let lastError = '';
  for (const authBaseUrl of FREEBUFF_AUTH_BASE_URLS) {
    const upstream = await fetch(`${authBaseUrl}/api/auth/cli/code`, {
      method: 'POST',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      headers: FREEBUFF_OAUTH_HEADERS,
      body: JSON.stringify({ fingerprintId }),
    }).catch(error => {
      lastError = String(error?.message ?? error);
      return null;
    });
    if (!upstream) continue;
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      lastError = `HTTP ${upstream.status}`;
      continue;
    }
    const data = await upstream.json().catch(() => null) as any;
    if (!data?.loginUrl || !data.fingerprintHash || !data.expiresAt) {
      lastError = 'Login response did not include loginUrl, fingerprintHash, and expiresAt.';
      continue;
    }
    const state = crypto.randomUUID?.() ?? crypto.randomBytes(16).toString('hex');
    const expiresAt = String(data.expiresAt);
    const expiresAtMs = deviceExpiresAtMs(data.expiresAt);
    const expiresInSeconds = Math.max(30, Math.floor((expiresAtMs - Date.now()) / 1000));
    cleanupOAuthLoginStates();
    getDb().prepare(`
      INSERT INTO oauth_login_states (state, provider, code_verifier, redirect_uri, expires_at)
      VALUES (?, ?, ?, ?, datetime('now', ?))
    `).run(
      state,
      provider.id,
      JSON.stringify({ fingerprintId, fingerprintHash: data.fingerprintHash, expiresAt, authBaseUrl }),
      String(data.loginUrl),
      `+${Math.ceil(expiresInSeconds / 60)} minutes`,
    );
    return {
      authUrl: String(data.loginUrl),
      state,
      userCode: freebuffUserCode(String(data.loginUrl)),
      verificationUri: authBaseUrl,
      verificationUriComplete: String(data.loginUrl),
      expiresInSeconds,
      intervalSeconds: 3,
      loginMode: 'device-oauth' as const,
    };
  }
  throw new Error(`Freebuff device login failed. ${lastError || 'No auth endpoint responded.'}`);
}

async function completeFreebuffDeviceOAuth(provider: BrowserOAuthProvider, state: string, signal?: AbortSignal) {
  const stateRow = getDb().prepare(`
    SELECT * FROM oauth_login_states
    WHERE state = ? AND provider = ? AND consumed_at IS NULL AND expires_at > datetime('now')
  `).get(state, provider.id) as any;
  if (!stateRow) throw new Error('Device login state expired. Start Freebuff login again.');
  const device = parseDeviceState(stateRow);
  const statusUrl = new URL(`${device.authBaseUrl}/api/auth/cli/status`);
  statusUrl.searchParams.set('fingerprintId', device.fingerprintId);
  statusUrl.searchParams.set('fingerprintHash', device.fingerprintHash);
  statusUrl.searchParams.set('expiresAt', device.expiresAt);
  const upstream = await fetch(statusUrl, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    headers: { Accept: 'application/json', 'User-Agent': 'Bun/1.3.11' },
  });
  if (upstream.status === 401) {
    await upstream.body?.cancel().catch(() => {});
    return { pending: true };
  }
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {});
    throw new Error(`Freebuff login status failed with HTTP ${upstream.status}.`);
  }
  const data = await upstream.json().catch(() => {
    throw new Error('Freebuff login status returned malformed JSON.');
  }) as any;
  const user = data.user;
  if (!user?.authToken) return { pending: true };

  const token = String(user.authToken);
  const access = encrypt(token);
  const accountHint = user.email ?? user.name ?? 'Freebuff account';
  let accountId = 0;
  getDb().transaction(() => {
    const claimed = getDb().prepare(`
      UPDATE oauth_login_states
         SET consumed_at = datetime('now')
       WHERE state = ? AND provider = ? AND consumed_at IS NULL AND expires_at > datetime('now')
    `).run(state, provider.id);
    if (claimed.changes !== 1) throw new Error('Device login was already completed. Start Freebuff login again.');
    const result = getDb().prepare(`
      INSERT INTO oauth_accounts (provider, label, account_hint, encrypted_access_token, access_iv, access_auth_tag, metadata_json, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(provider.id, `${provider.name} - ${accountHint}`, accountHint, access.encrypted, access.iv, access.authTag, JSON.stringify({
      ...metadataForToken(provider, { token_type: 'Bearer' }, 'device-oauth'),
      authBaseUrl: device.authBaseUrl,
      userId: user.id ?? null,
      name: user.name ?? null,
      email: user.email ?? null,
    }));
    accountId = Number(result.lastInsertRowid);
    syncProviderKeyForOAuthAccount(accountId, token);
  })();
  try { await refreshOAuthAccountInventory(getDb(), accountId, signal); } catch {}
  const row = getDb().prepare('SELECT * FROM oauth_accounts WHERE id = ?').get(accountId) as any;
  return { account: rowToAccount(row) };
}

function ensureAntigravityCallbackServer(provider: BrowserOAuthProvider) {
  const existing = googleCallbackServers.get(provider.id);
  if (existing?.listening) return Promise.resolve();
  const port = antigravityCallbackPort();
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    oauthCallbackControllers.add(controller);
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== '/oauth-callback') {
      oauthCallbackControllers.delete(controller);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    try {
      const error = url.searchParams.get('error');
      if (error) throw new Error(url.searchParams.get('error_description') || error);
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      if (!state || !code) throw new Error('Missing authorization code or state');
      await finishBrowserOAuth(provider, state, code, controller.signal);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>LLMHarbor connected</title><body style="font-family:system-ui;background:#0f1115;color:#f4f1ea;display:grid;place-items:center;min-height:100vh"><main><h1>Antigravity account connected</h1><p>You can close this window and return to LLMHarbor.</p><script>setTimeout(()=>window.close(),1800)</script></main></body>');
    } catch (error: any) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><title>LLMHarbor OAuth failed</title><body style="font-family:system-ui"><h1>Connection failed</h1><p>${escapeHtml(error?.message ?? error)}</p></body>`);
    } finally {
      oauthCallbackControllers.delete(controller);
    }
  });
  googleCallbackServers.set(provider.id, server);
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

function providerById(id: string) {
  return BROWSER_OAUTH_PROVIDERS.find(provider => provider.id === id);
}

function base64Url(buffer: Buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function sha256(input: string) {
  return base64Url(crypto.createHash('sha256').update(input).digest());
}

function escapeHtml(value: unknown) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function publicProvider(provider: BrowserOAuthProvider) {
  const configured = provider.loginMode === 'device-oauth'
    ? true
    : Boolean(provider.clientId) && (provider.kind !== 'google' || Boolean(antigravityOAuthSecret(provider)));
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    scopes: provider.scopes,
    supportsDiscovery: provider.supportsDiscovery,
    loginMode: provider.loginMode,
    authorizationUrl: provider.authorizationUrl,
    callbackPath: `/api/oauth/callback/${provider.id}`,
    configured,
    canConnect: configured,
    notes: provider.notes,
  };
}

function rowToAccount(row: any) {
  let maskedToken = 'encrypted';
  let metadata: Record<string, any> = {};
  try { maskedToken = maskKey(decrypt(row.encrypted_access_token, row.access_iv, row.access_auth_tag)); } catch {}
  try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {}; } catch {}
  return {
    id: row.id,
    provider: row.provider,
    providerName: providerById(row.provider)?.name ?? row.provider,
    label: row.label,
    accountHint: row.account_hint,
    maskedToken,
    enabled: row.enabled === 1,
    expiresAt: toUtcTimestamp(row.expires_at),
    lastUsedAt: toUtcTimestamp(row.last_used_at),
    lastDiscoveredAt: toUtcTimestamp(row.last_discovered_at),
    metadata,
    limits: Array.isArray(metadata.oauthLimits) ? metadata.oauthLimits : [],
    modelCount: typeof metadata.oauthModelCount === 'number' ? metadata.oauthModelCount : null,
    createdAt: toUtcTimestamp(row.created_at),
  };
}

function baseUrl(req: Request) {
  const proto = req.get('x-forwarded-proto') ?? req.protocol;
  return `${proto}://${req.get('host')}`;
}

function callbackUri(req: Request, providerId: string) {
  if (providerId === 'openai') return 'http://localhost:1455/auth/callback';
  if (providerId === 'antigravity') return 'http://localhost:51121/oauth-callback';
  return `${baseUrl(req)}/api/oauth/callback/${encodeURIComponent(providerId)}`;
}

type BrowserCallbackFields = { state: string; code: string };

function browserCallbackFieldsFromUrl(req: Request, provider: BrowserOAuthProvider, rawCallbackUrl: string): BrowserCallbackFields {
  let submitted: URL;
  try {
    submitted = new URL(rawCallbackUrl);
  } catch {
    throw new Error('Paste the complete callback URL from the browser address bar.');
  }

  const expected = new URL(callbackUri(req, provider.id));
  if (submitted.protocol !== expected.protocol
    || submitted.hostname.toLowerCase() !== expected.hostname.toLowerCase()
    || submitted.port !== expected.port
    || submitted.pathname !== expected.pathname
    || submitted.username
    || submitted.password
    || submitted.hash) {
    throw new Error(`The callback URL must begin with ${expected.origin}${expected.pathname}.`);
  }

  for (const name of ['state', 'code', 'error', 'error_description']) {
    if (submitted.searchParams.getAll(name).length > 1) {
      throw new Error('The callback URL contains duplicate OAuth parameters. Start login again.');
    }
  }

  const parsed = callbackSchema.safeParse({
    state: submitted.searchParams.get('state') ?? undefined,
    code: submitted.searchParams.get('code') ?? undefined,
    error: submitted.searchParams.get('error') ?? undefined,
    error_description: submitted.searchParams.get('error_description') ?? undefined,
  });
  if (!parsed.success) {
    throw new Error('The callback URL is missing a valid authorization code or state.');
  }
  if (parsed.data.error) {
    throw new Error('The provider declined or could not complete authorization. Start login again.');
  }
  if (!parsed.data.code) {
    throw new Error('The callback URL does not contain an authorization code.');
  }
  return { state: parsed.data.state, code: parsed.data.code };
}

function cachedAccountInventory(row: any) {
  let metadata: Record<string, unknown> = {};
  try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {}; } catch {}
  const models = getDb().prepare(`
    SELECT oam.model_id AS id, m.display_name AS displayName, m.context_window AS contextWindow
      FROM oauth_account_models oam
      LEFT JOIN models m ON m.platform = oam.platform AND m.model_id = oam.model_id
     WHERE oam.oauth_account_id = ? AND oam.supported = 1
     ORDER BY m.intelligence_rank ASC, oam.model_id ASC
  `).all(row.id) as Array<{ id: string; displayName: string | null; contextWindow: number | null }>;
  return {
    models: models.map(model => ({
      id: model.id,
      object: 'model',
      displayName: model.displayName ?? model.id,
      ownedBy: row.provider,
      contextWindow: model.contextWindow,
      visibility: null,
    })),
    limits: Array.isArray(metadata.oauthLimits) ? metadata.oauthLimits : [],
    provider: row.provider,
    automatic: true,
  };
}

oauthRouter.get('/providers', (_req: Request, res: Response) => {
  res.json({ providers: BROWSER_OAUTH_PROVIDERS.map(publicProvider) });
});

oauthRouter.get('/accounts', (_req: Request, res: Response) => {
  const rows = getDb().prepare('SELECT * FROM oauth_accounts ORDER BY created_at DESC, id DESC').all() as any[];
  res.json({ accounts: rows.map(rowToAccount) });
});

oauthRouter.post('/connect/:provider/start', async (req: Request, res: Response) => {
  const provider = providerById(String(req.params.provider));
  if (!provider) {
    res.status(404).json({ error: { message: 'Browser OAuth provider not found' } });
    return;
  }
  if (provider.loginMode === 'device-oauth') {
    const operation = boundedRequestOperation(req, res);
    try {
      const result = await startFreebuffDeviceOAuth(provider, operation.signal);
      if (!operation.signal.aborted) res.json(result);
    } catch (error: any) {
      if (!operation.signal.aborted) res.status(502).json({ error: { message: safeUpstreamFailure(error, 'OAuth login could not be started.') } });
    } finally {
      operation.cleanup();
    }
    return;
  }
  if (!provider.clientId) {
    res.status(409).json({ error: { message: `${provider.name} does not have a verified public browser OAuth client yet. LLMHarbor will not generate broken unauthorized_client URLs.` } });
    return;
  }
  if (provider.kind === 'google' && !antigravityOAuthSecret(provider)) {
    res.status(409).json({ error: { message: 'Antigravity OAuth client secret was not found. Set LLMHARBOR_ANTIGRAVITY_OAUTH_CLIENT_SECRET.' } });
    return;
  }
  if (process.env.NODE_ENV !== 'test' && provider.id === 'openai') {
    try { await ensureChatgptCallbackServer(); }
    catch {
      res.status(409).json({ error: { message: 'Port 1455 is already in use. OpenAI browser OAuth needs localhost:1455/auth/callback, matching the public native client registration.' } });
      return;
    }
  }
  if (process.env.NODE_ENV !== 'test' && provider.id === 'antigravity') {
    try { await ensureAntigravityCallbackServer(provider); }
    catch {
      res.status(409).json({ error: { message: `Port ${antigravityCallbackPort()} is already in use. Antigravity browser OAuth needs localhost:51121/oauth-callback.` } });
      return;
    }
  }
  const state = crypto.randomUUID?.() ?? crypto.randomBytes(16).toString('hex');
  const verifier = base64Url(crypto.randomBytes(48));
  const redirectUri = callbackUri(req, provider.id);
  cleanupOAuthLoginStates();
  getDb().prepare(`
    INSERT INTO oauth_login_states (state, provider, code_verifier, redirect_uri, expires_at)
    VALUES (?, ?, ?, ?, datetime('now', '+10 minutes'))
  `).run(state, provider.id, verifier, redirectUri);

  const authUrl = new URL(provider.authorizationUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', provider.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', provider.scopes.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', sha256(verifier));
  authUrl.searchParams.set('code_challenge_method', 'S256');
  if (provider.kind === 'google') {
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
  }
  if (provider.id === 'openai') {
    authUrl.searchParams.set('id_token_add_organizations', 'true');
    authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
    authUrl.searchParams.set('originator', 'opencode');
  }

  res.json({ authUrl: authUrl.toString(), state, expiresInSeconds: 600, callbackUrl: redirectUri, loginMode: 'browser-oauth' });
});

oauthRouter.post('/connect/:provider/complete', async (req: Request, res: Response) => {
  const provider = providerById(String(req.params.provider));
  const state = typeof req.body?.state === 'string' ? req.body.state : '';
  if (!provider || provider.loginMode !== 'device-oauth') {
    res.status(404).json({ error: { message: 'Device OAuth provider not found' } });
    return;
  }
  if (!state) {
    res.status(400).json({ error: { message: 'Device OAuth state is required' } });
    return;
  }
  const operation = boundedRequestOperation(req, res);
  try {
    const result = await completeFreebuffDeviceOAuth(provider, state, operation.signal);
    if (!operation.signal.aborted) res.json(result);
  } catch (error: any) {
    if (!operation.signal.aborted) res.status(502).json({ error: { message: safeUpstreamFailure(error, 'OAuth login could not be completed.') } });
  } finally {
    operation.cleanup();
  }
});

/**
 * Complete a native-client loopback OAuth flow from a remote dashboard.
 * The browser may fail to reach localhost on the LLMHarbor host, so the user
 * can submit that exact failed callback URL. State is still claimed once and
 * the stored PKCE verifier is still required by finishBrowserOAuth.
 */
oauthRouter.post('/connect/:provider/callback', async (req: Request, res: Response) => {
  const provider = providerById(String(req.params.provider));
  if (!provider || provider.loginMode !== 'browser-oauth') {
    res.status(404).json({
      error: {
        message: 'Browser OAuth provider not found.',
        type: 'invalid_request_error',
        code: 'oauth_provider_not_found',
      },
    });
    return;
  }

  const parsed = manualBrowserCallbackSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: 'Provide the full callbackUrl, or provide both code and state.',
        type: 'invalid_request_error',
        code: 'invalid_oauth_callback',
      },
    });
    return;
  }

  let callback: BrowserCallbackFields;
  try {
    callback = 'callbackUrl' in parsed.data
      ? browserCallbackFieldsFromUrl(req, provider, parsed.data.callbackUrl)
      : parsed.data;
  } catch (error) {
    res.status(400).json({
      error: {
        message: String((error as Error)?.message ?? 'The callback URL is invalid.'),
        type: 'invalid_request_error',
        code: 'invalid_oauth_callback',
      },
    });
    return;
  }

  const operation = boundedRequestOperation(req, res);
  try {
    await finishBrowserOAuth(provider, callback.state, callback.code, operation.signal);
    if (!operation.signal.aborted) res.json({ connected: true });
  } catch (error) {
    if (!operation.signal.aborted) {
      const stateRejected = /OAuth login state expired/i.test(String((error as Error)?.message ?? error));
      res.status(stateRejected ? 400 : 502).json({
        error: {
          message: stateRejected
            ? 'OAuth login state expired or was already used. Start login again.'
            : safeUpstreamFailure(error, 'OAuth login could not be completed.'),
          type: stateRejected ? 'invalid_request_error' : 'upstream_error',
          code: stateRejected ? 'invalid_oauth_state' : 'oauth_exchange_failed',
        },
      });
    }
  } finally {
    operation.cleanup();
  }
});

oauthRouter.get('/callback/:provider', async (req: Request, res: Response) => {
  const provider = providerById(String(req.params.provider));
  const parsed = callbackSchema.safeParse(req.query);
  if (!provider || !parsed.success) {
    res.status(400).send('OAuth callback is invalid. Return to LLMHarbor and start login again.');
    return;
  }
  if (parsed.data.error) {
    res.status(400).type('html').send(`${escapeHtml(provider.name)} login failed: ${escapeHtml(parsed.data.error_description ?? parsed.data.error)}`);
    return;
  }
  if (!parsed.data.code) {
    res.status(400).type('html').send(`${escapeHtml(provider.name)} did not return an authorization code.`);
    return;
  }
  const operation = boundedRequestOperation(req, res);
  try {
    await finishBrowserOAuth(provider, parsed.data.state, parsed.data.code, operation.signal);
  } catch (error: any) {
    const message = String(error?.message ?? error);
    const status = /OAuth login state expired/i.test(message) ? 400 : 502;
    res.status(status).type('html').send(escapeHtml(message));
    operation.cleanup();
    return;
  }
  operation.cleanup();
  res.redirect('/oauth?connected=1');
});

oauthRouter.patch('/accounts/:id', (req: Request, res: Response) => {
  const id = parsePositiveResourceId(req.params.id);
  const parsed = updateAccountSchema.safeParse(req.body ?? {});
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid account ID' } });
    return;
  }
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const db = getDb();
  const row = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM oauth_accounts WHERE id = ?').get(id) as any;
    if (!existing) return null;
    if (parsed.data.label !== undefined) db.prepare('UPDATE oauth_accounts SET label = ? WHERE id = ?').run(parsed.data.label.trim(), id);
    if (parsed.data.enabled !== undefined) db.prepare('UPDATE oauth_accounts SET enabled = ? WHERE id = ?').run(parsed.data.enabled ? 1 : 0, id);
    syncProviderKeyForOAuthAccount(id);
    return db.prepare('SELECT * FROM oauth_accounts WHERE id = ?').get(id) as any;
  })();
  if (!row) {
    res.status(404).json({ error: { message: 'OAuth account not found' } });
    return;
  }
  res.json(rowToAccount(row));
});

oauthRouter.delete('/accounts/:id', (req: Request, res: Response) => {
  const id = parsePositiveResourceId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid account ID' } });
    return;
  }
  const db = getDb();
  const deleted = db.transaction(() => {
    const existing = db.prepare('SELECT 1 FROM oauth_accounts WHERE id = ?').get(id);
    if (!existing) return false;
    db.prepare('DELETE FROM api_keys WHERE oauth_account_id = ?').run(id);
    db.prepare('DELETE FROM oauth_accounts WHERE id = ?').run(id);
    return true;
  })();
  if (!deleted) {
    res.status(404).json({ error: { message: 'OAuth account not found' } });
    return;
  }
  res.json({ success: true });
});

oauthRouter.get('/accounts/:id/models', (req: Request, res: Response) => {
  const id = parsePositiveResourceId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid account ID' } });
    return;
  }
  const row = getDb().prepare('SELECT * FROM oauth_accounts WHERE id = ?').get(id) as any;
  if (!row) {
    res.status(404).json({ error: { message: 'OAuth account not found' } });
    return;
  }
  res.json(cachedAccountInventory(row));
});

oauthRouter.post('/accounts/:id/models/refresh', async (req: Request, res: Response) => {
  const id = parsePositiveResourceId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid account ID' } });
    return;
  }
  const row = getDb().prepare('SELECT * FROM oauth_accounts WHERE id = ? AND enabled = 1').get(id) as any;
  if (!row) {
    res.status(404).json({ error: { message: 'OAuth account not found' } });
    return;
  }
  const operation = boundedRequestOperation(req, res, 120_000);
  try {
    const discovered = await refreshOAuthAccountInventory(getDb(), id, operation.signal);
    if (operation.signal.aborted) return;
    res.json({
      models: discovered.models.map(model => ({
        id: model.id,
        object: 'model',
        displayName: model.displayName,
        ownedBy: row.provider,
        contextWindow: model.contextWindow,
        visibility: model.visibility ?? null,
      })),
      limits: discovered.limits,
      provider: row.provider,
      automatic: true,
    });
  } catch (error: any) {
    if (!operation.signal.aborted) {
      res.status(502).json({ error: { message: safeUpstreamFailure(error, 'OAuth model inventory refresh failed.') } });
    }
  } finally {
    operation.cleanup();
  }
});
