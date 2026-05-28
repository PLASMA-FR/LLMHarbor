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

describe('Endpoint command center API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE model_id = 'llama-3.3-70b-test')").run();
    db.prepare("DELETE FROM models WHERE model_id = 'llama-3.3-70b-test'").run();
    db.prepare('DELETE FROM api_keys WHERE label = ?').run('probe key');
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
    expect(fallback.body.some((entry: any) => entry.modelDbId === body.id && entry.platform === 'groq')).toBe(true);
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
});
