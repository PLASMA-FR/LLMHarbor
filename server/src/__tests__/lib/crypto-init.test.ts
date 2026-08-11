import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initEncryptionKey, encrypt, decrypt } from '../../lib/crypto.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  return db;
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function restoreEnv() {
  delete process.env.ENCRYPTION_KEY;
  delete process.env.DEV_MODE;
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
}

describe('initEncryptionKey — input validation and auto-generation', () => {
  beforeEach(() => {
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('accepts a valid 64-char hex env key', () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    const db = freshDb();
    expect(() => initEncryptionKey(db)).not.toThrow();
    const enc = encrypt('hello');
    expect(decrypt(enc.encrypted, enc.iv, enc.authTag)).toBe('hello');
  });

  it('throws on too-short env key (typo guard)', () => {
    process.env.ENCRYPTION_KEY = 'abc';
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/Invalid ENCRYPTION_KEY \(env\).+expected 64 hex chars/);
  });

  it('throws on too-long env key', () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(80);
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/Invalid ENCRYPTION_KEY \(env\)/);
  });

  it('throws on non-hex env key of correct length', () => {
    process.env.ENCRYPTION_KEY = 'g'.repeat(64);
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/Invalid ENCRYPTION_KEY \(env\)/);
  });

  it('auto-generates and persists a key when ENCRYPTION_KEY is missing', () => {
    const db = freshDb();
    expect(() => initEncryptionKey(db)).not.toThrow();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string };
    expect(row.value).toMatch(/^[0-9a-f]{64}$/);
    const enc = encrypt('generated-key-roundtrip');
    expect(decrypt(enc.encrypted, enc.iv, enc.authTag)).toBe('generated-key-roundtrip');
  });

  it('loads a DB-stored generated key even without DEV_MODE', () => {
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run('b'.repeat(64));
    expect(() => initEncryptionKey(db)).not.toThrow();
    const enc = encrypt('persisted');
    expect(decrypt(enc.encrypted, enc.iv, enc.authTag)).toBe('persisted');
  });

  it('auto-generates in production when neither env nor DB key exists', () => {
    process.env.NODE_ENV = 'production';
    const db = freshDb();
    expect(() => initEncryptionKey(db)).not.toThrow();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string };
    expect(row.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats the scaffold placeholder as missing and auto-generates', () => {
    process.env.ENCRYPTION_KEY = 'your-64-char-hex-key-here';
    const db = freshDb();
    expect(() => initEncryptionKey(db)).not.toThrow();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string };
    expect(row.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws on a corrupted DB-stored key', () => {
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run('not-hex');
    expect(() => initEncryptionKey(db)).toThrow(/Invalid ENCRYPTION_KEY \(db\)/);
  });

  it('migrates a generated key from SQLite to a permission-restricted sidecar', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmharbor-encryption-key-'));
    try {
      const keyPath = path.join(directory, 'llmharbor.db.key');
      const db = freshDb();
      db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run('c'.repeat(64));
      initEncryptionKey(db, keyPath);
      const encrypted = encrypt('sidecar-roundtrip');
      expect(fs.readFileSync(keyPath, 'utf8')).toBe('c'.repeat(64));
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
      expect(db.prepare("SELECT 1 FROM settings WHERE key = 'encryption_key'").get()).toBeUndefined();

      const reopened = freshDb();
      initEncryptionKey(reopened, keyPath);
      expect(decrypt(encrypted.encrypted, encrypted.iv, encrypted.authTag)).toBe('sidecar-roundtrip');
      reopened.close();
      db.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed on a conflicting env key without deleting the recoverable legacy key', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmharbor-encryption-recovery-'));
    const keyPath = path.join(directory, 'llmharbor.db.key');
    const db = freshDb();
    try {
      const legacyKey = 'd'.repeat(64);
      db.exec(`
        CREATE TABLE api_keys (
          id INTEGER PRIMARY KEY,
          encrypted_key TEXT NOT NULL,
          iv TEXT NOT NULL,
          auth_tag TEXT NOT NULL
        )
      `);
      db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run(legacyKey);
      initEncryptionKey(db);
      const credential = encrypt('recoverable-provider-secret');
      db.prepare('INSERT INTO api_keys (encrypted_key, iv, auth_tag) VALUES (?, ?, ?)').run(
        credential.encrypted,
        credential.iv,
        credential.authTag,
      );

      process.env.ENCRYPTION_KEY = 'e'.repeat(64);
      expect(() => initEncryptionKey(db, keyPath)).toThrow(
        /ENCRYPTION_KEY does not match the database-held legacy key.+Existing credentials still validate/,
      );
      expect(fs.existsSync(keyPath)).toBe(false);
      expect(
        (db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string }).value,
      ).toBe(legacyKey);

      delete process.env.ENCRYPTION_KEY;
      initEncryptionKey(db, keyPath);
      expect(fs.readFileSync(keyPath, 'utf8')).toBe(legacyKey);
      expect(db.prepare("SELECT 1 FROM settings WHERE key = 'encryption_key'").get()).toBeUndefined();
      expect(decrypt(credential.encrypted, credential.iv, credential.authTag)).toBe('recoverable-provider-secret');
    } finally {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes a matching legacy DB key after an environment-managed migration', () => {
    const db = freshDb();
    try {
      const key = 'f'.repeat(64);
      db.exec(`
        CREATE TABLE api_keys (
          id INTEGER PRIMARY KEY,
          encrypted_key TEXT NOT NULL,
          iv TEXT NOT NULL,
          auth_tag TEXT NOT NULL
        )
      `);
      db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run(key);
      initEncryptionKey(db);
      const credential = encrypt('environment-managed-secret');
      db.prepare('INSERT INTO api_keys (encrypted_key, iv, auth_tag) VALUES (?, ?, ?)').run(
        credential.encrypted,
        credential.iv,
        credential.authTag,
      );

      process.env.ENCRYPTION_KEY = key;
      initEncryptionKey(db);
      expect(db.prepare("SELECT 1 FROM settings WHERE key = 'encryption_key'").get()).toBeUndefined();
      expect(decrypt(credential.encrypted, credential.iv, credential.authTag)).toBe('environment-managed-secret');
    } finally {
      db.close();
    }
  });

  it('rejects a wrong environment key even when no legacy DB key or sidecar remains', () => {
    const db = freshDb();
    try {
      db.exec(`CREATE TABLE api_keys (id INTEGER PRIMARY KEY, encrypted_key TEXT NOT NULL, iv TEXT NOT NULL, auth_tag TEXT NOT NULL)`);
      process.env.ENCRYPTION_KEY = '1'.repeat(64);
      initEncryptionKey(db);
      const credential = encrypt('env-only-secret');
      db.prepare('INSERT INTO api_keys (encrypted_key, iv, auth_tag) VALUES (?, ?, ?)')
        .run(credential.encrypted, credential.iv, credential.authTag);

      process.env.ENCRYPTION_KEY = '2'.repeat(64);
      expect(() => initEncryptionKey(db)).toThrow(/does not decrypt every stored provider\/OAuth credential/i);
    } finally {
      db.close();
    }
  });

  it('validates every stored credential instead of accepting a decryptable first row', () => {
    const db = freshDb();
    try {
      db.exec(`CREATE TABLE api_keys (id INTEGER PRIMARY KEY, encrypted_key TEXT NOT NULL, iv TEXT NOT NULL, auth_tag TEXT NOT NULL)`);
      process.env.ENCRYPTION_KEY = '4'.repeat(64);
      initEncryptionKey(db);
      const first = encrypt('valid-first-secret');
      const second = encrypt('corrupt-second-secret');
      const insert = db.prepare('INSERT INTO api_keys (encrypted_key, iv, auth_tag) VALUES (?, ?, ?)');
      insert.run(first.encrypted, first.iv, first.authTag);
      insert.run(second.encrypted, second.iv, '0'.repeat(32));

      expect(() => initEncryptionKey(db)).toThrow(/every stored provider\/OAuth credential/i);
    } finally {
      db.close();
    }
  });

  it('fails closed when a file-backed credential key is missing', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmharbor-missing-key-'));
    const keyPath = path.join(directory, 'llmharbor.db.key');
    const db = freshDb();
    try {
      db.exec(`
        CREATE TABLE api_keys (
          id INTEGER PRIMARY KEY,
          encrypted_key TEXT NOT NULL,
          iv TEXT NOT NULL,
          auth_tag TEXT NOT NULL
        );
        CREATE TABLE oauth_accounts (
          id INTEGER PRIMARY KEY,
          encrypted_access_token TEXT NOT NULL,
          access_iv TEXT NOT NULL,
          access_auth_tag TEXT NOT NULL,
          encrypted_refresh_token TEXT,
          refresh_iv TEXT,
          refresh_auth_tag TEXT
        );
      `);
      initEncryptionKey(db, keyPath);
      const provider = encrypt('provider-secret');
      const access = encrypt('oauth-access');
      const refresh = encrypt('oauth-refresh');
      db.prepare('INSERT INTO api_keys (encrypted_key, iv, auth_tag) VALUES (?, ?, ?)')
        .run(provider.encrypted, provider.iv, provider.authTag);
      db.prepare(`
        INSERT INTO oauth_accounts (
          encrypted_access_token, access_iv, access_auth_tag,
          encrypted_refresh_token, refresh_iv, refresh_auth_tag
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(access.encrypted, access.iv, access.authTag, refresh.encrypted, refresh.iv, refresh.authTag);

      fs.rmSync(keyPath);
      expect(() => initEncryptionKey(db, keyPath)).toThrow(/key file is missing.+contains encrypted provider\/OAuth credentials/i);
      expect(fs.existsSync(keyPath)).toBe(false);
    } finally {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
