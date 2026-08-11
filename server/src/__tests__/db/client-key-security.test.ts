import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authenticateClientApiKey,
  checkClientApiKeyLimits,
  closeDb,
  createNamedClientApiKey,
  getDb,
  getUnifiedApiKey,
  initDb,
  listClientApiKeys,
  regenerateUnifiedKey,
  releaseClientApiKeyCapacity,
  reserveClientApiKeyCapacity,
  recordClientApiKeyRequest,
  recordClientApiKeyTokens,
} from '../../db/index.js';

describe('client API key storage', () => {
  let directory: string;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '7'.repeat(64);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmharbor-client-key-'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('reveals a generated key once while persisting only a hash and hint', () => {
    initDb(path.join(directory, 'new.db'));
    const created = createNamedClientApiKey('Build agent');
    expect(created.key).toMatch(/^llmharbor-[a-f0-9]{48}$/);

    const stored = getDb().prepare('SELECT key, key_hash, key_hint FROM client_api_keys WHERE id = ?').get(created.id) as any;
    expect(stored.key).toMatch(/^hashed:/);
    expect(stored.key).not.toBe(created.key);
    expect(stored.key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.key_hint).toBe(created.maskedKey);
    expect(JSON.stringify(listClientApiKeys())).not.toContain(created.key);
    expect(authenticateClientApiKey(created.key!)?.id).toBe(created.id);
    expect(authenticateClientApiKey(`${created.key}x`)).toBeNull();
  });

  it('migrates legacy plaintext keys without retaining or re-exposing the secret', () => {
    const dbPath = path.join(directory, 'legacy.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE client_api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL DEFAULT 'Default key',
        key TEXT NOT NULL UNIQUE,
        local_endpoint_id INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        rpm_limit INTEGER,
        rpd_limit INTEGER,
        tpm_limit INTEGER,
        tpd_limit INTEGER
      );
    `);
    const secret = `llmharbor-${'ab'.repeat(24)}`;
    legacy.prepare("INSERT INTO settings (key, value) VALUES ('unified_api_key', ?)").run(secret);
    legacy.prepare("INSERT INTO client_api_keys (label, key) VALUES ('Legacy key', ?)").run(secret);
    legacy.close();

    initDb(dbPath);
    const stored = getDb().prepare("SELECT key, key_hash, key_hint FROM client_api_keys WHERE label = 'Legacy key'").get() as any;
    expect(stored.key).toMatch(/^hashed:/);
    expect(stored.key).not.toBe(secret);
    expect(stored.key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.key_hint).not.toBe(secret);
    expect(getDb().prepare("SELECT 1 FROM settings WHERE key = 'unified_api_key'").get()).toBeUndefined();
    expect(authenticateClientApiKey(secret)?.label).toBe('Legacy key');
    expect(() => getUnifiedApiKey()).toThrow(/cannot be revealed/i);
  });

  it('rotation invalidates the previous primary secret and stores no replacement plaintext', () => {
    initDb(path.join(directory, 'rotate.db'));
    const previous = getUnifiedApiKey();
    const replacement = regenerateUnifiedKey();
    expect(replacement).not.toBe(previous);
    expect(authenticateClientApiKey(previous)).toBeNull();
    expect(authenticateClientApiKey(replacement)).not.toBeNull();
    const stored = getDb().prepare('SELECT key FROM client_api_keys ORDER BY id LIMIT 1').get() as { key: string };
    expect(stored.key).toMatch(/^hashed:/);
    expect(stored.key).not.toBe(replacement);
  });

  it.runIf(process.platform !== 'win32')('hardens an existing data directory and SQLite sidecars', () => {
    delete process.env.ENCRYPTION_KEY;
    fs.chmodSync(directory, 0o775);
    const databasePath = path.join(directory, 'permissions.db');
    initDb(databasePath);
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('permission-check', 'ok')").run();

    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${databasePath}.key`).mode & 0o777).toBe(0o600);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(`${databasePath}${suffix}`)) {
        expect(fs.statSync(`${databasePath}${suffix}`).mode & 0o777).toBe(0o600);
      }
    }
  });

  it('combines persisted and failed-write usage without losing day-window events', () => {
    initDb(path.join(directory, 'client-limit-failure.db'));
    const created = createNamedClientApiKey('Failure-safe quota', null, { rpd: 2, tpd: 100 });
    const client = authenticateClientApiKey(created.key!)!;
    const oldWithinDay = Date.now() - 2 * 60_000;
    getDb().prepare(`
      INSERT INTO client_api_key_usage (client_api_key_id, kind, tokens, created_at_ms)
      VALUES (?, 'request', 0, ?), (?, 'tokens', 30, ?)
    `).run(created.id, oldWithinDay, created.id, oldWithinDay);
    getDb().prepare(`
      CREATE TRIGGER fail_client_usage_insert
      BEFORE INSERT ON client_api_key_usage
      BEGIN
        SELECT RAISE(FAIL, 'simulated busy write');
      END
    `).run();
    recordClientApiKeyRequest(created.id);
    recordClientApiKeyTokens(created.id, 80);
    getDb().prepare('DROP TRIGGER fail_client_usage_insert').run();

    expect(checkClientApiKeyLimits(client, 1)).toMatchObject({ metric: 'rpd', used: 2 });
    expect(checkClientApiKeyLimits({ ...client, limits: { rpm: null, rpd: null, tpm: null, tpd: 100 } }, 1))
      .toMatchObject({ metric: 'tpd', used: 110 });
  });

  it('retains client token reservations for long-lived streams until explicit settlement', () => {
    initDb(path.join(directory, 'client-long-stream.db'));
    const created = createNamedClientApiKey('Long stream quota', null, { tpm: 100 });
    const client = authenticateClientApiKey(created.key!)!;
    vi.useFakeTimers();
    const reservation = reserveClientApiKeyCapacity(client.id, 80);
    try {
      vi.advanceTimersByTime(11 * 60_000);
      expect(checkClientApiKeyLimits(client, 30)).toMatchObject({ metric: 'tpm', used: 80 });
    } finally {
      releaseClientApiKeyCapacity(reservation);
      vi.useRealTimers();
    }
  });
});
