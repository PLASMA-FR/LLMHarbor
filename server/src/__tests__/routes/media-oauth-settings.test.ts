import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

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

  it('starts browser OAuth directly, exchanges callback codes, and stores encrypted account tokens', async () => {
    const catalog = await request(app, 'GET', '/api/oauth/providers');
    expect(catalog.status).toBe(200);
    expect(catalog.body.providers.map((p: any) => p.id)).toEqual(['openai', 'antigravity']);
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
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://auth.openai.com/oauth/token') {
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

    const callback = await request(app, 'GET', `/api/oauth/callback/openai?state=${state}&code=browser-code`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/oauth?connected=1');

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
