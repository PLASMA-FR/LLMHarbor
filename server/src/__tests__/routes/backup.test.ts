import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';

async function request(app: Express, method: string, route: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json, raw };
}

describe('full-instance backup routes', () => {
  let dir: string;
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '3'.repeat(64);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmharbor-backup-test-'));
    initDb(path.join(dir, 'llmharbor.db'));
    app = createApp();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exports a restorable SQLite backup and requires explicit restore confirmation', async () => {
    const addKey = await request(app, 'POST', '/api/keys', { platform: 'openai', key: 'sk-test-backup-secret', label: 'backup-key' });
    expect(addKey.status).toBe(201);
    const localProxyKey = await request(app, 'POST', '/api/settings/api-keys', { label: 'local-proxy-backup-key', limits: { rpm: 7, rpd: null, tpm: 700, tpd: null } });
    expect(localProxyKey.status).toBe(201);
    const localProxySecret = localProxyKey.body.key;

    const exported = await request(app, 'GET', '/api/settings/backup/export');
    expect(exported.status).toBe(200);
    expect(exported.body.format).toBe('llmharbor.full-instance-backup.v1');
    expect(exported.body.security.containsSecrets).toBe(true);
    expect(exported.body.includes).toContain('local-proxy-keys');
    expect(exported.body.includes).toContain('client-api-key-policies');
    expect(exported.body.manifest.localProxyKeys).toBeGreaterThanOrEqual(1);
    expect(exported.body.database.encoding).toBe('base64');
    expect(exported.body.database.sha256).toMatch(/^[a-f0-9]{64}$/);

    getDb().prepare('DELETE FROM api_keys').run();
    getDb().prepare('DELETE FROM client_api_keys').run();
    expect((await request(app, 'GET', '/api/keys')).body).toHaveLength(0);
    expect((await request(app, 'GET', '/api/settings/api-keys')).body).toHaveLength(0);

    const rejected = await request(app, 'POST', '/api/settings/backup/import', {
      format: exported.body.format,
      confirm: 'NOPE',
      database: exported.body.database,
    });
    expect(rejected.status).toBe(400);

    const restored = await request(app, 'POST', '/api/settings/backup/import', {
      format: exported.body.format,
      confirm: 'RESTORE_LLMHARBOR_BACKUP',
      database: exported.body.database,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.success).toBe(true);
    expect(restored.body.previousBackupPath).toContain('.pre-import-');

    const keys = await request(app, 'GET', '/api/keys');
    expect(keys.body).toHaveLength(1);
    expect(keys.body[0]).toMatchObject({ platform: 'openai', label: 'backup-key' });
    expect(JSON.stringify(keys.body)).not.toContain('sk-test-backup-secret');

    const restoredLocalProxyKeys = await request(app, 'GET', '/api/settings/api-keys');
    expect(restoredLocalProxyKeys.body.some((key: any) => key.label === 'local-proxy-backup-key')).toBe(true);
    const restoredLocalProxySecret = getDb().prepare("SELECT key FROM client_api_keys WHERE label = 'local-proxy-backup-key'").get() as { key: string };
    expect(restoredLocalProxySecret.key).toBe(localProxySecret);
  });
});
