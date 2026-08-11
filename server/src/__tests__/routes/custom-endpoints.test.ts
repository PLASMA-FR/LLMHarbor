import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { assertCustomEndpointDestinationSafe, fetchPinnedCustomEndpoint, normalizeCustomEndpointUrl } from '../../lib/urlSecurity.js';

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

  it.each([
    'ftp://models.example/v1',
    'http://user:password@models.example/v1',
    'https://models.example/v1?token=secret',
    'https://models.example/v1#fragment',
    'http://169.254.169.254/latest/meta-data',
    'http://169.254.1.10/v1',
    'http://metadata.google.internal/computeMetadata/v1',
    'http://[fe80::1]/v1',
    'http://[::ffff:169.254.169.254]/v1',
    'http://[::ffff:100.100.100.200]/v1',
    'http://[::ffff:192.0.0.192]/v1',
  ])('rejects unsafe custom endpoint URL %s', async baseUrl => {
    const result = await request(app, 'POST', '/api/endpoints', { name: 'Unsafe endpoint', baseUrl });
    expect(result.status).toBe(400);
    expect(result.body.error.message).toMatch(/protocol|credentials|query|fragment|metadata|link-local/i);
  });

  it.each([
    'http://127.0.0.1:8000/v1',
    'http://localhost:11434/v1',
    'http://10.20.30.40:8080/v1',
    'http://172.20.0.4:8080/v1',
    'http://192.168.1.20:8080/v1',
    'http://[::1]:8080/v1',
    'http://[fd12:3456::10]:8080/v1',
    'http://[::ffff:192.168.1.20]:8080/v1',
  ])('preserves local and private-network endpoint URL %s', async baseUrl => {
    const result = await request(app, 'POST', '/api/endpoints', { name: `Local ${baseUrl}`, baseUrl });
    expect(result.status).toBe(201);
    expect(result.body.baseUrl).toBe(normalizeCustomEndpointUrl(baseUrl));
  });

  it('rejects a hostname that resolves to metadata while allowing DNS aliases for local models', async () => {
    await expect(assertCustomEndpointDestinationSafe(
      'http://models.internal/v1',
      async () => [{ address: '169.254.169.254' }],
    )).rejects.toThrow(/blocked metadata|link-local/i);
    await expect(assertCustomEndpointDestinationSafe(
      'http://models.internal/v1',
      async () => [{ address: '192.168.10.25' }],
    )).resolves.toBeUndefined();
  });

  it('pins custom endpoint connections to the validated DNS result while preserving Host', async () => {
    let receivedHost = '';
    const server = createServer((incoming, response) => {
      receivedHost = incoming.headers.host ?? '';
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an IP listener');
    let resolutionCount = 0;
    try {
      const response = await fetchPinnedCustomEndpoint(
        `http://models.internal:${address.port}/v1/models`,
        { method: 'GET', redirect: 'error' },
        async hostname => {
          resolutionCount++;
          expect(hostname).toBe('models.internal');
          return [{ address: '127.0.0.1', family: 4 }];
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ data: [] });
      expect(resolutionCount).toBe(1);
      expect(receivedHost).toBe(`models.internal:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('handles null-body custom endpoint responses without crashing the process', async () => {
    const server = createServer((_incoming, response) => response.writeHead(204).end());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an IP listener');
    try {
      const response = await fetchPinnedCustomEndpoint(
        `http://models.internal:${address.port}/v1/models`,
        { method: 'GET', redirect: 'error' },
        async () => [{ address: '127.0.0.1', family: 4 }],
      );
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
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
