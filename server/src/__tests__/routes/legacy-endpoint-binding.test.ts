import type { Express } from 'express';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { createNamedClientApiKey, getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

async function getModels(app: Express, path: string, secret: string) {
  const server = app.listen(0);
  try {
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    return { status: response.status, body: await response.json() as any };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('legacy /e/:slug client-key binding', () => {
  let app: Express;
  let unscopedSecret: string;
  let defaultSecret: string;
  let alphaSecret: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '9'.repeat(64);
    initDb(':memory:');
    const db = getDb();
    db.prepare("INSERT INTO local_endpoints (id, name, slug, enabled) VALUES (10, 'Alpha', 'alpha', 1)").run();
    db.prepare("INSERT INTO local_endpoints (id, name, slug, enabled) VALUES (11, 'Beta', 'beta', 1)").run();
    db.prepare("INSERT INTO local_endpoint_provider_scopes (local_endpoint_id, platform) VALUES (10, 'groq')").run();
    const credential = encrypt('gsk-endpoint-binding');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'binding test', ?, ?, ?, 'healthy', 1)
    `).run(credential.encrypted, credential.iv, credential.authTag);
    unscopedSecret = createNamedClientApiKey('Unscoped', null).key!;
    defaultSecret = createNamedClientApiKey('Default scoped', 1).key!;
    alphaSecret = createNamedClientApiKey('Alpha scoped', 10).key!;
    app = createApp();
  });

  it('allows modern/default keys only on /v1 and rejects invented compatibility paths', async () => {
    expect((await getModels(app, '/v1/models', unscopedSecret)).status).toBe(200);
    expect((await getModels(app, '/v1/models', defaultSecret)).status).toBe(200);
    for (const secret of [unscopedSecret, defaultSecret]) {
      const invented = await getModels(app, '/e/invented/v1/models', secret);
      expect(invented.status).toBe(403);
      expect(invented.body.error.code).toBe('local_endpoint_binding_denied');
    }
  });

  it('requires a non-default scoped key to use its exact enabled slug', async () => {
    expect((await getModels(app, '/v1/models', alphaSecret)).status).toBe(403);
    expect((await getModels(app, '/e/beta/v1/models', alphaSecret)).status).toBe(403);
    expect((await getModels(app, '/e/invented/v1/models', alphaSecret)).status).toBe(403);
    const exact = await getModels(app, '/e/alpha/v1/models', alphaSecret);
    expect(exact.status).toBe(200);
    expect(exact.body.data.some((model: any) => model.id === 'auto')).toBe(true);
    expect(exact.body.data.filter((model: any) => model.id !== 'auto').every((model: any) => model.owned_by === 'groq')).toBe(true);

    getDb().prepare('UPDATE local_endpoints SET enabled = 0 WHERE id = 10').run();
    expect((await getModels(app, '/e/alpha/v1/models', alphaSecret)).status).toBe(403);
  });
});
