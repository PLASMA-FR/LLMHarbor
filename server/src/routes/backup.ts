import { sendValidationError } from '../lib/validation.js';
import crypto from 'crypto';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import os from 'os';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { backupDbToFile, getDb, getDbPath, stageDbRestoreFromBackupFile } from '../db/index.js';
import { getEncryptionKeyHexForBackup } from '../lib/crypto.js';
import { redactSensitive } from '../lib/errors.js';

export const backupRouter = Router();

const BACKUP_FORMAT = 'llmharbor.full-instance-backup.v1';
const RESTORE_CONFIRMATION = 'RESTORE_LLMHARBOR_BACKUP';
const DEFAULT_MAX_BACKUP_BYTES = 4 * 1024 * 1024 * 1024;
// The compatibility JSON route base64-encodes the database and is mounted
// behind a 180 MiB JSON parser. Keep its binary ceiling symmetric so it never
// exports a payload that the matching importer cannot parse. Large instances
// use the streaming database endpoints above instead.
const LEGACY_JSON_MAX_BACKUP_BYTES = 128 * 1024 * 1024;

function configuredMaxBackupBytes(): number {
  const configured = Number(process.env.LLMHARBOR_MAX_BACKUP_BYTES);
  return Number.isSafeInteger(configured) && configured >= 1024 * 1024
    ? configured
    : DEFAULT_MAX_BACKUP_BYTES;
}

const MAX_BACKUP_BYTES = configuredMaxBackupBytes();
const MAX_LEGACY_JSON_BACKUP_BYTES = Math.min(MAX_BACKUP_BYTES, LEGACY_JSON_MAX_BACKUP_BYTES);

backupRouter.get('/status', async (_req, res) => {
  const database = getDbPath();
  const stat = async (file: string) => fs.stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const [active, staged] = database === ':memory:' ? [null, null] : await Promise.all([stat(database), stat(`${database}.pending-restore.ready`)]);
  res.json({ databaseBytes: active?.size ?? 0, pendingRestore: Boolean(staged), stagedAt: staged?.mtime.toISOString() ?? null, maxBackupBytes: MAX_BACKUP_BYTES });
});

class BackupTooLargeError extends Error {}

const importBackupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  confirm: z.literal(RESTORE_CONFIRMATION),
  database: z.object({
    encoding: z.literal('base64'),
    content: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  }),
}).strict();

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llmharbor-backup-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function sha256(buffer: Buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function tableCount(table: string): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count ?? 0;
}

backupRouter.get('/export/database', async (_req: Request, res: Response) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llmharbor-backup-'));
  try {
    const dbFile = path.join(dir, 'llmharbor.db');
    await backupDbToFile(dbFile);
    const stat = await fs.stat(dbFile);
    if (stat.size > MAX_BACKUP_BYTES) {
      res.status(413).json({ error: { message: `The database exceeds the configured backup limit of ${MAX_BACKUP_BYTES} bytes.` } });
      return;
    }
    const hasher = crypto.createHash('sha256');
    for await (const chunk of createReadStream(dbFile)) hasher.update(chunk);
    const digest = hasher.digest('hex');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Content-Type', 'application/vnd.sqlite3');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Content-Disposition', `attachment; filename="llmharbor-backup-${stamp}.db"`);
    res.setHeader('X-LLMHarbor-Backup-Sha256', digest);
    await pipeline(createReadStream(dbFile), res);
  } catch (error) {
    console.error('Backup database export failed:', redactSensitive(error));
    if (!res.headersSent) {
      res.status(500).json({ error: { message: 'Failed to export the instance backup.' } });
    } else {
      res.destroy();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

backupRouter.post('/import/database', async (req: Request, res: Response) => {
  if (req.get('X-LLMHarbor-Restore-Confirmation') !== RESTORE_CONFIRMATION) {
    res.status(400).json({ error: { message: 'Explicit restore confirmation is required.' } });
    return;
  }
  if (!(req.get('Content-Type') ?? '').toLowerCase().startsWith('application/octet-stream')
    && !(req.get('Content-Type') ?? '').toLowerCase().startsWith('application/vnd.sqlite3')) {
    res.status(415).json({ error: { message: 'Upload the SQLite backup as application/octet-stream.' } });
    return;
  }
  const contentLength = Number(req.get('Content-Length'));
  if (Number.isFinite(contentLength) && (contentLength <= 0 || contentLength > MAX_BACKUP_BYTES)) {
    res.status(413).json({ error: { message: `Backup database must be between 1 byte and ${MAX_BACKUP_BYTES} bytes.` } });
    return;
  }
  const expectedSha = req.get('X-LLMHarbor-Backup-Sha256');
  if (expectedSha && !/^[a-f0-9]{64}$/i.test(expectedSha)) {
    res.status(400).json({ error: { message: 'Invalid backup SHA-256 header.' } });
    return;
  }

  try {
    const result = await withTempDir(async dir => {
      const dbFile = path.join(dir, 'restore.db');
      const digest = crypto.createHash('sha256');
      let bytes = 0;
      const limitAndHash = new Transform({
        transform(chunk, _encoding, callback) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += data.length;
          if (bytes > MAX_BACKUP_BYTES) {
            callback(new BackupTooLargeError(`Backup database must be at most ${MAX_BACKUP_BYTES} bytes.`));
            return;
          }
          digest.update(data);
          callback(null, data);
        },
      });
      await pipeline(req, limitAndHash, createWriteStream(dbFile, { mode: 0o600 }));
      if (bytes === 0) throw new Error('Backup database is empty.');
      const actualSha = digest.digest('hex');
      if (expectedSha && expectedSha.toLowerCase() !== actualSha) {
        throw new Error('Backup SHA-256 does not match the uploaded database content.');
      }
      return stageDbRestoreFromBackupFile(dbFile, getEncryptionKeyHexForBackup());
    });
    res.status(202).json({
      success: true,
      staged: true,
      restoredPath: result.restoredPath,
      previousBackupPath: result.previousBackupPath,
      restartedDatabase: false,
      restartRequired: true,
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(error instanceof BackupTooLargeError ? 413 : 400).json({ error: { message: redactSensitive(error instanceof Error ? error.message : error) } });
    }
  }
});

backupRouter.get('/export', async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  try {
    const payload = await withTempDir(async dir => {
      const dbFile = path.join(dir, 'llmharbor.db');
      await backupDbToFile(dbFile);
      const stat = await fs.stat(dbFile);
      if (stat.size > MAX_LEGACY_JSON_BACKUP_BYTES) {
        throw new BackupTooLargeError(`The database exceeds the legacy JSON backup limit of ${MAX_LEGACY_JSON_BACKUP_BYTES} bytes. Use /api/settings/backup/export/database for a streamed backup.`);
      }
      const content = await fs.readFile(dbFile);
      return {
        format: BACKUP_FORMAT,
        exportedAt: new Date().toISOString(),
        app: 'LLMHarbor',
        includes: [
          'sqlite-database',
          'settings',
          'providers',
          'api-keys',
          'local-proxy-keys',
          'client-api-keys',
          'client-api-key-usage',
          'client-api-key-policies',
          'oauth-accounts',
          'request-analytics',
          'routing-policies',
          'local-endpoints',
        ],
        manifest: {
          providerApiKeys: tableCount('api_keys'),
          localProxyKeys: tableCount('client_api_keys'),
          localProxyKeyUsageRows: tableCount('client_api_key_usage'),
          oauthAccounts: tableCount('oauth_accounts'),
          requestRows: tableCount('requests'),
        },
        security: {
          containsSecrets: true,
          note: 'This database backup contains one-way hashes for local client API keys and encrypted provider/OAuth credentials. Keep it private. Existing local client key secrets are not recoverable from it, and the credential-encryption key is intentionally excluded. Copy the matching llmharbor.db.key separately with mode 600, or restore with the same ENCRYPTION_KEY.',
        },
        restore: {
          endpoint: '/api/settings/backup/import',
          confirmation: RESTORE_CONFIRMATION,
        },
        database: {
          filename: 'llmharbor.db',
          encoding: 'base64',
          bytes: content.length,
          sha256: sha256(content),
          content: content.toString('base64'),
        },
      };
    });
    res.json(payload);
  } catch (error: any) {
    console.error('Backup export failed:', redactSensitive(error));
    if (error instanceof BackupTooLargeError) {
      res.status(413).json({ error: { message: error.message } });
      return;
    }
    res.status(500).json({ error: { message: 'Failed to export the instance backup.' } });
  }
});

backupRouter.post('/import', async (req: Request, res: Response) => {
  const parsed = importBackupSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }

  try {
    const result = await withTempDir(async dir => {
      const buffer = Buffer.from(parsed.data.database.content, 'base64');
      if (buffer.length === 0 || buffer.length > MAX_LEGACY_JSON_BACKUP_BYTES) {
        throw new Error(`Backup database must be between 1 byte and ${MAX_LEGACY_JSON_BACKUP_BYTES} bytes for the legacy JSON endpoint.`);
      }
      const actualSha = sha256(buffer);
      if (parsed.data.database.sha256 && parsed.data.database.sha256.toLowerCase() !== actualSha) {
        throw new Error('Backup SHA-256 does not match the uploaded database content.');
      }
      const dbFile = path.join(dir, 'restore.db');
      await fs.writeFile(dbFile, buffer, { mode: 0o600 });
      return stageDbRestoreFromBackupFile(
        dbFile,
        getEncryptionKeyHexForBackup(),
      );
    });
    res.status(202).json({
      success: true,
      staged: true,
      restoredPath: result.restoredPath,
      previousBackupPath: result.previousBackupPath,
      restartedDatabase: false,
      restartRequired: true,
    });
  } catch (error: any) {
    res.status(400).json({ error: { message: redactSensitive(error?.message ?? error) } });
  }
});
