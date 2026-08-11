import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../db/index.js';

describe('catalog migration ledger', () => {
  const directories: string[] = [];

  afterEach(() => {
    closeDb();
    delete process.env.ENCRYPTION_KEY;
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('does not overwrite operator model state on subsequent startups', () => {
    process.env.ENCRYPTION_KEY = '7'.repeat(64);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmharbor-migrations-'));
    directories.push(directory);
    const dbPath = path.join(directory, 'llmharbor.db');
    let db = initDb(dbPath);
    const model = db.prepare("SELECT id FROM models WHERE platform = 'google' ORDER BY id LIMIT 1").get() as { id: number };
    db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(model.id);
    expect((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number }).count).toBe(16);

    db = initDb(dbPath);
    expect((db.prepare('SELECT enabled FROM models WHERE id = ?').get(model.id) as { enabled: number }).enabled).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number }).count).toBe(16);
  });
});
