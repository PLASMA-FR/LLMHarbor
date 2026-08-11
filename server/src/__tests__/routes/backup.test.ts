import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { authenticateClientApiKey, backupDbToFile, closeDb, getDb, initDb, stageDbRestoreFromBackupFile } from '../../db/index.js';
import { encrypt, getEncryptionKeyHexForBackup } from '../../lib/crypto.js';

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
  return { status: res.status, body: json, raw, headers: res.headers };
}

async function rawRequest(app: Express, route: string, init?: RequestInit) {
  const server = app.listen(0);
  const addr = server.address() as any;
  try {
    return await fetch(`http://127.0.0.1:${addr.port}${route}`, init);
  } finally {
    server.close();
  }
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
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('streams SQLite export and import without a base64 JSON envelope', async () => {
    const added = await request(app, 'POST', '/api/keys', { platform: 'openai', key: 'sk-streamed-backup', label: 'streamed-key' });
    expect(added.status).toBe(201);

    const exported = await rawRequest(app, '/api/settings/backup/export/database');
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-type')).toContain('application/vnd.sqlite3');
    expect(exported.headers.get('content-disposition')).toContain('.db');
    expect(exported.headers.get('cache-control')).toContain('no-store');
    expect(exported.headers.get('x-llmharbor-backup-sha256')).toMatch(/^[a-f0-9]{64}$/);
    const database = new Uint8Array(await exported.arrayBuffer());
    expect(database.byteLength).toBeGreaterThan(0);

    getDb().prepare('DELETE FROM api_keys').run();
    const imported = await rawRequest(app, '/api/settings/backup/import/database', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-LLMHarbor-Restore-Confirmation': 'RESTORE_LLMHARBOR_BACKUP',
        'X-LLMHarbor-Backup-Sha256': exported.headers.get('x-llmharbor-backup-sha256') ?? '',
      },
      body: database,
    });
    expect(imported.status).toBe(202);
    expect(await imported.json()).toMatchObject({ staged: true, restartRequired: true });

    initDb(path.join(dir, 'llmharbor.db'));
    const keys = await request(app, 'GET', '/api/keys');
    expect(keys.body).toEqual([expect.objectContaining({ label: 'streamed-key' })]);
  });

  it('exports a restorable SQLite backup and requires explicit restore confirmation', async () => {
    const addKey = await request(app, 'POST', '/api/keys', { platform: 'openai', key: 'sk-test-backup-secret', label: 'backup-key' });
    expect(addKey.status).toBe(201);
    const localProxyKey = await request(app, 'POST', '/api/settings/api-keys', { label: 'local-proxy-backup-key', limits: { rpm: 7, rpd: null, tpm: 700, tpd: null } });
    expect(localProxyKey.status).toBe(201);
    const localProxySecret = localProxyKey.body.key;

    const exported = await request(app, 'GET', '/api/settings/backup/export');
    expect(exported.status).toBe(200);
    expect(exported.headers.get('cache-control')).toContain('no-store');
    expect(exported.body.format).toBe('llmharbor.full-instance-backup.v1');
    expect(exported.body.security.containsSecrets).toBe(true);
    expect(exported.body.source).toBeUndefined();
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
    expect(restored.status).toBe(202);
    expect(restored.body.success).toBe(true);
    expect(restored.body.restartRequired).toBe(true);
    expect(restored.body.restartedDatabase).toBe(false);
    expect(restored.body.previousBackupPath).toContain('.pre-import-');
    expect(fs.statSync(restored.body.previousBackupPath).mode & 0o777).toBe(0o600);
    // Environment-managed installs do not duplicate ENCRYPTION_KEY into a
    // rollback sidecar; the configured environment remains the recovery key.
    expect(fs.existsSync(`${restored.body.previousBackupPath}.key`)).toBe(false);
    const pendingKeyMaterial = fs.readFileSync(path.join(dir, 'llmharbor.db.pending-restore.key'), 'utf8');
    expect(pendingKeyMaterial).toMatch(/^env-sha256:[a-f0-9]{64}$/);
    expect(pendingKeyMaterial).not.toContain('3'.repeat(64));

    // Restore is staged so active requests/caches never observe a live database
    // swap. A process restart activates the validated replacement atomically.
    expect((await request(app, 'GET', '/api/keys')).body).toHaveLength(0);
    initDb(path.join(dir, 'llmharbor.db'));
    expect(fs.existsSync(path.join(dir, 'llmharbor.db.key'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'llmharbor.db.pending-restore.ready'))).toBe(false);

    const keys = await request(app, 'GET', '/api/keys');
    expect(keys.body).toHaveLength(1);
    expect(keys.body[0]).toMatchObject({ platform: 'openai', label: 'backup-key' });
    expect(JSON.stringify(keys.body)).not.toContain('sk-test-backup-secret');

    const restoredLocalProxyKeys = await request(app, 'GET', '/api/settings/api-keys');
    expect(restoredLocalProxyKeys.body.some((key: any) => key.label === 'local-proxy-backup-key')).toBe(true);
    const restoredLocalProxySecret = getDb().prepare("SELECT key, key_hash, key_hint FROM client_api_keys WHERE label = 'local-proxy-backup-key'").get() as { key: string; key_hash: string; key_hint: string };
    expect(restoredLocalProxySecret.key).not.toBe(localProxySecret);
    expect(restoredLocalProxySecret.key).toMatch(/^hashed:/);
    expect(restoredLocalProxySecret.key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(restoredLocalProxySecret.key_hint).not.toContain(localProxySecret);
    expect(authenticateClientApiKey(localProxySecret)?.label).toBe('local-proxy-backup-key');
  });

  it('rolls back the active database if staged activation fails after the original is moved', async () => {
    const databasePath = path.join(dir, 'llmharbor.db');
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('restore-marker', 'backup-copy')").run();
    const exported = await request(app, 'GET', '/api/settings/backup/export');
    getDb().prepare("UPDATE settings SET value = 'active-copy' WHERE key = 'restore-marker'").run();
    const staged = await request(app, 'POST', '/api/settings/backup/import', {
      format: exported.body.format,
      confirm: 'RESTORE_LLMHARBOR_BACKUP',
      database: exported.body.database,
    });
    expect(staged.status).toBe(202);

    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(((source: fs.PathLike, destination: fs.PathLike) => {
      if (String(destination) === databasePath && String(source).startsWith(`${databasePath}.tmp-`)) {
        throw new Error('simulated activation copy failure');
      }
      return originalRename(source, destination);
    }) as typeof fs.renameSync);
    // A failed activation rolls back and continues serving the intact active DB
    // rather than allowing a staged import to poison every subsequent startup.
    expect(() => initDb(databasePath)).not.toThrow();
    rename.mockRestore();

    const marker = getDb().prepare("SELECT value FROM settings WHERE key = 'restore-marker'").get() as { value: string };
    expect(marker.value).toBe('active-copy');
    expect(fs.readdirSync(dir).some(name => name.includes('.pending-restore.rejected-'))).toBe(true);
  });

  it('preserves an unmoved active key when its restore-swap rename fails', async () => {
    closeDb();
    delete process.env.ENCRYPTION_KEY;
    const databasePath = path.join(dir, 'file-key.db');
    const backupPath = path.join(dir, 'file-key-backup.db');
    let rename: ReturnType<typeof vi.spyOn> | null = null;
    try {
      initDb(databasePath);
      getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('restore-marker', 'backup-copy')").run();
      await backupDbToFile(backupPath);
      getDb().prepare("UPDATE settings SET value = 'active-copy' WHERE key = 'restore-marker'").run();
      await stageDbRestoreFromBackupFile(backupPath, getEncryptionKeyHexForBackup());

      const activeKeyPath = `${databasePath}.key`;
      const rollbackArtifacts = fs.readdirSync(dir).filter(name => name.startsWith('file-key.db.pre-import-') && name.endsWith('.bak'));
      expect(rollbackArtifacts).toHaveLength(1);
      expect(fs.statSync(path.join(dir, `${rollbackArtifacts[0]}.key`)).mode & 0o777).toBe(0o600);
      const originalKey = fs.readFileSync(activeKeyPath, 'utf8');
      const originalRename = fs.renameSync.bind(fs);
      rename = vi.spyOn(fs, 'renameSync').mockImplementation(((source: fs.PathLike, destination: fs.PathLike) => {
        if (String(source) === activeKeyPath && String(destination).includes('.restore-swap-')) {
          throw new Error('simulated sidecar swap failure');
        }
        return originalRename(source, destination);
      }) as typeof fs.renameSync);

      expect(() => initDb(databasePath)).not.toThrow();
      expect(fs.readFileSync(activeKeyPath, 'utf8')).toBe(originalKey);
      expect((getDb().prepare("SELECT value FROM settings WHERE key = 'restore-marker'").get() as { value: string }).value)
        .toBe('active-copy');
    } finally {
      rename?.mockRestore();
      process.env.ENCRYPTION_KEY = '3'.repeat(64);
    }
  });

  it('quarantines an incomplete staged pair and starts the intact active database', () => {
    const databasePath = path.join(dir, 'llmharbor.db');
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('restore-marker', 'active-survives')").run();
    fs.writeFileSync(`${databasePath}.pending-restore`, 'incomplete staged data', { mode: 0o600 });
    fs.writeFileSync(`${databasePath}.pending-restore.key`, '3'.repeat(64), { mode: 0o600 });

    expect(() => initDb(databasePath)).not.toThrow();
    expect((getDb().prepare("SELECT value FROM settings WHERE key = 'restore-marker'").get() as { value: string }).value)
      .toBe('active-survives');
    expect(fs.existsSync(`${databasePath}.pending-restore`)).toBe(false);
    expect(fs.readdirSync(dir).some(name => name.includes('.pending-restore.rejected-'))).toBe(true);
  });

  it('uses an operator-installed restore key for a cross-instance backup', async () => {
    const activePath = path.join(dir, 'llmharbor.db');
    const sourcePath = path.join(dir, 'source.db');
    const sourceBackupPath = path.join(dir, 'source-backup.db');
    closeDb();

    process.env.ENCRYPTION_KEY = '4'.repeat(64);
    initDb(sourcePath);
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cross-instance-marker', 'source')").run();
    const sourceCredential = encrypt('source-provider-secret');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('openai', 'source credential', ?, ?, ?, 'healthy', 1)
    `).run(sourceCredential.encrypted, sourceCredential.iv, sourceCredential.authTag);
    await backupDbToFile(sourceBackupPath);
    closeDb();

    process.env.ENCRYPTION_KEY = '3'.repeat(64);
    initDb(activePath);
    const restoreKeyPath = `${activePath}.restore-key`;
    fs.writeFileSync(restoreKeyPath, '4'.repeat(64), { mode: 0o600 });
    await stageDbRestoreFromBackupFile(sourceBackupPath, getEncryptionKeyHexForBackup());
    expect(fs.existsSync(restoreKeyPath)).toBe(false);

    // File-key mode can now activate the foreign backup without replacing the
    // key needed to open the still-active pre-restore database first.
    delete process.env.ENCRYPTION_KEY;
    initDb(activePath);
    expect((getDb().prepare("SELECT value FROM settings WHERE key = 'cross-instance-marker'").get() as { value: string }).value)
      .toBe('source');
    expect(fs.readFileSync(`${activePath}.key`, 'utf8')).toBe('4'.repeat(64));
  });

  it('rejects a backup whose legacy database-held key conflicts with the restore key', async () => {
    const backupPath = path.join(dir, 'legacy-key-mismatch.db');
    await backupDbToFile(backupPath);
    const candidate = new Database(backupPath);
    candidate.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('encryption_key', ?)").run('5'.repeat(64));
    candidate.close();

    await expect(stageDbRestoreFromBackupFile(backupPath, getEncryptionKeyHexForBackup()))
      .rejects.toThrow(/legacy encryption key conflicts/i);
    expect(fs.existsSync(path.join(dir, 'llmharbor.db.pending-restore.ready'))).toBe(false);
  });

  it('preflights startup schema and migrations on a clone before accepting a restore', async () => {
    const backupPath = path.join(dir, 'startup-incompatible.db');
    await backupDbToFile(backupPath);
    const candidate = new Database(backupPath);
    candidate.exec('DROP TABLE client_api_key_usage; CREATE TABLE client_api_key_usage (id INTEGER PRIMARY KEY)');
    candidate.close();

    await expect(stageDbRestoreFromBackupFile(backupPath, getEncryptionKeyHexForBackup()))
      .rejects.toThrow(/client_api_key_id|no such column/i);
    expect(fs.existsSync(path.join(dir, 'llmharbor.db.pending-restore.ready'))).toBe(false);
  });

  it('serializes concurrent restore staging so the committed database/key pair is coherent', async () => {
    const firstPath = path.join(dir, 'first-concurrent.db');
    const secondPath = path.join(dir, 'second-concurrent.db');
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('concurrent-marker', 'first')").run();
    await backupDbToFile(firstPath);
    getDb().prepare("UPDATE settings SET value = 'second' WHERE key = 'concurrent-marker'").run();
    await backupDbToFile(secondPath);

    const [first, second] = await Promise.all([
      stageDbRestoreFromBackupFile(firstPath, getEncryptionKeyHexForBackup()),
      stageDbRestoreFromBackupFile(secondPath, getEncryptionKeyHexForBackup()),
    ]);
    expect(first.pendingPath).toBe(second.pendingPath);
    const staged = new Database(second.pendingPath, { readonly: true });
    expect(staged.prepare("SELECT value FROM settings WHERE key = 'concurrent-marker'").get())
      .toEqual({ value: 'second' });
    staged.close();
    expect(fs.readFileSync(`${second.pendingPath}.key`, 'utf8')).toMatch(/^env-sha256:[a-f0-9]{64}$/);
    expect(fs.existsSync(`${second.pendingPath}.ready`)).toBe(true);
  });
});
