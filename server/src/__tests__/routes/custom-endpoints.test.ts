import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Custom endpoints API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform LIKE 'custom-%')").run();
    db.prepare("DELETE FROM models WHERE platform LIKE 'custom-%'").run();
    db.prepare("DELETE FROM api_keys WHERE platform LIKE 'custom-%'").run();
    db.prepare("DELETE FROM custom_endpoints WHERE platform LIKE 'custom-%'").run();
  });

  it('creates a custom OpenAI-compatible endpoint', async () => {
    const { status, body } = await request(app, 'POST', '/api/endpoints', {
      name: 'Local vLLM',
      baseUrl: 'http://127.0.0.1:8000/v1/',
      timeoutMs: 90000,
    });

    expect(status).toBe(201);
    expect(body.platform).toBe('custom-local-vllm');
    expect(body.baseUrl).toBe('http://127.0.0.1:8000/v1');
    expect(body.enabled).toBe(true);
  });

  it('adds models to custom endpoints and enrolls them in fallback routing', async () => {
    const { body: endpoint } = await request(app, 'POST', '/api/endpoints', {
      name: 'Local vLLM',
      baseUrl: 'http://127.0.0.1:8000/v1',
    });

    const { status, body } = await request(app, 'POST', `/api/endpoints/${endpoint.platform}/models`, {
      modelId: 'Qwen/Qwen3-Coder-30B-A3B-Instruct',
      displayName: 'Qwen3 Coder local',
      intelligenceRank: 12,
      speedRank: 3,
      sizeLabel: 'Local',
      contextWindow: 131072,
    });

    expect(status).toBe(201);
    expect(body.platform).toBe(endpoint.platform);
    expect(body.modelId).toBe('Qwen/Qwen3-Coder-30B-A3B-Instruct');

    const fallback = await request(app, 'GET', '/api/fallback');
    expect(fallback.body.some((entry: any) => entry.modelDbId === body.id && entry.platform === endpoint.platform)).toBe(true);
  });

  it('allows keys for custom endpoints after the endpoint exists', async () => {
    const { body: endpoint } = await request(app, 'POST', '/api/endpoints', {
      name: 'OpenAI compatible lab',
      baseUrl: 'http://localhost:11434/v1',
    });

    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: endpoint.platform,
      key: 'local-dev-key',
      label: 'dev',
    });

    expect(status).toBe(201);
    expect(body.platform).toBe(endpoint.platform);
  });
});
