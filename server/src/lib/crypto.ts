import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const ALGORITHM = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

/**
 * AES-256-GCM uses a 32-byte key, hex-encoded as 64 chars.
 * A typo'd ENCRYPTION_KEY (e.g. "abc") would historically fall through
 * the placeholder check, get truncated to 1.5 bytes, and only fail at
 * the first encrypt() call with a cryptic node:crypto error. Validate
 * the length up front and fail fast with an actionable message.
 */
const KEY_BYTES = 32;
const KEY_HEX_LEN = KEY_BYTES * 2;
const PLACEHOLDER_KEY = 'your-64-char-hex-key-here';

function parseHexKey(value: string, source: 'env' | 'db' | 'file'): Buffer {
  if (value.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(
      `Invalid ENCRYPTION_KEY (${source}): expected ${KEY_HEX_LEN} hex chars (32 bytes), got ${value.length} chars. ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return Buffer.from(value, 'hex');
}

function validateEncryptedParts(encrypted: string, iv: string, authTag: string): void {
  if (!/^(?:[0-9a-fA-F]{24}|[0-9a-fA-F]{32})$/.test(iv)) throw new Error('Invalid encrypted credential IV.');
  if (!/^[0-9a-fA-F]{32}$/.test(authTag)) throw new Error('Invalid encrypted credential authentication tag.');
  if (encrypted.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(encrypted)) throw new Error('Invalid encrypted credential ciphertext.');
}

function decryptWithKey(key: Buffer, encrypted: string, iv: string, authTag: string): string {
  validateEncryptedParts(encrypted, iv, authTag);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function encryptedCredentials(db: Database.Database): Array<{ encrypted: string; iv: string; authTag: string }> {
  const credentials: Array<{ encrypted: string; iv: string; authTag: string }> = [];
  const hasApiKeys = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'").get();
  if (hasApiKeys) {
    credentials.push(...db.prepare('SELECT encrypted_key AS encrypted, iv, auth_tag AS authTag FROM api_keys ORDER BY id').all() as any[]);
  }
  const hasOAuth = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'oauth_accounts'").get();
  if (hasOAuth) {
    credentials.push(...db.prepare(`
      SELECT encrypted_access_token AS encrypted, access_iv AS iv, access_auth_tag AS authTag
        FROM oauth_accounts ORDER BY id
    `).all() as any[]);
    credentials.push(...db.prepare(`
      SELECT encrypted_refresh_token AS encrypted, refresh_iv AS iv, refresh_auth_tag AS authTag
        FROM oauth_accounts
       WHERE encrypted_refresh_token IS NOT NULL OR refresh_iv IS NOT NULL OR refresh_auth_tag IS NOT NULL
       ORDER BY id
    `).all() as any[]);
  }
  return credentials;
}

function keyDecryptsCredentials(db: Database.Database, key: Buffer): boolean | null {
  const credentials = encryptedCredentials(db);
  if (credentials.length === 0) return null;
  for (const credential of credentials) {
    if (!credential.encrypted || !credential.iv || !credential.authTag) return false;
    try {
      decryptWithKey(key, credential.encrypted, credential.iv, credential.authTag);
    } catch {
      return false;
    }
  }
  return true;
}

function assertMatchingKey(db: Database.Database, selected: Buffer, stored: Buffer, selectedLabel: string, storedLabel: string): void {
  if (crypto.timingSafeEqual(selected, stored)) return;
  const selectedWorks = keyDecryptsCredentials(db, selected);
  const storedWorks = keyDecryptsCredentials(db, stored);
  const recovery = storedWorks === true && selectedWorks === false
    ? ` Existing credentials still validate with the ${storedLabel}.`
    : '';
  throw new Error(`${selectedLabel} does not match the ${storedLabel}.${recovery} Remove the conflicting key or perform an explicit credential-key rotation.`);
}

function assertSelectedKeyDecryptsExistingCredentials(db: Database.Database, selected: Buffer, label: string): void {
  if (keyDecryptsCredentials(db, selected) === false) {
    throw new Error(`${label} does not decrypt every stored provider/OAuth credential. Restore the matching key before startup.`);
  }
}

function fsyncParentDirectory(filePath: string): void {
  if (process.platform === 'win32') return;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(path.dirname(filePath), 'r');
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function writeKeyFileAtomic(keyFilePath: string, key: Buffer): void {
  const temporaryPath = `${keyFilePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, key.toString('hex'), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    if (fs.existsSync(keyFilePath)) {
      const existing = parseHexKey(fs.readFileSync(keyFilePath, 'utf8').trim(), 'file');
      if (!crypto.timingSafeEqual(existing, key)) throw new Error('A different credential encryption key file already exists.');
      fs.unlinkSync(temporaryPath);
    } else {
      fs.renameSync(temporaryPath, keyFilePath);
      fsyncParentDirectory(keyFilePath);
    }
    try { fs.chmodSync(keyFilePath, 0o600); } catch { /* best effort on Windows */ }
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

/**
 * Initialize encryption key from env or a DB-persisted generated key.
 * Must be called after DB is initialized.
 *
 * LLMHarbor should be usable out of the box: when ENCRYPTION_KEY is absent
 * or still set to the scaffold placeholder, we generate a 32-byte AES key
 * and persist it in the local settings table. Existing encrypted provider
 * keys continue to decrypt across restarts because the generated key is
 * stable for that database.
 */
export function initEncryptionKey(db: Database.Database, keyFilePath?: string): void {
  clearEncryptionKey();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string } | undefined;
  const storedDbKey = row ? parseHexKey(row.value, 'db') : null;
  const storedFileKey = keyFilePath && fs.existsSync(keyFilePath)
    ? parseHexKey(fs.readFileSync(keyFilePath, 'utf8').trim(), 'file')
    : null;

  // 1. Prefer an explicitly configured environment key, but never silently
  // discard or override a different recoverable key. A typo must fail closed.
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && envKey !== PLACEHOLDER_KEY) {
    const selected = parseHexKey(envKey, 'env');
    if (storedFileKey) assertMatchingKey(db, selected, storedFileKey, 'ENCRYPTION_KEY', 'installed key file');
    if (storedDbKey) assertMatchingKey(db, selected, storedDbKey, 'ENCRYPTION_KEY', 'database-held legacy key');
    assertSelectedKeyDecryptsExistingCredentials(db, selected, 'ENCRYPTION_KEY');
    cachedKey = selected;
    // Only after exact matching/decryptability validation succeeds may the
    // legacy row be removed. This keeps key material out of database backups
    // without making a wrong environment value destructive.
    if (storedDbKey) {
      db.transaction(() => {
        db.prepare("DELETE FROM settings WHERE key = 'encryption_key' AND value = ?").run(row!.value);
      })();
    }
    return;
  }

  // 2. File-backed installations keep the generated key outside SQLite. A
  // database-only key would travel with the ciphertext in a copied backup and
  // provide no meaningful at-rest separation.
  if (keyFilePath) {
    if (storedFileKey) {
      if (storedDbKey) {
        assertMatchingKey(db, storedFileKey, storedDbKey, 'Installed key file', 'database-held legacy key');
        db.prepare("DELETE FROM settings WHERE key = 'encryption_key'").run();
      }
      assertSelectedKeyDecryptsExistingCredentials(db, storedFileKey, 'Installed key file');
      cachedKey = storedFileKey;
      try { fs.chmodSync(keyFilePath, 0o600); } catch { /* best effort on Windows */ }
      return;
    }

    if (!storedDbKey && encryptedCredentials(db).length > 0) {
      throw new Error(
        `Credential encryption key file is missing at ${keyFilePath}, but the database contains encrypted provider/OAuth credentials. ` +
        'Restore the original key file or provide the matching ENCRYPTION_KEY before startup.',
      );
    }

    const selected = storedDbKey ?? crypto.randomBytes(KEY_BYTES);
    assertSelectedKeyDecryptsExistingCredentials(db, selected, storedDbKey ? 'Database-held legacy key' : 'Generated key');
    writeKeyFileAtomic(keyFilePath, selected);
    const persisted = parseHexKey(fs.readFileSync(keyFilePath, 'utf8').trim(), 'file');
    assertMatchingKey(db, selected, persisted, 'Generated key', 'installed key file');
    cachedKey = selected;
    // The legacy row is removed only after the sidecar was atomically written,
    // fsync'd, read back, and verified.
    db.prepare("DELETE FROM settings WHERE key = 'encryption_key'").run();
    console.log(row ? 'Migrated the generated credential encryption key out of SQLite.' : 'Generated a local credential encryption key file.');
    return;
  }

  // In-memory/embedded callers without a key path retain database persistence.
  if (row) {
    cachedKey = parseHexKey(row.value, 'db');
    return;
  }

  // 3. Generate and persist a first-run key automatically.
  cachedKey = crypto.randomBytes(KEY_BYTES);
  db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run(cachedKey.toString('hex'));
  console.log('Generated and stored a local encryption key for provider credentials.');
}

export function clearEncryptionKey(): void {
  cachedKey?.fill(0);
  cachedKey = null;
}

function getEncryptionKey(): Buffer {
  if (!cachedKey) {
    throw new Error('Encryption key not initialized. Call initEncryptionKey() first.');
  }
  return cachedKey;
}

/** Internal-only restore preflight; never serialize this value in an API response. */
export function getEncryptionKeyHexForBackup(): string {
  return getEncryptionKey().toString('hex');
}

export function assertEncryptionKeyDecryptsDatabase(db: Database.Database, keyHex: string): void {
  const key = parseHexKey(keyHex, 'file');
  const result = keyDecryptsCredentials(db, key);
  key.fill(0);
  if (result === false) throw new Error('Backup credential encryption key does not decrypt the stored provider/OAuth credentials.');
}

export function encrypt(text: string): { encrypted: string; iv: string; authTag: string } {
  const key = getEncryptionKey();
  // 96-bit nonces are the interoperable, recommended size for AES-GCM.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

export function decrypt(encrypted: string, iv: string, authTag: string): string {
  const key = getEncryptionKey();
  // Accept historical 128-bit IVs so existing installations migrate without
  // re-encrypting credentials. New writes always use a 96-bit IV.
  return decryptWithKey(key, encrypted, iv, authTag);
}

export function maskKey(key: string): string {
  // Short local/custom credentials do not have enough entropy to reveal a
  // useful suffix safely. Never echo the whole stored secret back to the
  // control plane merely to make a visual identifier.
  if (key.length <= 8) return '********';
  return key.slice(0, 4) + '...' + key.slice(-4);
}
