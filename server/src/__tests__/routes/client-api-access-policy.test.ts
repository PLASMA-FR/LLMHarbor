import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json, raw, headers: res.headers };
}

function authHeaders(key = getUnifiedApiKey()) {
  return { Authorization: `Bearer ${key}` };
}

async function createLocalKey(app: Express, label = 'sandbox agent') {
  const created = await request(app, 'POST', '/api/settings/api-keys', { label });
  expect(created.status).toBe(201);
  expect(created.body.key).toMatch(/^llmharbor-/);
  return created.body;
}

async function addProviderKey(app: Express, platform: string, key = `${platform}-policy-test-key`) {
  const added = await request(app, 'POST', '/api/keys', {
    platform,
    key,
    label: `${platform} policy test`,
  });
  expect(added.status).toBe(201);
}

function modelDbId(platform: string, modelId: string): number {
  const row = getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ? LIMIT 1').get(platform, modelId) as { id: number } | undefined;
  expect(row).toBeTruthy();
  return row!.id;
}

describe('client API access policies', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '2'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    for (const table of ['client_api_key_model_policies', 'client_api_key_platform_policies', 'client_api_key_route_policies', 'client_api_key_usage', 'client_api_keys', 'api_keys', 'oauth_accounts', 'requests']) {
      try { db.prepare(`DELETE FROM ${table}`).run(); } catch {}
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it('persists per-local-key route, provider endpoint, and model policy overrides', async () => {
    const key = await createLocalKey(app, 'contract sandbox');
    const geminiFlash = modelDbId('google', 'gemini-2.5-flash');

    const initial = await request(app, 'GET', `/api/settings/api-keys/${key.id}/access-policy`);
    expect(initial.status).toBe(200);
    expect(initial.body.key.id).toBe(key.id);
    expect(initial.body.routes.find((route: any) => route.id === 'v1.chat.completions').enabled).toBe(true);
    expect(initial.body.routes.find((route: any) => route.id === 'v1.models').enabled).toBe(true);
    expect(initial.body.platforms.find((platform: any) => platform.platform === 'google-oauth').name).toContain('Antigravity');
    expect(initial.body.models.find((model: any) => model.modelDbId === geminiFlash).enabled).toBe(true);

    const updated = await request(app, 'PATCH', `/api/settings/api-keys/${key.id}/access-policy`, {
      routes: [{ route: 'v1.models', enabled: false }],
      platforms: [{ platform: 'google-oauth', enabled: false }],
      models: [{ modelDbId: geminiFlash, enabled: false }],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.routes.find((route: any) => route.id === 'v1.models').enabled).toBe(false);
    expect(updated.body.platforms.find((platform: any) => platform.platform === 'google-oauth').enabled).toBe(false);
    expect(updated.body.models.find((model: any) => model.modelDbId === geminiFlash).enabled).toBe(false);

    const roundTrip = await request(app, 'GET', `/api/settings/api-keys/${key.id}/access-policy`);
    expect(roundTrip.body.routes.find((route: any) => route.id === 'v1.models').enabled).toBe(false);
    expect(roundTrip.body.platforms.find((platform: any) => platform.platform === 'google-oauth').enabled).toBe(false);
    expect(roundTrip.body.models.find((model: any) => model.modelDbId === geminiFlash).enabled).toBe(false);
  });

  it('rejects unknown provider platform policy IDs instead of storing invisible no-op rows', async () => {
    const key = await createLocalKey(app, 'policy typo guard');

    const rejected = await request(app, 'PATCH', `/api/settings/api-keys/${key.id}/access-policy`, {
      platforms: [{ platform: ' not-a-real-provider ', enabled: false }],
    });

    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toContain('Unknown provider platform');

    const rows = getDb().prepare('SELECT platform FROM client_api_key_platform_policies WHERE client_api_key_id = ?').all(key.id);
    expect(rows).toEqual([]);
  });

  it('can disable the OpenAI-compatible models endpoint for one local API key only', async () => {
    await addProviderKey(app, 'groq', 'gsk_policy_models_route');
    const locked = await createLocalKey(app, 'models route locked');
    const open = await createLocalKey(app, 'models route open');

    const patched = await request(app, 'PATCH', `/api/settings/api-keys/${locked.id}/access-policy`, {
      routes: [{ route: 'v1.models', enabled: false }],
    });
    expect(patched.status).toBe(200);

    const denied = await request(app, 'GET', '/v1/models', undefined, authHeaders(locked.key));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('local_api_route_denied');

    const allowed = await request(app, 'GET', '/v1/models', undefined, authHeaders(open.key));
    expect(allowed.status).toBe(200);
    expect(allowed.body.data[0].id).toBe('auto');
  });

  it('filters denied models from /v1/models and blocks explicit chat requests before upstream routing', async () => {
    await addProviderKey(app, 'google', 'google-policy-test');
    const local = await createLocalKey(app, 'no flash key');
    const geminiFlash = modelDbId('google', 'gemini-2.5-flash');

    const patched = await request(app, 'PATCH', `/api/settings/api-keys/${local.id}/access-policy`, {
      models: [{ modelDbId: geminiFlash, enabled: false }],
    });
    expect(patched.status).toBe(200);

    const models = await request(app, 'GET', '/v1/models', undefined, authHeaders(local.key));
    expect(models.status).toBe(200);
    expect(models.body.data.map((model: any) => model.id)).not.toContain('gemini-2.5-flash');

    let upstreamCalled = false;
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('generativelanguage.googleapis.com')) upstreamCalled = true;
      return origFetch(url, init);
    });

    const denied = await request(app, 'POST', '/v1/chat/completions', {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders(local.key));

    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('model_access_denied');
    expect(upstreamCalled).toBe(false);
  });

  it('can deny an entire provider endpoint while leaving the local key enabled', async () => {
    await addProviderKey(app, 'google', 'google-platform-policy-test');
    const local = await createLocalKey(app, 'no google endpoint');

    const patched = await request(app, 'PATCH', `/api/settings/api-keys/${local.id}/access-policy`, {
      platforms: [{ platform: 'google', enabled: false }],
    });
    expect(patched.status).toBe(200);

    const models = await request(app, 'GET', '/v1/models', undefined, authHeaders(local.key));
    expect(models.status).toBe(200);
    expect(models.body.data.map((model: any) => model.owned_by)).not.toContain('google');

    const denied = await request(app, 'POST', '/v1/chat/completions', {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders(local.key));

    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('provider_endpoint_access_denied');
  });

  it('returns a policy denial when every routeable auto candidate is blocked', async () => {
    await addProviderKey(app, 'google', 'google-auto-all-denied-policy-test');
    const local = await createLocalKey(app, 'auto all denied');

    const patched = await request(app, 'PATCH', `/api/settings/api-keys/${local.id}/access-policy`, {
      platforms: [{ platform: 'google', enabled: false }],
    });
    expect(patched.status).toBe(200);

    let upstreamCalled = false;
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('generativelanguage.googleapis.com')) upstreamCalled = true;
      return origFetch(url, init);
    });

    const denied = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders(local.key));

    expect(denied.status).toBe(403);
    expect(denied.body.error.type).toBe('forbidden');
    expect(denied.body.error.code).toBe('client_access_policy_denied');
    expect(denied.body.error.message).toContain('access policy');
    expect(upstreamCalled).toBe(false);
  });

  it('auto-routing skips provider families denied by the local key policy', async () => {
    await addProviderKey(app, 'google', 'google-auto-policy-test');
    await addProviderKey(app, 'groq', 'gsk_auto_policy_test');
    const local = await createLocalKey(app, 'auto skips google');

    const patched = await request(app, 'PATCH', `/api/settings/api-keys/${local.id}/access-policy`, {
      platforms: [{ platform: 'google', enabled: false }],
    });
    expect(patched.status).toBe(200);

    const origFetch = global.fetch;
    let googleCalled = false;
    let groqCalled = false;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('generativelanguage.googleapis.com')) {
        googleCalled = true;
        return Response.json({ error: { message: 'denied provider should not be called' } }, { status: 500 });
      }
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        groqCalled = true;
        return Response.json({
          id: 'chatcmpl-policy-skip',
          object: 'chat.completion',
          created: 123,
          model: 'openai/gpt-oss-120b',
          choices: [{ index: 0, message: { role: 'assistant', content: 'routed around denied provider' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 5, total_tokens: 7 },
        });
      }
      return origFetch(url, init);
    });

    const routed = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders(local.key));

    expect(routed.status).toBe(200);
    expect(routed.body.choices[0].message.content).toBe('routed around denied provider');
    expect(routed.headers.get('x-routed-via')).toContain('groq/');
    expect(googleCalled).toBe(false);
    expect(groqCalled).toBe(true);
  });
});
