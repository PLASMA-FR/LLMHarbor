import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closeDb, initDb } from '../../db/index.js';

const ENV_NAMES = [
  'LLMHARBOR_DASHBOARD_HOST', 'DASHBOARD_HOST', 'HOST',
  'LLMHARBOR_DASHBOARD_PORT', 'DASHBOARD_PORT', 'PORT',
  'LLMHARBOR_PUBLIC_API_HOST', 'PUBLIC_API_HOST', 'API_HOST',
  'LLMHARBOR_PUBLIC_API_PORT', 'PUBLIC_API_PORT', 'API_PORT',
] as const;
const originalEnv = new Map(ENV_NAMES.map(name => [name, process.env[name]]));

async function getConnection(app: Express) {
  const server = app.listen(0);
  try {
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/settings/connection`);
    return { status: response.status, body: await response.json() as any };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('GET /api/settings/connection', () => {
  let app: Express;

  beforeEach(() => {
    for (const name of ENV_NAMES) delete process.env[name];
    process.env.ENCRYPTION_KEY = '6'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  afterEach(() => {
    closeDb();
    for (const name of ENV_NAMES) {
      const value = originalEnv.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('reports single-listener defaults', async () => {
    const response = await getConnection(app);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      splitMode: false,
      dashboard: { host: '127.0.0.1', port: 3001 },
      publicApi: { host: '127.0.0.1', port: 3001, basePath: '/v1' },
    });
  });

  it('uses LLMHARBOR-prefixed split settings and preserves wildcard hosts for the UI to resolve', async () => {
    process.env.HOST = 'legacy-host';
    process.env.PORT = '3999';
    process.env.API_HOST = 'legacy-api-host';
    process.env.API_PORT = '4000';
    process.env.LLMHARBOR_DASHBOARD_HOST = '100.64.0.10';
    process.env.LLMHARBOR_DASHBOARD_PORT = '3002';
    process.env.LLMHARBOR_PUBLIC_API_HOST = '0.0.0.0';
    process.env.LLMHARBOR_PUBLIC_API_PORT = '3001';

    const response = await getConnection(app);
    expect(response.body).toEqual({
      splitMode: true,
      dashboard: { host: '100.64.0.10', port: 3002 },
      publicApi: { host: '0.0.0.0', port: 3001, basePath: '/v1' },
    });
  });
});
