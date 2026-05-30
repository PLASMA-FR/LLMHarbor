import crypto from 'crypto';
import { createServer, type Server as HttpServer } from 'http';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { refreshOAuthAccountInventory } from '../services/oauth-discovery.js';
import { ANTIGRAVITY_OAUTH_CLIENT_ID, ANTIGRAVITY_OAUTH_TOKEN_URL, OPENAI_OAUTH_CLIENT_ID, OPENAI_OAUTH_TOKEN_URL, oauthTokenClient } from '../services/oauth-clients.js';

export const oauthRouter = Router();

type BrowserOAuthProvider = {
  id: string;
  name: string;
  kind: string;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
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
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: ANTIGRAVITY_OAUTH_TOKEN_URL,
    clientId: ANTIGRAVITY_OAUTH_CLIENT_ID,
    modelsUrl: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    scopes: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile', 'https://www.googleapis.com/auth/cclog', 'https://www.googleapis.com/auth/experimentsandconfigs'],
    supportsDiscovery: true,
    notes: 'Antigravity-native Google OAuth using the public native client from antigravity-claude-proxy: localhost:51121/oauth-callback, Code Assist scopes, live model discovery only, encrypted local storage.',
  },
];

const callbackSchema = z.object({
  state: z.string().min(16),
  code: z.string().min(1).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const updateAccountSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
}).refine(body => body.label !== undefined || body.enabled !== undefined, {
  message: 'Provide label or enabled',
});

let openaiCallbackServer: HttpServer | null = null;
const googleCallbackServers = new Map<string, HttpServer>();

function runtimePlatformFor(providerId: string) {
  if (providerId === 'openai') return 'openai';
  if (providerId === 'antigravity') return 'google-oauth';
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

async function finishBrowserOAuth(provider: BrowserOAuthProvider, state: string, code: string) {
  const stateRow = getDb().prepare(`
    SELECT * FROM oauth_login_states
    WHERE state = ? AND provider = ? AND consumed_at IS NULL AND expires_at > datetime('now')
  `).get(state, provider.id) as any;
  if (!stateRow) throw new Error('OAuth login state expired. Return to LLMHarbor and start login again.');
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: provider.clientId,
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
  const upstream = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!upstream.ok) throw new Error(`${provider.name} token exchange failed with HTTP ${upstream.status}. ${(await upstream.text()).slice(0, 300)}`);
  const tokenData = await upstream.json() as any;
  if (!tokenData.access_token) throw new Error(`${provider.name} token response did not contain an access token.`);
  const access = encrypt(String(tokenData.access_token));
  const refresh = tokenData.refresh_token ? encrypt(String(tokenData.refresh_token)) : null;
  const expiresAt = typeof tokenData.expires_in === 'number' ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : null;
  const accountHint = tokenData.email ?? tokenData.account_hint ?? `${provider.name} account`;
  let accountId = 0;
  getDb().transaction(() => {
    const result = getDb().prepare(`
      INSERT INTO oauth_accounts (provider, label, account_hint, encrypted_access_token, access_iv, access_auth_tag, encrypted_refresh_token, refresh_iv, refresh_auth_tag, expires_at, metadata_json, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(provider.id, `${provider.name} - ${accountHint}`, accountHint, access.encrypted, access.iv, access.authTag, refresh?.encrypted ?? null, refresh?.iv ?? null, refresh?.authTag ?? null, expiresAt, JSON.stringify({ tokenType: tokenData.token_type ?? 'Bearer', connectedVia: 'browser-oauth', runtimePlatform: runtimePlatformFor(provider.id) }));
    accountId = Number(result.lastInsertRowid);
    syncProviderKeyForOAuthAccount(accountId, String(tokenData.access_token));
    getDb().prepare("UPDATE oauth_login_states SET consumed_at = datetime('now') WHERE state = ?").run(state);
  })();
  try { await refreshOAuthAccountInventory(getDb(), accountId); } catch {}
}

function ensureChatgptCallbackServer() {
  if (openaiCallbackServer?.listening) return Promise.resolve();
  const provider = providerById('openai');
  if (!provider) throw new Error('OpenAI provider is not registered');
  openaiCallbackServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost:1455');
    if (url.pathname !== '/auth/callback') {
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
      await finishBrowserOAuth(provider, state, code);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>LLMHarbor connected</title><body style="font-family:system-ui;background:#0f1115;color:#f4f1ea;display:grid;place-items:center;min-height:100vh"><main><h1>Account connected</h1><p>You can close this window and return to LLMHarbor.</p><script>setTimeout(()=>window.close(),1800)</script></main></body>');
    } catch (error: any) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><title>LLMHarbor OAuth failed</title><body style="font-family:system-ui"><h1>Connection failed</h1><p>${escapeHtml(error?.message ?? error)}</p></body>`);
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

function ensureAntigravityCallbackServer(provider: BrowserOAuthProvider) {
  const existing = googleCallbackServers.get(provider.id);
  if (existing?.listening) return Promise.resolve();
  const port = antigravityCallbackPort();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== '/oauth-callback') {
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
      await finishBrowserOAuth(provider, state, code);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>LLMHarbor connected</title><body style="font-family:system-ui;background:#0f1115;color:#f4f1ea;display:grid;place-items:center;min-height:100vh"><main><h1>Antigravity account connected</h1><p>You can close this window and return to LLMHarbor.</p><script>setTimeout(()=>window.close(),1800)</script></main></body>');
    } catch (error: any) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><title>LLMHarbor OAuth failed</title><body style="font-family:system-ui"><h1>Connection failed</h1><p>${escapeHtml(error?.message ?? error)}</p></body>`);
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
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    scopes: provider.scopes,
    supportsDiscovery: provider.supportsDiscovery,
    loginMode: 'browser-oauth' as const,
    authorizationUrl: provider.authorizationUrl,
    callbackPath: `/api/oauth/callback/${provider.id}`,
    configured: Boolean(provider.clientId) && (provider.kind !== 'google' || Boolean(antigravityOAuthSecret(provider))),
    canConnect: Boolean(provider.clientId) && (provider.kind !== 'google' || Boolean(antigravityOAuthSecret(provider))),
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
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    lastDiscoveredAt: row.last_discovered_at,
    metadata,
    limits: Array.isArray(metadata.oauthLimits) ? metadata.oauthLimits : [],
    modelCount: typeof metadata.oauthModelCount === 'number' ? metadata.oauthModelCount : null,
    createdAt: row.created_at,
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

oauthRouter.get('/callback/:provider', async (req: Request, res: Response) => {
  const provider = providerById(String(req.params.provider));
  const parsed = callbackSchema.safeParse(req.query);
  if (!provider || !parsed.success) {
    res.status(400).send('OAuth callback is invalid. Return to LLMHarbor and start login again.');
    return;
  }
  if (parsed.data.error) {
    res.status(400).send(`${provider.name} login failed: ${parsed.data.error_description ?? parsed.data.error}`);
    return;
  }
  if (!parsed.data.code) {
    res.status(400).send(`${provider.name} did not return an authorization code.`);
    return;
  }
  try {
    await finishBrowserOAuth(provider, parsed.data.state, parsed.data.code);
  } catch (error: any) {
    res.status(502).send(String(error?.message ?? error));
    return;
  }
  res.redirect('/oauth?connected=1');
});

oauthRouter.patch('/accounts/:id', (req: Request, res: Response) => {
  const id = Number.parseInt(String(req.params.id), 10);
  const parsed = updateAccountSchema.safeParse(req.body ?? {});
  if (Number.isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid account ID' } });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const existing = getDb().prepare('SELECT * FROM oauth_accounts WHERE id = ?').get(id) as any;
  if (!existing) {
    res.status(404).json({ error: { message: 'OAuth account not found' } });
    return;
  }
  if (parsed.data.label !== undefined) getDb().prepare('UPDATE oauth_accounts SET label = ? WHERE id = ?').run(parsed.data.label.trim(), id);
  if (parsed.data.enabled !== undefined) getDb().prepare('UPDATE oauth_accounts SET enabled = ? WHERE id = ?').run(parsed.data.enabled ? 1 : 0, id);
  syncProviderKeyForOAuthAccount(id);
  const row = getDb().prepare('SELECT * FROM oauth_accounts WHERE id = ?').get(id) as any;
  res.json(rowToAccount(row));
});

oauthRouter.delete('/accounts/:id', (req: Request, res: Response) => {
  const id = Number.parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid account ID' } });
    return;
  }
  getDb().prepare('DELETE FROM api_keys WHERE oauth_account_id = ?').run(id);
  const result = getDb().prepare('DELETE FROM oauth_accounts WHERE id = ?').run(id);
  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'OAuth account not found' } });
    return;
  }
  res.json({ success: true });
});

oauthRouter.get('/accounts/:id/models', async (req: Request, res: Response) => {
  const id = Number.parseInt(String(req.params.id), 10);
  const row = getDb().prepare('SELECT * FROM oauth_accounts WHERE id = ? AND enabled = 1').get(id) as any;
  if (Number.isNaN(id) || !row) {
    res.status(404).json({ error: { message: 'OAuth account not found' } });
    return;
  }
  try {
    const discovered = await refreshOAuthAccountInventory(getDb(), id);
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
    res.status(502).json({ error: { message: String(error?.message ?? error) } });
  }
});
