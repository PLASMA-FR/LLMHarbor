import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { routeRequest, routeRequestAsync } from '../../services/router.js';

describe('Router', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.LLMHARBOR_ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM oauth_accounts').run();
    // Reset fallback order to intelligence ranking
    const models = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all() as any[];
    const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it('should throw when no keys are configured', () => {
    expect(() => routeRequest()).toThrow(/exhausted/i);
  });

  it('should route to highest priority model with available key', () => {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', encrypted, iv, authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
    expect(result.apiKey).toBe('test-groq-key');
  });

  it('should prefer higher-priority model when keys exist for multiple platforms', () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'test', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    // Post-V6: Google's gemini-3.1-pro-preview (rank 1, free-tier-eligible per
    // probe on 2026-04-25) outranks Groq's best free-tier model openai/gpt-oss-120b
    // (rank 6). With keys for both platforms, Google wins.
    const result = routeRequest();
    expect(result.platform).toBe('google');
  });

  it('should skip disabled keys', () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'disabled', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 0);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('should skip invalid keys', () => {
    const db = getDb();

    const invalidKey = encrypt('invalid-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'invalid', invalidKey.encrypted, invalidKey.iv, invalidKey.authTag, 'invalid', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('should skip keys that cannot be decrypted and use a valid fallback key', () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'corrupt', 'not-hex', 'not-hex', 'not-hex', 'healthy', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    const corruptKey = db.prepare("SELECT status FROM api_keys WHERE label = 'corrupt'").get() as { status: string };

    expect(result.platform).toBe('groq');
    expect(result.apiKey).toBe('test-groq-key');
    expect(corruptKey.status).toBe('error');
  });

  it('does not route to a fallback model when explicit strict model is exhausted', () => {
    const db = getDb();
    const googleModel = db.prepare("SELECT id FROM models WHERE platform = 'google' AND enabled = 1 LIMIT 1").get() as { id: number };
    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'fallback-key', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    expect(() => routeRequest(1000, undefined, googleModel.id, true)).toThrow(/exhausted/i);
  });

  it('marks expired OAuth accounts reconnect-required instead of returning stale credentials when refresh fails', async () => {
    const db = getDb();
    db.prepare(`
      INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
      VALUES ('google-oauth', 'router-refresh-test-model', 'Router Refresh Test (Antigravity browser account)', 1, 1, 'Frontier', 1)
    `).run();
    const model = db.prepare("SELECT id FROM models WHERE platform = 'google-oauth' AND model_id = 'router-refresh-test-model'").get() as { id: number };
    db.prepare('INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(model.id);
    db.prepare('UPDATE fallback_config SET priority = 1, enabled = 1 WHERE model_db_id = ?').run(model.id);

    const staleAccess = encrypt('stale-access-token');
    const refresh = encrypt('refresh-token-value|duet-project|managed-project');
    const account = db.prepare(`
      INSERT INTO oauth_accounts (provider, label, account_hint, encrypted_access_token, access_iv, access_auth_tag, encrypted_refresh_token, refresh_iv, refresh_auth_tag, expires_at, enabled)
      VALUES ('antigravity', 'Antigravity browser', 'captain@example.com', ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(staleAccess.encrypted, staleAccess.iv, staleAccess.authTag, refresh.encrypted, refresh.iv, refresh.authTag, new Date(Date.now() - 60_000).toISOString());
    const key = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, source, oauth_account_id)
      VALUES ('google-oauth', 'Antigravity browser', ?, ?, ?, 'healthy', 1, 'oauth', ?)
    `).run(staleAccess.encrypted, staleAccess.iv, staleAccess.authTag, Number(account.lastInsertRowid));

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://oauth2.googleapis.com/token');
      const params = new URLSearchParams(String((init as any).body));
      expect(params.get('refresh_token')).toBe('refresh-token-value');
      expect(params.get('client_secret')).toMatch(/^GOCSPX-/);
      return Response.json({ error: 'unauthorized_client', error_description: 'Unauthorized' }, { status: 401 });
    });

    await expect(routeRequestAsync(1000, undefined, model.id, true)).rejects.toThrow(/Reconnect the browser account/i);

    const updatedKey = db.prepare('SELECT enabled, status FROM api_keys WHERE id = ?').get(Number(key.lastInsertRowid)) as { enabled: number; status: string };
    expect(updatedKey).toEqual({ enabled: 0, status: 'invalid' });
    const metadata = JSON.parse((db.prepare('SELECT metadata_json FROM oauth_accounts WHERE id = ?').get(Number(account.lastInsertRowid)) as any).metadata_json);
    expect(metadata.oauthNeedsReconnect).toBe(true);
    expect(metadata.oauthDiscoveryError).toContain('unauthorized_client');
  });

});
