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

describe('Keys API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare("DELETE FROM custom_endpoints WHERE platform = 'custom-disabled-test'").run();
  });

  it('GET /api/keys returns empty array initially', async () => {
    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('POST /api/keys creates a new key', async () => {
    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
      label: 'My Groq Key',
    });

    expect(status).toBe(201);
    expect(body.platform).toBe('groq');
    expect(body.label).toBe('My Groq Key');
    expect(body.maskedKey).toContain('...');
  });

  it('GET /api/keys returns the created key', async () => {
    // First create a key
    const created = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });
    getDb().prepare(`
      INSERT INTO requests (request_id, attempt, is_final, platform, model_id, key_id, status)
      VALUES ('keys-last-success', 1, 1, 'groq', 'test-model', ?, 'success')
    `).run(created.body.id);

    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].platform).toBe('groq');
    expect(body[0].lastSuccessAt).toMatch(/T.*Z$/);
  });

  it('POST /api/keys rejects invalid platform', async () => {
    const { status } = await request(app, 'POST', '/api/keys', {
      platform: 'invalid_platform',
      key: 'test',
    });
    expect(status).toBe(400);
  });

  it('POST /api/keys rejects missing key', async () => {
    const { status } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
    });
    expect(status).toBe(400);
  });

  it('does not accept OAuth-only providers as pasted or bulk API-key targets', async () => {
    const providers = await request(app, 'GET', '/api/keys/providers');
    expect(providers.body.some((provider: any) => provider.platform === 'google-oauth')).toBe(false);
    expect(providers.body.some((provider: any) => provider.platform === 'freebuff')).toBe(false);

    const pasted = await request(app, 'POST', '/api/keys', {
      platform: 'google-oauth',
      key: 'must-not-be-stored-as-an-api-key',
    });
    expect(pasted.status).toBe(400);
    expect(pasted.body.error.code).toBe('oauth_credentials_required');
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM api_keys WHERE platform = 'google-oauth'").get()).toEqual({ count: 0 });
  });

  it('keeps credentials for a disabled custom endpoint manageable', async () => {
    getDb().prepare(`
      INSERT INTO custom_endpoints (platform, name, base_url, enabled)
      VALUES ('custom-disabled-test', 'Disabled test endpoint', 'https://example.com/v1', 0)
    `).run();

    const providers = await request(app, 'GET', '/api/keys/providers');
    const target = providers.body.find((provider: any) => provider.platform === 'custom-disabled-test');
    expect(target).toBeTruthy();

    const created = await request(app, 'POST', '/api/keys', {
      platform: 'custom-disabled-test',
      key: 'disabled-endpoint-secret',
    });
    expect(created.status).toBe(201);

    const toggled = await request(app, 'PATCH', '/api/keys/platform/custom-disabled-test', { enabled: false });
    expect(toggled.status).toBe(200);
    expect(toggled.body.updatedKeys).toBe(1);
  });

  it('bounds provider labels and secrets before storing them', async () => {
    const oversizedLabel = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'valid-key',
      label: 'l'.repeat(81),
    });
    expect(oversizedLabel.status).toBe(400);

    const oversizedSecret = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'k'.repeat(16_385),
    });
    expect(oversizedSecret.status).toBe(400);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM api_keys').get()).toEqual({ count: 0 });
  });

  it('DELETE /api/keys/:id removes a key', async () => {
    const { body: created } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status } = await request(app, 'DELETE', `/api/keys/${created.id}`);
    expect(status).toBe(200);

    const { body: after } = await request(app, 'GET', '/api/keys');
    expect(after).toHaveLength(0);
  });

  it('DELETE /api/keys/:id returns 404 for nonexistent key', async () => {
    const { status } = await request(app, 'DELETE', '/api/keys/99999');
    expect(status).toBe(404);
  });

  it('POST /api/keys/import adds one provider key per non-empty line using provider list id', async () => {
    const imported = await request(app, 'POST', '/api/keys/import', {
      providerId: 1,
      contents: 'google-key-one\n\n google-key-two \n# comment\ngoogle-key-one\n',
      labelPrefix: 'Studio batch',
    });

    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({
      platform: 'google',
      providerId: 1,
      attempted: 3,
      imported: 2,
      skipped: 1,
    });
    expect(imported.body.keys).toHaveLength(2);
    expect(imported.body.keys[0].label).toBe('Studio batch 1');
    expect(imported.body.keys[0].maskedKey).not.toContain('google-key-one');

    const listed = await request(app, 'GET', '/api/keys');
    expect(listed.body.filter((key: any) => key.platform === 'google')).toHaveLength(2);
  });

  it('POST /api/keys/import resolves the stable platform instead of an ephemeral list position', async () => {
    const imported = await request(app, 'POST', '/api/keys/import', {
      platform: 'groq',
      contents: 'gsk-stable-target',
    });

    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({ platform: 'groq', imported: 1 });
    const stored = getDb().prepare('SELECT platform FROM api_keys').get() as { platform: string };
    expect(stored.platform).toBe('groq');
  });

  it('POST /api/keys/import rejects unknown provider list ids', async () => {
    const { status, body } = await request(app, 'POST', '/api/keys/import', {
      providerId: 999,
      contents: 'key-one',
    });

    expect(status).toBe(400);
    expect(body.error.message).toContain("Unknown provider '999'");
  });

  it('rejects oversized bulk-import secrets atomically', async () => {
    const imported = await request(app, 'POST', '/api/keys/import', {
      providerId: 1,
      contents: `valid-key\n${'k'.repeat(16_385)}`,
    });

    expect(imported.status).toBe(400);
    expect(imported.body.error.message).toContain('at most 16384 characters');
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM api_keys').get()).toEqual({ count: 0 });
  });

  it('bounds bulk-import row count before writing any credentials', async () => {
    const imported = await request(app, 'POST', '/api/keys/import', {
      providerId: 1,
      contents: Array.from({ length: 5_001 }, (_, index) => `key-${index}`).join('\n'),
    });

    expect(imported.status).toBe(400);
    expect(imported.body.error.code).toBe('bulk_import_too_many_keys');
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM api_keys').get()).toEqual({ count: 0 });
  });
});
