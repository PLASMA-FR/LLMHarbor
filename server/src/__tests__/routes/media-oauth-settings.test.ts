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
  });
  const contentType = res.headers.get('content-type') ?? '';
  const raw = contentType.includes('application/octet-stream') || contentType.includes('audio/')
    ? Buffer.from(await res.arrayBuffer())
    : await res.text();
  server.close();
  let json: any = null;
  if (typeof raw === 'string') {
    try { json = JSON.parse(raw); } catch {}
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
    process.env.LLMHARBOR_ANTIGRAVITY_OAUTH_CLIENT_SECRET = 'test-antigravity-client-secret';
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    for (const table of ['oauth_login_states', 'oauth_accounts', 'local_endpoint_keys', 'local_endpoint_domains', 'local_endpoint_provider_scopes', 'local_endpoints']) {
      try { db.prepare(`DELETE FROM ${table}`).run(); } catch {}
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it('proxies OpenAI-compatible image generations through a configured provider key', async () => {
    await addOpenAIKey(app);
    const origFetch = global.fetch;
    let providerBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://api.openai.com/v1/images/generations') {
        providerBody = JSON.parse((init as any).body);
        expect((init as any).headers.Authorization).toBe('Bearer sk-media-test');
        return Response.json({
          created: 123,
          data: [{ b64_json: Buffer.from('fake-png').toString('base64'), revised_prompt: 'anchor logo' }],
        });
      }
      return origFetch(url, init);
    });

    const res = await request(app, 'POST', '/v1/images/generations', {
      model: 'gpt-image-1',
      prompt: 'anchor shaped harbor logo',
      size: '1024x1024',
      response_format: 'b64_json',
    }, authHeaders());

    expect(res.status).toBe(200);
    expect(providerBody.model).toBe('gpt-image-1');
    expect(providerBody.prompt).toContain('anchor');
    expect(res.body.data[0].b64_json).toBeTruthy();
    expect(res.headers.get('x-routed-via')).toBe('openai/gpt-image-1');
  });

  it('proxies OpenAI-compatible audio speech as binary audio', async () => {
    await addOpenAIKey(app);
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://api.openai.com/v1/audio/speech') {
        const body = JSON.parse((init as any).body);
        expect(body.model).toBe('tts-1');
        expect(body.voice).toBe('alloy');
        return new Response(Buffer.from('fake-mp3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
      }
      return origFetch(url, init);
    });

    const res = await request(app, 'POST', '/v1/audio/speech', {
      model: 'tts-1',
      input: 'LLMHarbor audio smoke test',
      voice: 'alloy',
      response_format: 'mp3',
    }, authHeaders());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/mpeg');
    expect((res.raw as Buffer).toString()).toBe('fake-mp3');
    expect(res.headers.get('x-routed-via')).toBe('openai/tts-1');
  });

  it('starts browser OAuth directly, exchanges callback codes, and stores encrypted account tokens', async () => {
    const catalog = await request(app, 'GET', '/api/oauth/providers');
    expect(catalog.status).toBe(200);
    expect(catalog.body.providers.map((p: any) => p.id)).toEqual(['openai', 'antigravity']);
    expect(JSON.stringify(catalog.body)).not.toContain('google-ai-studio');
    expect(JSON.stringify(catalog.body)).not.toContain('Gemini CLI');
    expect(JSON.stringify(catalog.body)).not.toContain('oauth.llmharbor.app');
    expect(JSON.stringify(catalog.body)).not.toContain('opencode auth login');

    const openai = catalog.body.providers.find((p: any) => p.id === 'openai');
    const antigravity = catalog.body.providers.find((p: any) => p.id === 'antigravity');
    expect(openai.canConnect).toBe(true);
    expect(openai.loginMode).toBe('browser-oauth');
    expect(openai.authorizationUrl).toBe('https://auth.openai.com/oauth/authorize');
    expect(antigravity.canConnect).toBe(true);
    expect(antigravity.loginMode).toBe('browser-oauth');
    expect(antigravity.authorizationUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');

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
    expect(callback.status).toBe(200);

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

  it('creates domains, scoped local endpoints, and dedicated local endpoint keys', async () => {
    const endpoint = await request(app, 'POST', '/api/settings/local-endpoints', {
      name: 'OpenAI only harbor',
      slug: 'openai-only',
      providerScopes: ['openai'],
      domains: ['openai.localhost'],
    });
    expect(endpoint.status).toBe(201);
    expect(endpoint.body.slug).toBe('openai-only');
    expect(endpoint.body.providerScopes).toEqual(['openai']);
    expect(endpoint.body.domains).toEqual(['openai.localhost']);

    const key = await request(app, 'POST', `/api/settings/local-endpoints/${endpoint.body.id}/keys`, {
      label: 'OpenAI app key',
      limits: { rpm: 5, rpd: null, tpm: 1000, tpd: null },
    });
    expect(key.status).toBe(201);
    expect(key.body.key).toMatch(/^llmharbor-/);
    expect(key.body.localEndpointId).toBe(endpoint.body.id);
    expect(key.body.limits).toEqual({ rpm: 5, rpd: null, tpm: 1000, tpd: null });

    const list = await request(app, 'GET', '/api/settings/local-endpoints');
    expect(list.status).toBe(200);
    expect(list.body.endpoints[0].keys[0].maskedKey).toBeTruthy();
    expect(list.body.endpoints[0].keys[0].limits.rpm).toBe(5);
  });
});
