import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { backupDbToFile, getDbPath, restoreDbFromBackupFile } from '../db/index.js';

export const backupRouter = Router();

const BACKUP_FORMAT = 'llmharbor.full-instance-backup.v1';
const RESTORE_CONFIRMATION = 'RESTORE_LLMHARBOR_BACKUP';
const MAX_BACKUP_BYTES = 128 * 1024 * 1024;

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

backupRouter.get('/export', async (_req: Request, res: Response) => {
  try {
    const payload = await withTempDir(async dir => {
      const dbFile = path.join(dir, 'llmharbor.db');
      await backupDbToFile(dbFile);
      const content = await fs.readFile(dbFile);
      return {
        format: BACKUP_FORMAT,
        exportedAt: new Date().toISOString(),
        app: 'LLMHarbor',
        source: {
          databasePath: getDbPath(),
        },
        includes: [
          'sqlite-database',
          'settings',
          'providers',
          'api-keys',
          'client-api-keys',
          'oauth-accounts',
          'request-analytics',
          'routing-policies',
          'local-endpoints',
        ],
        security: {
          containsSecrets: true,
          note: 'This backup contains client API keys and encrypted provider/OAuth credentials. Keep it private. If ENCRYPTION_KEY is supplied by the environment, restore with the same ENCRYPTION_KEY to decrypt existing provider credentials.',
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
    res.status(500).json({ error: { message: String(error?.message ?? error) } });
  }
});

backupRouter.post('/import', async (req: Request, res: Response) => {
  const parsed = importBackupSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(error => error.message).join(', ') } });
    return;
  }

  try {
    const result = await withTempDir(async dir => {
      const buffer = Buffer.from(parsed.data.database.content, 'base64');
      if (buffer.length === 0 || buffer.length > MAX_BACKUP_BYTES) {
        throw new Error(`Backup database must be between 1 byte and ${MAX_BACKUP_BYTES} bytes.`);
      }
      const actualSha = sha256(buffer);
      if (parsed.data.database.sha256 && parsed.data.database.sha256.toLowerCase() !== actualSha) {
        throw new Error('Backup SHA-256 does not match the uploaded database content.');
      }
      const dbFile = path.join(dir, 'restore.db');
      await fs.writeFile(dbFile, buffer, { mode: 0o600 });
      return restoreDbFromBackupFile(dbFile);
    });
    res.json({
      success: true,
      restoredPath: result.restoredPath,
      previousBackupPath: result.previousBackupPath,
      restartedDatabase: true,
    });
  } catch (error: any) {
    res.status(400).json({ error: { message: String(error?.message ?? error) } });
  }
});
