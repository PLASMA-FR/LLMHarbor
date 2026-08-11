import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';

const realFetch = globalThis.fetch;

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await realFetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

async function createCustomEndpoint(app: Express, name: string) {
  const response = await request(app, 'POST', '/api/endpoints', {
    name,
    baseUrl: 'https://api.example.com/v1',
  });
  expect(response.status).toBe(201);
  return response.body as { platform: string };
}

describe('Endpoint command center API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE model_id IN ('llama-3.3-70b-test', 'disabled-test-model'))").run();
    db.prepare("DELETE FROM models WHERE model_id IN ('llama-3.3-70b-test', 'disabled-test-model')").run();
    db.prepare("DELETE FROM api_keys WHERE label IN ('probe key', 'count healthy', 'count disabled', 'count invalid')").run();
    db.prepare("DELETE FROM custom_endpoints WHERE name LIKE 'Endpoint API test%'").run();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists built-in endpoints alongside custom endpoints for command-center use', async () => {
    const { status, body } = await request(app, 'GET', '/api/endpoints');

    expect(status).toBe(200);
    expect(body.some((endpoint: any) => endpoint.platform === 'groq' && endpoint.custom === false)).toBe(true);
    expect(body.some((endpoint: any) => endpoint.platform === 'openrouter' && endpoint.baseUrl)).toBe(true);
  });

  it('reports configured, enabled, and available credential counts without exposing secrets', async () => {
    await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'gsk-count-healthy', label: 'count healthy' });
    await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'gsk-count-disabled', label: 'count disabled' });
    await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'gsk-count-invalid', label: 'count invalid' });
    const db = getDb();
    db.prepare("UPDATE api_keys SET status = 'healthy' WHERE label = 'count healthy'").run();
    db.prepare("UPDATE api_keys SET enabled = 0 WHERE label = 'count disabled'").run();
    db.prepare("UPDATE api_keys SET status = 'invalid' WHERE label = 'count invalid'").run();

    const { status, body } = await request(app, 'GET', '/api/endpoints');

    expect(status).toBe(200);
    const groq = body.find((endpoint: any) => endpoint.platform === 'groq');
    expect(groq).toMatchObject({
      keyCount: 3,
      configuredKeyCount: 3,
      enabledKeyCount: 2,
      availableKeyCount: 1,
    });
    expect(JSON.stringify(groq)).not.toContain('gsk-count');
    expect(groq).not.toHaveProperty('encryptedKey');
  });

  it('adds a model to an existing built-in endpoint and enrolls it in fallback routing', async () => {
    const { status, body } = await request(app, 'POST', '/api/endpoints/groq/models', {
      modelId: 'llama-3.3-70b-test',
      displayName: 'Llama test route',
      intelligenceRank: 31,
      speedRank: 2,
      sizeLabel: 'Test',
      contextWindow: 131072,
    });

    expect(status).toBe(201);
    expect(body.platform).toBe('groq');
    expect(body.modelId).toBe('llama-3.3-70b-test');

    const fallback = await request(app, 'GET', '/api/fallback');
    expect(fallback.body).toContainEqual(expect.objectContaining({
      modelDbId: body.id,
      platform: 'groq',
      enabled: false,
      skipReason: 'Disabled in fallback configuration',
    }));
  });

  it('returns a structured conflict instead of throwing for a duplicate model', async () => {
    const model = {
      modelId: 'llama-3.3-70b-test',
      displayName: 'Llama test route',
    };
    expect((await request(app, 'POST', '/api/endpoints/groq/models', model)).status).toBe(201);

    const duplicate = await request(app, 'POST', '/api/endpoints/groq/models', model);

    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({
      error: {
        message: "Model 'llama-3.3-70b-test' is already registered for endpoint 'groq'.",
        type: 'conflict',
        code: 'model_already_exists',
        param: 'modelId',
      },
    });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM models WHERE platform = 'groq' AND model_id = 'llama-3.3-70b-test'").get()).toEqual({ count: 1 });
  });

  it('keeps disabled custom endpoints and their models manageable while refusing probes explicitly', async () => {
    const endpoint = await createCustomEndpoint(app, 'Endpoint API test disabled');
    expect((await request(app, 'PATCH', `/api/endpoints/${endpoint.platform}`, { enabled: false })).status).toBe(200);

    const createdModel = await request(app, 'POST', `/api/endpoints/${endpoint.platform}/models`, {
      modelId: 'disabled-test-model',
      displayName: 'Disabled endpoint test model',
    });
    expect(createdModel.status).toBe(201);

    const listedEndpoints = await request(app, 'GET', '/api/endpoints');
    expect(listedEndpoints.body).toContainEqual(expect.objectContaining({
      platform: endpoint.platform,
      enabled: false,
      modelCount: 1,
    }));
    const listedModels = await request(app, 'GET', `/api/endpoints/${endpoint.platform}/models`);
    expect(listedModels.status).toBe(200);
    expect(listedModels.body).toContainEqual(expect.objectContaining({ modelId: 'disabled-test-model' }));

    const probe = await request(app, 'POST', `/api/endpoints/${endpoint.platform}/models/probe`, {
      modelId: 'disabled-test-model',
    });
    expect(probe.status).toBe(409);
    expect(probe.body).toMatchObject({
      ok: false,
      modelId: 'disabled-test-model',
      error: { type: 'conflict', code: 'endpoint_disabled' },
    });

    const deletedModel = await request(app, 'DELETE', `/api/endpoints/${endpoint.platform}/models/${createdModel.body.id}`);
    expect(deletedModel.status).toBe(200);
  });

  it('rejects empty endpoint patches', async () => {
    const endpoint = await createCustomEndpoint(app, 'Endpoint API test patch');

    const response = await request(app, 'PATCH', `/api/endpoints/${endpoint.platform}`, {});

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('at least one endpoint field');
  });

  it.each(['01', '+1', '1junk', '9007199254740992'])('rejects non-canonical model resource id %s', async invalidId => {
    const created = await request(app, 'POST', '/api/endpoints/groq/models', {
      modelId: 'llama-3.3-70b-test',
      displayName: 'Llama test route',
    });
    expect(created.status).toBe(201);

    const response = await request(app, 'DELETE', `/api/endpoints/groq/models/${invalidId}`);

    expect(response.status).toBe(400);
    expect(getDb().prepare('SELECT 1 FROM models WHERE id = ?').get(created.body.id)).toBeTruthy();
  });

  it('probes whether a model works with an existing endpoint key', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk-test',
      label: 'probe key',
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1,
      model: 'llama-3.3-70b-test',
      choices: [{ index: 0, message: { role: 'assistant', content: 'harbor-ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const { status, body } = await request(app, 'POST', '/api/endpoints/groq/models/probe', {
      modelId: 'llama-3.3-70b-test',
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.modelId).toBe('llama-3.3-70b-test');
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.sample).toContain('harbor-ok');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  it('cancels the upstream model probe when the dashboard client disconnects', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk-test',
      label: 'probe key',
    });

    let upstreamSignal: AbortSignal | null = null;
    let markUpstreamStarted!: () => void;
    const upstreamStarted = new Promise<void>(resolve => { markUpstreamStarted = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      upstreamSignal = init?.signal ?? null;
      markUpstreamStarted();
      return await new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener('abort', () => reject(upstreamSignal?.reason), { once: true });
      });
    });

    const server = app.listen(0);
    const addr = server.address() as any;
    const controller = new AbortController();
    const inboundRequest = realFetch(`http://127.0.0.1:${addr.port}/api/endpoints/groq/models/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: 'llama-3.3-70b-test' }),
      signal: controller.signal,
    }).catch(() => null);

    await upstreamStarted;
    controller.abort();
    await inboundRequest;
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
});
