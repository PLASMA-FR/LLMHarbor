import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, isValidClientApiKey } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

describe('Proxy authentication and CORS', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('requires the unified API key for loopback chat completions', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('creates multiple personal client API keys and authenticates any enabled key', async () => {
    const created = await request(app, 'POST', '/api/settings/api-keys', { label: 'CI agent' });
    expect(created.status).toBe(201);
    expect(created.body.label).toBe('CI agent');
    expect(created.body.key).toMatch(/^llmharbor-/);

    const listed = await request(app, 'GET', '/api/settings/api-keys');
    expect(listed.status).toBe(200);
    expect(listed.body.length).toBeGreaterThanOrEqual(2);

    const compare = (provided: string, expected: string) => provided === expected;
    expect(isValidClientApiKey(created.body.key, compare)).toBe(true);

    const disabled = await request(app, 'PATCH', `/api/settings/api-keys/${created.body.id}`, { enabled: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.enabled).toBe(false);
    expect(isValidClientApiKey(created.body.key, compare)).toBe(false);
  });

  it('does not grant CORS access to arbitrary browser origins', async () => {
    const { status, headers } = await request(app, 'GET', '/api/ping', undefined, {
      Origin: 'https://attacker.example',
    });

    expect(status).toBe(200);
    expect(headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows the local dashboard origin through CORS', async () => {
    const { status, headers } = await request(app, 'GET', '/api/ping', undefined, {
      Origin: 'http://localhost:5173',
    });

    expect(status).toBe(200);
    expect(headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });
});
