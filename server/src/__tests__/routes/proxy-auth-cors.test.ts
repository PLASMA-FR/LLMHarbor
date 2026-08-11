import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { request as httpRequest } from 'node:http';
import { createApp, createPublicApiApp } from '../../app.js';
import { initDb, isValidClientApiKey } from '../../db/index.js';

type RequestHeaders = Record<string, string> | ((requestOrigin: string) => Record<string, string>);

async function request(app: Express, method: string, path: string, body?: any, headers: RequestHeaders = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const resolvedHeaders = typeof headers === 'function'
    ? headers(new URL(url).origin)
    : headers;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...resolvedHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

async function requestWithAuthority(app: Express, method: string, path: string, authority: string, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const result = await new Promise<{ status: number; body: any; raw: string }>((resolve, reject) => {
    const outbound = httpRequest({
      hostname: '127.0.0.1',
      port: addr.port,
      method,
      path,
      headers: { Host: authority, ...headers },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: any = null;
        try { body = JSON.parse(raw); } catch {}
        resolve({ status: response.statusCode ?? 0, body, raw });
      });
    });
    outbound.on('error', reject);
    outbound.end();
  });
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return result;
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

  it('never re-reveals a stored primary client key', async () => {
    const result = await request(app, 'GET', '/api/settings/api-key');
    expect(result.status).toBe(410);
    expect(result.body.error.code).toBe('client_key_not_revealable');
    expect(result.raw).not.toMatch(/llmharbor-[a-f0-9]{48}/);
  });

  it('creates multiple personal client API keys and authenticates any enabled key', async () => {
    const created = await request(app, 'POST', '/api/settings/api-keys', {
      label: 'CI agent',
      limits: { rpm: 3, rpd: 20, tpm: null, tpd: 5000 },
    });
    expect(created.status).toBe(201);
    expect(created.body.label).toBe('CI agent');
    expect(created.body.key).toMatch(/^llmharbor-/);
    expect(created.body.limits).toEqual({ rpm: 3, rpd: 20, tpm: null, tpd: 5000 });

    const listed = await request(app, 'GET', '/api/settings/api-keys');
    expect(listed.status).toBe(200);
    expect(listed.body.length).toBeGreaterThanOrEqual(2);
    expect(listed.body.every((key: any) => key.key === undefined)).toBe(true);

    const compare = (provided: string, expected: string) => provided === expected;
    expect(isValidClientApiKey(created.body.key, compare)).toBe(true);

    const limited = await request(app, 'PATCH', `/api/settings/api-keys/${created.body.id}`, {
      limits: { rpm: 1, rpd: null, tpm: 42, tpd: null },
    });
    expect(limited.status).toBe(200);
    expect(limited.body.limits).toEqual({ rpm: 1, rpd: null, tpm: 42, tpd: null });

    const invalidLimit = await request(app, 'POST', '/api/settings/api-keys', {
      label: 'bad limit',
      limits: { rpm: 0 },
    });
    expect(invalidLimit.status).toBe(400);

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

  it('rejects a simple cross-origin dashboard mutation before it reaches the route', async () => {
    const result = await request(app, 'POST', '/api/settings/api-key/regenerate', undefined, {
      Origin: 'https://attacker.example',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Sec-Fetch-Site': 'cross-site',
    });

    expect(result.status).toBe(403);
    expect(result.body.error).toMatchObject({
      type: 'forbidden',
      code: 'dashboard_origin_denied',
    });
    expect(result.body.error.request_id).toBe(result.headers.get('x-request-id'));
  });

  it('rejects browser-identified cross-site mutations when Origin is absent', async () => {
    const result = await request(app, 'POST', '/api/settings/api-key/regenerate', undefined, {
      'Sec-Fetch-Site': 'cross-site',
    });

    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('dashboard_origin_denied');
  });

  it('preserves non-browser CLI requests without Origin or Fetch Metadata', async () => {
    const result = await request(app, 'POST', '/api/settings/api-key/regenerate');

    expect(result.status).toBe(200);
    expect(result.body.apiKey).toMatch(/^llmharbor-/);
  });

  it('allows unsafe requests from the configured dashboard listener origin', async () => {
    const previousHost = process.env.LLMHARBOR_DASHBOARD_HOST;
    const previousPort = process.env.LLMHARBOR_DASHBOARD_PORT;
    process.env.LLMHARBOR_DASHBOARD_HOST = '100.64.0.10';
    process.env.LLMHARBOR_DASHBOARD_PORT = '3002';
    const configuredListenerApp = createApp({ controlPlaneAccess: 'trusted-network' });
    if (previousHost === undefined) delete process.env.LLMHARBOR_DASHBOARD_HOST;
    else process.env.LLMHARBOR_DASHBOARD_HOST = previousHost;
    if (previousPort === undefined) delete process.env.LLMHARBOR_DASHBOARD_PORT;
    else process.env.LLMHARBOR_DASHBOARD_PORT = previousPort;

    const result = await request(configuredListenerApp, 'POST', '/api/settings/api-key/regenerate', undefined, {
      Origin: 'http://100.64.0.10:3002',
      Host: '100.64.0.10:3002',
      'Sec-Fetch-Site': 'same-origin',
    });

    expect(result.status).toBe(200);
    expect(result.body.apiKey).toMatch(/^llmharbor-/);
  });

  it('allows built-in development and explicitly configured dashboard origins', async () => {
    const dev = await request(app, 'POST', '/api/settings/api-key/regenerate', undefined, {
      Origin: 'http://localhost:5173',
    });
    expect(dev.status).toBe(200);

    const previousOrigins = process.env.DASHBOARD_ORIGINS;
    process.env.DASHBOARD_ORIGINS = 'https://dashboard.example.internal/';
    const configuredApp = createApp();
    if (previousOrigins === undefined) delete process.env.DASHBOARD_ORIGINS;
    else process.env.DASHBOARD_ORIGINS = previousOrigins;

    const configured = await request(configuredApp, 'POST', '/api/settings/api-key/regenerate', undefined, {
      Origin: 'https://dashboard.example.internal',
      'Sec-Fetch-Site': 'cross-site',
    });
    expect(configured.status).toBe(200);
  });

  it('allows an explicitly configured HTTPS reverse-proxy origin', async () => {
    const previousOrigins = process.env.DASHBOARD_ORIGINS;
    process.env.DASHBOARD_ORIGINS = 'https://dashboard.example.internal';
    const proxyApp = createApp();
    if (previousOrigins === undefined) delete process.env.DASHBOARD_ORIGINS;
    else process.env.DASHBOARD_ORIGINS = previousOrigins;

    const result = await request(proxyApp, 'POST', '/api/settings/api-key/regenerate', undefined, {
      Origin: 'https://dashboard.example.internal',
      Host: 'dashboard.example.internal',
      'X-Forwarded-Host': 'dashboard.example.internal',
      'X-Forwarded-Proto': 'https',
      'Sec-Fetch-Site': 'same-origin',
    });

    expect(result.status).toBe(200);
    expect(result.body.apiKey).toMatch(/^llmharbor-/);
  });

  it('rejects a DNS-rebinding Host and Origin even over a loopback socket', async () => {
    const result = await requestWithAuthority(app, 'POST', '/api/settings/api-key/regenerate', 'evil.example:3001', {
      Origin: 'http://evil.example:3001',
      'Sec-Fetch-Site': 'same-origin',
    });

    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('dashboard_authority_denied');
  });

  it('rejects DNS-rebinding reads before returning control-plane data', async () => {
    const result = await requestWithAuthority(app, 'GET', '/api/settings/api-keys', 'evil.example:3001', {
      Origin: 'http://evil.example:3001',
      'Sec-Fetch-Site': 'same-origin',
    });

    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('dashboard_authority_denied');
    expect(JSON.stringify(result.body)).not.toContain('maskedKey');
  });

  it('leaves safe control-plane reads and public OpenAI routes unchanged', async () => {
    const read = await request(app, 'GET', '/api/settings/api-keys', undefined, {
      Origin: 'https://attacker.example',
      'Sec-Fetch-Site': 'cross-site',
    });
    expect(read.status).toBe(200);
    expect(read.headers.get('access-control-allow-origin')).toBeNull();

    const publicApi = createPublicApiApp();
    const proxy = await request(publicApi, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, {
      Origin: 'https://attacker.example',
      'Sec-Fetch-Site': 'cross-site',
    });
    expect(proxy.status).toBe(401);
    expect(proxy.body.error.type).toBe('authentication_error');
  });

  it('serves a restrictive same-origin content security policy', async () => {
    const { status, headers } = await request(app, 'GET', '/api/ping');
    const policy = headers.get('content-security-policy');

    expect(status).toBe(200);
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain('upgrade-insecure-requests');
  });

  it('returns structured JSON for unknown dashboard-listener API routes', async () => {
    for (const path of ['/api/missing', '/v1/missing', '/e/missing/v1/missing']) {
      const result = await request(app, 'GET', path);

      expect(result.status).toBe(404);
      expect(result.headers.get('content-type')).toContain('application/json');
      expect(result.body.error).toMatchObject({
        message: 'Not found.',
        type: 'not_found',
        request_id: result.headers.get('x-request-id'),
      });
    }
  });
});
