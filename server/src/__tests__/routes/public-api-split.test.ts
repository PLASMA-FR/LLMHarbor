import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createPublicApiApp } from '../../app.js';
import { initDb } from '../../db/index.js';

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

describe('Split public API listener', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createPublicApiApp();
  });

  it('exposes only public liveness and OpenAI-compatible proxy routes', async () => {
    const ping = await request(app, 'GET', '/api/ping');
    expect(ping.status).toBe(200);
    expect(ping.body.status).toBe('ok');

    const models = await request(app, 'GET', '/v1/models');
    expect(models.status).toBe(401);
    expect(models.body.error.type).toBe('authentication_error');
  });

  it('does not expose dashboard static pages or control-plane API routes', async () => {
    const root = await request(app, 'GET', '/');
    expect(root.status).toBe(404);
    expect(root.headers.get('content-type')).toContain('application/json');
    expect(root.body.error.message).toContain('public API listener');

    const keys = await request(app, 'GET', '/api/keys');
    expect(keys.status).toBe(404);
    expect(keys.body.error.type).toBe('not_found');
  });
});
