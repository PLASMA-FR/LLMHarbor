import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { getBuiltInProviderSummaries, hasProvider } from '../providers/index.js';

export const keysRouter = Router();

// Built-in and custom endpoint ids are accepted here. Custom endpoints are
// validated against custom_endpoints through hasProvider().

const addKeySchema = z.object({
  platform: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/, 'Use a lowercase platform id like custom-local-vllm'),
  key: z.string().min(1),
  label: z.string().optional(),
});

const importKeysSchema = z.object({
  providerId: z.coerce.number().int().min(1),
  contents: z.string().min(1).max(250_000),
  labelPrefix: z.string().max(80).optional(),
});

function providerList(db = getDb()) {
  const builtIns = getBuiltInProviderSummaries().map(provider => ({
    platform: provider.platform,
    name: provider.name,
  }));
  const custom = db.prepare(`
    SELECT platform, name FROM custom_endpoints
    WHERE enabled = 1
    ORDER BY created_at ASC, id ASC
  `).all() as Array<{ platform: string; name: string }>;
  return [...builtIns, ...custom].map((provider, index) => ({ ...provider, providerId: index + 1 }));
}

function parseImportLines(contents: string): { uniqueKeys: string[]; attempted: number; duplicateCount: number } {
  const seen = new Set<string>();
  const uniqueKeys: string[] = [];
  let attempted = 0;
  let duplicateCount = 0;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    attempted += 1;
    if (seen.has(line)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(line);
    uniqueKeys.push(line);
  }
  return { uniqueKeys, attempted, duplicateCount };
}

// List all keys (masked)
keysRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as any[];

  const keys = rows.map(row => {
    let maskedKey = '****';
    try {
      const realKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      maskedKey = maskKey(realKey);
    } catch {
      maskedKey = '[decrypt failed]';
    }
    return {
      id: row.id,
      platform: row.platform,
      label: row.label,
      maskedKey,
      status: row.status,
      enabled: row.enabled === 1,
      source: row.source ?? 'manual',
      oauthAccountId: row.oauth_account_id ?? null,
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
    };
  });

  res.json(keys);
});

keysRouter.get('/providers', (_req: Request, res: Response) => {
  res.json(providerList());
});

keysRouter.post('/import', (req: Request, res: Response) => {
  const parsed = importKeysSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const provider = providerList(db).find(candidate => candidate.providerId === parsed.data.providerId);
  if (!provider) {
    res.status(400).json({ error: { message: `Unknown provider id '${parsed.data.providerId}'. Open Keys to see the current provider list.` } });
    return;
  }

  if (!hasProvider(provider.platform)) {
    res.status(400).json({ error: { message: `Provider '${provider.platform}' is not available.` } });
    return;
  }

  const parsedKeys = parseImportLines(parsed.data.contents);
  if (parsedKeys.uniqueKeys.length === 0) {
    res.status(400).json({ error: { message: 'No usable keys found. Put one key per line in a .txt file.' } });
    return;
  }

  const labelPrefix = (parsed.data.labelPrefix?.trim() || `${provider.name} import`).slice(0, 80);
  const existingRows = db.prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ?').all(provider.platform) as Array<{ encrypted_key: string; iv: string; auth_tag: string }>;
  const existing = new Set<string>();
  for (const row of existingRows) {
    try {
      existing.add(decrypt(row.encrypted_key, row.iv, row.auth_tag));
    } catch {
      // Ignore unreadable legacy rows; the health checker will surface them.
    }
  }

  const insert = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1)
  `);
  const importedKeys: Array<{ id: number | bigint; platform: string; label: string; maskedKey: string; status: string; enabled: boolean }> = [];
  let skipped = 0;

  const runImport = db.transaction(() => {
    for (const key of parsedKeys.uniqueKeys) {
      if (existing.has(key)) {
        skipped += 1;
        continue;
      }
      existing.add(key);
      const label = `${labelPrefix} ${importedKeys.length + 1}`;
      const { encrypted, iv, authTag } = encrypt(key);
      const result = insert.run(provider.platform, label, encrypted, iv, authTag);
      importedKeys.push({
        id: result.lastInsertRowid,
        platform: provider.platform,
        label,
        maskedKey: maskKey(key),
        status: 'unknown',
        enabled: true,
      });
    }
  });
  runImport();

  skipped += parsedKeys.duplicateCount;

  res.status(201).json({
    providerId: provider.providerId,
    platform: provider.platform,
    providerName: provider.name,
    attempted: parsedKeys.attempted,
    imported: importedKeys.length,
    skipped,
    keys: importedKeys,
  });
});

// Add a key
keysRouter.post('/', (req: Request, res: Response) => {
  const parsed = addKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { platform, key, label } = parsed.data;
  if (!hasProvider(platform)) {
    res.status(400).json({ error: { message: `Unknown endpoint '${platform}'. Add it under Custom endpoints first.` } });
    return;
  }

  const { encrypted, iv, authTag } = encrypt(key);

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1)
  `).run(platform, label ?? '', encrypted, iv, authTag);

  res.status(201).json({
    id: result.lastInsertRowid,
    platform,
    label: label ?? '',
    maskedKey: maskKey(key),
    status: 'unknown',
    enabled: true,
  });
});

// Delete a key
keysRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const db = getDb();
  const row = db.prepare('SELECT oauth_account_id FROM api_keys WHERE id = ?').get(id) as { oauth_account_id: number | null } | undefined;
  if (row?.oauth_account_id) {
    db.prepare('DELETE FROM oauth_accounts WHERE id = ?').run(row.oauth_account_id);
  }
  const result = db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  res.json({ success: true });
});

// Toggle all keys for a platform
keysRouter.patch('/platform/:platform', (req: Request, res: Response) => {
  const platform = req.params.platform as string;
  if (!hasProvider(platform)) {
    res.status(400).json({ error: { message: `Invalid platform '${platform}'` } });
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('UPDATE api_keys SET enabled = ? WHERE platform = ?').run(enabled ? 1 : 0, platform);
  db.prepare(`
    UPDATE oauth_accounts
    SET enabled = ?
    WHERE id IN (SELECT oauth_account_id FROM api_keys WHERE platform = ? AND oauth_account_id IS NOT NULL)
  `).run(enabled ? 1 : 0, platform);

  res.json({ success: true, enabled, updatedKeys: result.changes });
});

// Toggle enable/disable
keysRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  const db = getDb();
  const row = db.prepare('SELECT oauth_account_id FROM api_keys WHERE id = ?').get(id) as { oauth_account_id: number | null } | undefined;
  const result = db.prepare('UPDATE api_keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  if (row?.oauth_account_id) db.prepare('UPDATE oauth_accounts SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, row.oauth_account_id);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  res.json({ success: true, enabled });
});
