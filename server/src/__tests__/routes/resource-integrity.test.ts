import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { parsePositiveResourceId } from '../../lib/resourceId.js';

async function request(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => null);
  server.close();
  return { status: response.status, body: responseBody };
}

function seedOAuthPair(platform = 'openai') {
  const db = getDb();
  const account = db.prepare(`
    INSERT INTO oauth_accounts (
      provider, label, account_hint, encrypted_access_token, access_iv,
      access_auth_tag, metadata_json, enabled
    ) VALUES (?, 'Test account', 'test@example.com', 'ciphertext', 'iv', 'tag', '{}', 1)
  `).run(platform === 'freebuff' ? 'freebuff' : 'openai');
  const accountId = Number(account.lastInsertRowid);
  const key = db.prepare(`
    INSERT INTO api_keys (
      platform, label, encrypted_key, iv, auth_tag, status, enabled, source,
      oauth_account_id
    ) VALUES (?, 'OAuth key', 'ciphertext', 'iv', 'tag', 'healthy', 1, 'oauth', ?)
  `).run(platform, accountId);
  return { accountId, keyId: Number(key.lastInsertRowid) };
}

describe('resource id and related credential mutation integrity', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '7'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    for (const trigger of ['fail_oauth_update', 'fail_key_update', 'fail_key_delete', 'fail_oauth_delete']) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM oauth_accounts').run();
  });

  afterEach(() => {
    const db = getDb();
    for (const trigger of ['fail_oauth_update', 'fail_key_update', 'fail_key_delete', 'fail_oauth_delete']) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    vi.restoreAllMocks();
  });

  it.each([
    ['', null],
    ['0', null],
    ['-1', null],
    ['01', null],
    ['12junk', null],
    ['9007199254740992', null],
    ['1', 1],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
  ])('strictly parses resource id %j', (raw, expected) => {
    expect(parsePositiveResourceId(raw)).toBe(expected);
  });

  it.each(['0', '-1', '01', '12junk', '9007199254740992'])(
    'rejects malformed resource id %s across credential and settings routes',
    async invalidId => {
      const checks = await Promise.all([
        request(app, 'DELETE', `/api/keys/${invalidId}`),
        request(app, 'POST', `/api/health/check/${invalidId}`),
        request(app, 'GET', `/api/settings/api-keys/${invalidId}/access-policy`),
        request(app, 'PATCH', `/api/settings/local-endpoints/${invalidId}`, { enabled: false }),
        request(app, 'PATCH', `/api/oauth/accounts/${invalidId}`, { enabled: false }),
        request(app, 'GET', `/api/oauth/accounts/${invalidId}/models`),
      ]);

      expect(checks.map(result => result.status)).toEqual([400, 400, 400, 400, 400, 400]);
    },
  );

  it('returns not found for valid missing ids without mutating related rows', async () => {
    const db = getDb();
    const orphan = db.prepare(`
      INSERT INTO api_keys (
        platform, label, encrypted_key, iv, auth_tag, status, enabled, source,
        oauth_account_id
      ) VALUES ('openai', 'orphan', 'ciphertext', 'iv', 'tag', 'healthy', 1, 'oauth', 99999)
    `).run();

    const checks = await Promise.all([
      request(app, 'DELETE', '/api/keys/99998'),
      request(app, 'PATCH', '/api/keys/99998', { enabled: false }),
      request(app, 'POST', '/api/health/check/99998'),
      request(app, 'GET', '/api/settings/api-keys/99998/access-policy'),
      request(app, 'PATCH', '/api/settings/local-endpoints/99998', { enabled: false }),
      request(app, 'PATCH', '/api/oauth/accounts/99999', { enabled: false }),
      request(app, 'DELETE', '/api/oauth/accounts/99999'),
      request(app, 'GET', '/api/oauth/accounts/99999/models'),
    ]);

    expect(checks.map(result => result.status)).toEqual([404, 404, 404, 404, 404, 404, 404, 404]);
    expect(db.prepare('SELECT id FROM api_keys WHERE id = ?').get(orphan.lastInsertRowid)).toBeTruthy();
  });

  it('keeps provider key and OAuth account toggles and deletion synchronized', async () => {
    const db = getDb();
    const pair = seedOAuthPair();

    const disabled = await request(app, 'PATCH', `/api/keys/${pair.keyId}`, { enabled: false });
    expect(disabled.status).toBe(200);
    expect((db.prepare('SELECT enabled FROM api_keys WHERE id = ?').get(pair.keyId) as { enabled: number }).enabled).toBe(0);
    expect((db.prepare('SELECT enabled FROM oauth_accounts WHERE id = ?').get(pair.accountId) as { enabled: number }).enabled).toBe(0);

    const deleted = await request(app, 'DELETE', `/api/keys/${pair.keyId}`);
    expect(deleted.status).toBe(200);
    expect(db.prepare('SELECT 1 FROM api_keys WHERE id = ?').get(pair.keyId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM oauth_accounts WHERE id = ?').get(pair.accountId)).toBeUndefined();
  });

  it('rolls back provider-key toggles when the related OAuth update fails', async () => {
    const db = getDb();
    const pair = seedOAuthPair();
    db.exec(`
      CREATE TEMP TRIGGER fail_oauth_update BEFORE UPDATE ON oauth_accounts
      BEGIN SELECT RAISE(ABORT, 'forced oauth update failure'); END
    `);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await request(app, 'PATCH', `/api/keys/${pair.keyId}`, { enabled: false });

    expect(result.status).toBe(500);
    expect((db.prepare('SELECT enabled FROM api_keys WHERE id = ?').get(pair.keyId) as { enabled: number }).enabled).toBe(1);
    expect((db.prepare('SELECT enabled FROM oauth_accounts WHERE id = ?').get(pair.accountId) as { enabled: number }).enabled).toBe(1);
  });

  it('rolls back platform-wide toggles when a related OAuth update fails', async () => {
    const db = getDb();
    const pair = seedOAuthPair();
    db.exec(`
      CREATE TEMP TRIGGER fail_oauth_update BEFORE UPDATE ON oauth_accounts
      BEGIN SELECT RAISE(ABORT, 'forced oauth update failure'); END
    `);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await request(app, 'PATCH', '/api/keys/platform/openai', { enabled: false });

    expect(result.status).toBe(500);
    expect((db.prepare('SELECT enabled FROM api_keys WHERE id = ?').get(pair.keyId) as { enabled: number }).enabled).toBe(1);
    expect((db.prepare('SELECT enabled FROM oauth_accounts WHERE id = ?').get(pair.accountId) as { enabled: number }).enabled).toBe(1);
  });

  it('rolls back provider-key deletion when either related delete fails', async () => {
    const db = getDb();
    const pair = seedOAuthPair();
    db.exec(`
      CREATE TEMP TRIGGER fail_key_delete BEFORE DELETE ON api_keys
      BEGIN SELECT RAISE(ABORT, 'forced key delete failure'); END
    `);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await request(app, 'DELETE', `/api/keys/${pair.keyId}`);

    expect(result.status).toBe(500);
    expect(db.prepare('SELECT 1 FROM api_keys WHERE id = ?').get(pair.keyId)).toBeTruthy();
    expect(db.prepare('SELECT 1 FROM oauth_accounts WHERE id = ?').get(pair.accountId)).toBeTruthy();
  });

  it('keeps OAuth account edits and deletion synchronized with provider keys', async () => {
    const db = getDb();
    const pair = seedOAuthPair();

    const updated = await request(app, 'PATCH', `/api/oauth/accounts/${pair.accountId}`, {
      label: 'Renamed account',
      enabled: false,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ label: 'Renamed account', enabled: false });
    expect((db.prepare('SELECT enabled FROM api_keys WHERE id = ?').get(pair.keyId) as { enabled: number }).enabled).toBe(0);

    const deleted = await request(app, 'DELETE', `/api/oauth/accounts/${pair.accountId}`);
    expect(deleted.status).toBe(200);
    expect(db.prepare('SELECT 1 FROM api_keys WHERE id = ?').get(pair.keyId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM oauth_accounts WHERE id = ?').get(pair.accountId)).toBeUndefined();
  });

  it('rolls back OAuth account edits when provider-key synchronization fails', async () => {
    const db = getDb();
    const pair = seedOAuthPair();
    db.exec(`
      CREATE TEMP TRIGGER fail_key_update BEFORE UPDATE ON api_keys
      BEGIN SELECT RAISE(ABORT, 'forced key update failure'); END
    `);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await request(app, 'PATCH', `/api/oauth/accounts/${pair.accountId}`, {
      label: 'Must roll back',
      enabled: false,
    });

    expect(result.status).toBe(500);
    expect(db.prepare('SELECT label, enabled FROM oauth_accounts WHERE id = ?').get(pair.accountId)).toMatchObject({
      label: 'Test account',
      enabled: 1,
    });
    expect((db.prepare('SELECT enabled FROM api_keys WHERE id = ?').get(pair.keyId) as { enabled: number }).enabled).toBe(1);
  });

  it('rolls back OAuth deletion when the account delete fails after removing its key', async () => {
    const db = getDb();
    const pair = seedOAuthPair();
    db.exec(`
      CREATE TEMP TRIGGER fail_oauth_delete BEFORE DELETE ON oauth_accounts
      BEGIN SELECT RAISE(ABORT, 'forced oauth delete failure'); END
    `);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await request(app, 'DELETE', `/api/oauth/accounts/${pair.accountId}`);

    expect(result.status).toBe(500);
    expect(db.prepare('SELECT 1 FROM api_keys WHERE id = ?').get(pair.keyId)).toBeTruthy();
    expect(db.prepare('SELECT 1 FROM oauth_accounts WHERE id = ?').get(pair.accountId)).toBeTruthy();
  });
});
