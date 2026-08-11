import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: path.startsWith('/api/oauth/callback/') ? 'manual' : 'follow',
  });
  const contentType = res.headers.get('content-type') ?? '';
  const raw = contentType.includes('application/octet-stream') || contentType.includes('audio/')
    ? Buffer.from(await res.arrayBuffer())
    : await res.text();
  server.close();
  let json: any = null;
  if (typeof raw === 'string') {
    try { json = JSON.parse(raw); } catch { /* empty */ }
  }
  return { status: res.status, body: json, raw, headers: res.headers };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

async function addOpenAIKey(app: Express) {
  const addKey = await request(app, 'POST', '/api/keys', {
    platform: 'openai',
    key: 'sk-media-test',
    label: 'media-test',
  });
  expect(addKey.status).toBe(201);
}

describe('media, OAuth, and local endpoint control-plane support', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '1'.repeat(64);
    delete process.env.LLMHARBOR_ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    for (const table of ['oauth_login_states', 'oauth_accounts', 'local_endpoint_keys', 'local_endpoint_domains', 'local_endpoint_provider_scopes', 'local_endpoints']) {
      try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* empty */ }
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it('does not expose the removed image generation proxy route', async () => {
    let upstreamCalled = false;
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://api.openai.com/v1/images/generations') upstreamCalled = true;
      return origFetch(url, init);
    });

    const res = await request(app, 'POST', '/v1/images/generations', {
      model: 'gpt-image-1',
      prompt: 'anchor shaped harbor logo',
    }, authHeaders());

    expect(res.status).toBe(404);
    expect(upstreamCalled).toBe(false);
  });

  it('does not expose the removed audio speech proxy route', async () => {
    let upstreamCalled = false;
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://api.openai.com/v1/audio/speech') upstreamCalled = true;
      return origFetch(url, init);
    });

    const res = await request(app, 'POST', '/v1/audio/speech', {
      model: 'tts-1',
      input: 'LLMHarbor audio smoke test',
      voice: 'alloy',
    }, authHeaders());

    expect(res.status).toBe(404);
    expect(upstreamCalled).toBe(false);
  });

  it('keeps OAuth inventory GET read-only and reserves network discovery for POST refresh', async () => {
    const token = encrypt('cached-inventory-token');
    const account = getDb().prepare(`
      INSERT INTO oauth_accounts (
        provider, label, encrypted_access_token, access_iv, access_auth_tag,
        metadata_json, enabled
      ) VALUES ('freebuff', 'Cached inventory', ?, ?, ?, ?, 1)
    `).run(token.encrypted, token.iv, token.authTag, JSON.stringify({
      oauthLimits: [{ label: 'Cached quota', usedPercent: null }],
    }));
    getDb().prepare(`
      INSERT INTO oauth_account_models (oauth_account_id, platform, model_id, supported)
      VALUES (?, 'freebuff', 'moonshotai/kimi-k2.6', 1)
    `).run(Number(account.lastInsertRowid));
    let upstreamCalled = false;
    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).startsWith('https://')) upstreamCalled = true;
      return originalFetch(url, init);
    });

    const cached = await request(app, 'GET', `/api/oauth/accounts/${account.lastInsertRowid}/models`);
    expect(cached.status).toBe(200);
    expect(cached.body.models).toContainEqual(expect.objectContaining({ id: 'moonshotai/kimi-k2.6' }));
    expect(cached.body.limits).toEqual([{ label: 'Cached quota', usedPercent: null }]);
    expect(upstreamCalled).toBe(false);
  });

  it('starts browser OAuth directly, exchanges callback codes, and stores encrypted account tokens', async () => {
    const catalog = await request(app, 'GET', '/api/oauth/providers');
    expect(catalog.status).toBe(200);
    expect(catalog.body.providers.map((p: any) => p.id)).toEqual(['openai', 'antigravity', 'freebuff']);
    expect(JSON.stringify(catalog.body)).not.toContain('google-ai-studio');
    expect(JSON.stringify(catalog.body)).not.toContain('Gemini CLI');
    expect(JSON.stringify(catalog.body)).not.toContain('oauth.llmharbor.app');
    expect(JSON.stringify(catalog.body)).not.toContain('opencode auth login');
    expect(JSON.stringify(catalog.body)).not.toContain('GOCSPX');

    const openai = catalog.body.providers.find((p: any) => p.id === 'openai');
    const antigravity = catalog.body.providers.find((p: any) => p.id === 'antigravity');

    const removedQwen = await request(app, 'POST', '/api/oauth/connect/qwen/start');
    expect(removedQwen.status).toBe(404);

    const start = await request(app, 'POST', '/api/oauth/connect/openai/start');
    expect(start.status).toBe(200);
    expect(start.body.authUrl).toContain('https://auth.openai.com/oauth/authorize');
    expect(start.body.authUrl).toContain('code_challenge=');
    expect(start.body.authUrl).toContain('redirect_uri=');
    expect(start.body.authUrl).not.toContain('oauth.llmharbor.app');
    expect(start.body.callbackUrl).toBe('http://localhost:1455/auth/callback');
    expect(start.body.authUrl).toContain('client_id=app_EMoamEEZ73f0CkXaXp7hrann');
    expect(start.body.authUrl).toContain('codex_cli_simplified_flow=true');

    const removedGoogleStudio = await request(app, 'POST', '/api/oauth/connect/google-ai-studio/start');
    expect(removedGoogleStudio.status).toBe(404);

    const antigravityStart = await request(app, 'POST', '/api/oauth/connect/antigravity/start');
    expect(antigravityStart.status).toBe(200);
    expect(antigravityStart.body.callbackUrl).toBe('http://localhost:51121/oauth-callback');
    expect(antigravityStart.body.authUrl).toContain('client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com');
    expect(antigravityStart.body.authUrl).toContain(encodeURIComponent('https://www.googleapis.com/auth/experimentsandconfigs'));
    expect(antigravityStart.body.authUrl).toContain('prompt=consent');

    const callbackError = await request(app, 'GET', '/api/oauth/callback/openai?state=1234567890abcdef&error=access_denied&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(callbackError.status).toBe(400);
    expect(callbackError.raw).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(callbackError.raw).not.toContain('<script>alert(1)</script>');

    const state = new URL(start.body.authUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    const origFetch = global.fetch;
    let tokenExchangeCalls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://auth.openai.com/oauth/token') {
        tokenExchangeCalls++;
        const body = new URLSearchParams(String((init as any).body));
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('code')).toBe('browser-code');
        expect(body.get('code_verifier')).toBeTruthy();
        return Response.json({ access_token: 'oauth-access-token', refresh_token: 'oauth-refresh-token', expires_in: 3600, token_type: 'Bearer', email: 'captain@example.com' });
      }
      if (urlStr === 'https://chatgpt.com/backend-api/codex/models?client_version=999.0.0') {
        expect((init as any).headers.Authorization).toBe('Bearer oauth-access-token');
        return Response.json({ models: [
          { slug: 'gpt-5.5', display_name: 'GPT-5.5', supported_in_api: true, visibility: 'list', priority: 1, context_window: 272000 },
          { slug: 'gpt-5', display_name: 'GPT-5', supported_in_api: false, visibility: 'hide', priority: 2, context_window: 272000 },
          { slug: 'gpt-5-codex', display_name: 'GPT-5 Codex', supported_in_api: false, visibility: 'hide', priority: 3, context_window: 272000 },
          { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', supported_in_api: true, visibility: 'list', priority: 4, context_window: 272000 },
        ] });
      }
      if (urlStr === 'https://chatgpt.com/backend-api/codex/usage') {
        expect((init as any).headers.Authorization).toBe('Bearer oauth-access-token');
        return Response.json({ rate_limit: { primary_window: { used_percent: 12, reset_after_seconds: 600 } } });
      }
      return origFetch(url, init);
    });

    const callbacks = await Promise.all([
      request(app, 'GET', `/api/oauth/callback/openai?state=${state}&code=browser-code`),
      request(app, 'GET', `/api/oauth/callback/openai?state=${state}&code=browser-code`),
    ]);
    const callback = callbacks.find(result => result.status === 302)!;
    const replay = callbacks.find(result => result.status === 400)!;
    expect(callback.headers.get('location')).toBe('/oauth?connected=1');
    expect(replay.raw).toContain('OAuth login state expired');
    expect(tokenExchangeCalls).toBe(1);

    const accounts = await request(app, 'GET', '/api/oauth/accounts');
    expect(accounts.status).toBe(200);
    expect(accounts.body.accounts).toHaveLength(1);
    expect(accounts.body.accounts[0].provider).toBe('openai');
    expect(accounts.body.accounts[0].accessToken).toBeUndefined();
    expect(accounts.body.accounts[0].maskedToken).not.toBe('oauth-access-token');

    const providerKeys = await request(app, 'GET', '/api/keys');
    expect(providerKeys.status).toBe(200);
    expect(providerKeys.body).toHaveLength(1);
    expect(providerKeys.body[0]).toMatchObject({ platform: 'openai', source: 'oauth', oauthAccountId: accounts.body.accounts[0].id, status: 'healthy', enabled: true });
    expect(providerKeys.body[0].label).toContain('OpenAI / ChatGPT subscription');

    const modelList = await request(app, 'GET', '/api/models');
    expect(modelList.status).toBe(200);
    const openaiModels = modelList.body.filter((m: any) => m.platform === 'openai' && m.displayName.includes('browser account'));
    expect(openaiModels.map((m: any) => m.modelId).sort()).toEqual(['gpt-5', 'gpt-5.4-mini', 'gpt-5.5']);
    expect(openaiModels.every((m: any) => m.keyCount >= 1)).toBe(true);
    expect(modelList.body.some((m: any) => m.modelId === 'gpt-5-codex')).toBe(false);

    const accountsWithLimits = await request(app, 'GET', '/api/oauth/accounts');
    expect(accountsWithLimits.body.accounts[0].limits[0].usedPercent).toBe(12);

    const models = await request(app, 'GET', `/api/oauth/accounts/${accounts.body.accounts[0].id}/models`);
    expect(models.status).toBe(200);
    expect(models.body.models.map((m: any) => m.id).sort()).toEqual(['gpt-5', 'gpt-5.4-mini', 'gpt-5.5']);
    expect(models.body.limits[0].usedPercent).toBe(12);
  });

  it('completes remote loopback callbacks without weakening state or PKCE validation', async () => {
    const start = await request(app, 'POST', '/api/oauth/connect/openai/start');
    expect(start.status).toBe(200);
    const state = new URL(start.body.authUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    const originalFetch = global.fetch;
    const exchangedCodes: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlString = String(url);
      if (urlString === 'https://auth.openai.com/oauth/token') {
        const body = new URLSearchParams(String(init?.body));
        exchangedCodes.push(String(body.get('code')));
        expect(body.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
        expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,}$/);
        return Response.json({
          access_token: `access-${body.get('code')}`,
          refresh_token: `refresh-${body.get('code')}`,
          expires_in: 3600,
          token_type: 'Bearer',
          email: 'remote@example.com',
        });
      }
      if (urlString === 'https://chatgpt.com/backend-api/codex/models?client_version=999.0.0') {
        return Response.json({ models: [] });
      }
      if (urlString === 'https://chatgpt.com/backend-api/codex/usage') {
        return Response.json({});
      }
      return originalFetch(url, init);
    });

    const foreignCallback = await request(app, 'POST', '/api/oauth/connect/openai/callback', {
      callbackUrl: `https://example.invalid/callback?code=stolen&state=${encodeURIComponent(state)}`,
    });
    expect(foreignCallback.status).toBe(400);
    expect(foreignCallback.body.error.code).toBe('invalid_oauth_callback');
    expect(exchangedCodes).toEqual([]);
    const pendingState = getDb().prepare('SELECT consumed_at FROM oauth_login_states WHERE state = ?').get(state) as { consumed_at: string | null };
    expect(pendingState.consumed_at).toBeNull();

    const callbackUrl = new URL(start.body.callbackUrl);
    callbackUrl.searchParams.set('code', 'remote-browser-code');
    callbackUrl.searchParams.set('state', state);
    const simultaneous = await Promise.all([
      request(app, 'POST', '/api/oauth/connect/openai/callback', { callbackUrl: callbackUrl.toString() }),
      request(app, 'POST', '/api/oauth/connect/openai/callback', { callbackUrl: callbackUrl.toString() }),
    ]);
    expect(simultaneous.map(result => result.status).sort()).toEqual([200, 400]);
    const connected = simultaneous.find(result => result.status === 200)!;
    const replay = simultaneous.find(result => result.status === 400)!;
    expect(connected.body).toEqual({ connected: true });
    expect(connected.raw).not.toContain('access-remote-browser-code');
    expect(connected.raw).not.toContain('refresh-remote-browser-code');
    expect(replay.body.error.code).toBe('invalid_oauth_state');
    expect(exchangedCodes).toEqual(['remote-browser-code']);

    const directStart = await request(app, 'POST', '/api/oauth/connect/openai/start');
    const directState = new URL(directStart.body.authUrl).searchParams.get('state');
    const direct = await request(app, 'POST', '/api/oauth/connect/openai/callback', {
      state: directState,
      code: 'remote-direct-code',
    });
    expect(direct.status).toBe(200);
    expect(direct.body).toEqual({ connected: true });
    expect(exchangedCodes).toEqual(['remote-browser-code', 'remote-direct-code']);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM oauth_accounts').get()).toEqual({ count: 2 });
  });

  it('connects Freebuff with device OAuth and projects it as an encrypted provider key', async () => {
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    let statusCalls = 0;
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://freebuff.com/api/auth/cli/code') {
        expect(JSON.parse(String((init as any).body)).fingerprintId).toMatch(/^llmharbor-/);
        return Response.json({ loginUrl: 'https://freebuff.com/login?code=BUFFY7', fingerprintHash: 'hash-123', expiresAt });
      }
      if (urlStr.startsWith('https://freebuff.com/api/auth/cli/status')) {
        statusCalls += 1;
        const params = new URL(urlStr).searchParams;
        expect(params.get('fingerprintHash')).toBe('hash-123');
        if (statusCalls === 1) return new Response('', { status: 401 });
        return Response.json({ user: { authToken: 'freebuff-auth-token', email: 'buffy@example.com', name: 'Buffy' } });
      }
      return origFetch(url, init);
    });

    const start = await request(app, 'POST', '/api/oauth/connect/freebuff/start');
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ loginMode: 'device-oauth', userCode: 'BUFFY7', verificationUri: 'https://freebuff.com' });

    const pending = await request(app, 'POST', '/api/oauth/connect/freebuff/complete', { state: start.body.state });
    expect(pending.status).toBe(200);
    expect(pending.body.pending).toBe(true);

    const completed = await request(app, 'POST', '/api/oauth/connect/freebuff/complete', { state: start.body.state });
    expect(completed.status).toBe(200);
    expect(completed.body.account.provider).toBe('freebuff');
    expect(completed.body.account.maskedToken).not.toBe('freebuff-auth-token');

    const keys = await request(app, 'GET', '/api/keys');
    expect(keys.body[0]).toMatchObject({ platform: 'freebuff', source: 'oauth', oauthAccountId: completed.body.account.id, status: 'healthy', enabled: true });

    const inventory = await request(app, 'GET', `/api/oauth/accounts/${completed.body.account.id}/models`);
    expect(inventory.status).toBe(200);
    expect(inventory.body.models.map((m: any) => m.id)).toContain('moonshotai/kimi-k2.6');
    expect(inventory.body.provider).toBe('freebuff');
  });

  it('exchanges Antigravity callback codes with the bundled desktop client when env secret is unset', async () => {
    delete process.env.LLMHARBOR_ANTIGRAVITY_OAUTH_CLIENT_SECRET;

    const start = await request(app, 'POST', '/api/oauth/connect/antigravity/start');
    expect(start.status).toBe(200);
    const state = new URL(start.body.authUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://oauth2.googleapis.com/token') {
        const body = new URLSearchParams(String((init as any).body));
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('code')).toBe('antigravity-code');
        expect(body.get('client_id')).toBe('1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com');
        expect(body.get('redirect_uri')).toBe('http://localhost:51121/oauth-callback');
        expect(body.get('code_verifier')).toBeTruthy();
        expect(body.get('client_secret')).toMatch(/^GOCSPX-/);
        return Response.json({ access_token: 'antigravity-access-token', refresh_token: 'antigravity-refresh-token', expires_in: 3600, token_type: 'Bearer', email: 'captain@example.com' });
      }
      if (urlStr.endsWith('/v1internal:loadCodeAssist')) {
        expect((init as any).headers.Authorization).toBe('Bearer antigravity-access-token');
        return Response.json({ cloudaicompanionProject: 'project-from-load', currentTier: { name: 'Free' } });
      }
      if (urlStr.endsWith('/v1internal:fetchAvailableModels')) {
        expect((init as any).headers.Authorization).toBe('Bearer antigravity-access-token');
        return Response.json({ models: { 'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro', contextWindow: 1048576 } } });
      }
      return origFetch(url, init);
    });

    const callback = await request(app, 'GET', `/api/oauth/callback/antigravity?state=${state}&code=antigravity-code`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/oauth?connected=1');

    const accounts = await request(app, 'GET', '/api/oauth/accounts');
    expect(accounts.status).toBe(200);
    expect(accounts.body.accounts).toHaveLength(1);
    expect(accounts.body.accounts[0].provider).toBe('antigravity');

    const providerKeys = await request(app, 'GET', '/api/keys');
    expect(providerKeys.status).toBe(200);
    expect(providerKeys.body[0]).toMatchObject({ platform: 'google-oauth', source: 'oauth', oauthAccountId: accounts.body.accounts[0].id, status: 'healthy', enabled: true });

    const modelList = await request(app, 'GET', '/api/models');
    expect(modelList.status).toBe(200);
    const antigravityModels = modelList.body.filter((m: any) => m.platform === 'google-oauth' && m.displayName.includes('browser account'));
    expect(antigravityModels.map((m: any) => m.modelId)).toEqual(['gemini-2.5-pro']);
  });
  it('keeps local endpoint creation read-only while client API keys carry advanced access policy', async () => {
    const list = await request(app, 'GET', '/api/settings/local-endpoints');
    expect(list.status).toBe(200);
    expect(list.body.endpoints[0]).toMatchObject({ slug: 'default', basePath: '/v1' });

    const endpoint = await request(app, 'POST', '/api/settings/local-endpoints', {
      name: 'OpenAI only harbor',
      slug: 'openai-only',
      providerScopes: ['openai'],
      domains: ['openai.localhost'],
    });
    expect(endpoint.status).toBe(410);
    expect(endpoint.body.error.code).toBe('local_endpoint_creation_removed');

    const key = await request(app, 'POST', '/api/settings/api-keys', {
      label: 'OpenAI app key',
      limits: { rpm: 5, rpd: null, tpm: 1000, tpd: null },
    });
    expect(key.status).toBe(201);
    expect(key.body.key).toMatch(/^llmharbor-/);
    expect(key.body.limits).toEqual({ rpm: 5, rpd: null, tpm: 1000, tpd: null });
  });
});
