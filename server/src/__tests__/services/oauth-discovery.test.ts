import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb } from '../../db/index.js';
import { encrypt, decrypt, initEncryptionKey } from '../../lib/crypto.js';
import { discoverOAuthAccount, refreshOAuthAccountInventory, updateOAuthModels } from '../../services/oauth-discovery.js';
import { checkKeyHealth } from '../../services/health.js';

function insertFallback(db: any, modelId: number) {
  db.prepare('INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelId, 9000 + modelId);
}

describe('OAuth model discovery', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '2'.repeat(64);
    delete process.env.LLMHARBOR_ANTIGRAVITY_OAUTH_CLIENT_SECRET;
  });

  afterEach(() => vi.restoreAllMocks());

  it('filters unsupported ChatGPT Codex browser-account IDs before catalog insertion', async () => {
    const db = initDb(':memory:');
    initEncryptionKey(db);
    const access = encrypt('chatgpt-access-token');

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      expect((init as any).headers.Authorization).toBe('Bearer chatgpt-access-token');
      if (urlStr.includes('/codex/models')) {
        return Response.json({ models: [
          { slug: 'gpt-5.5', display_name: 'GPT-5.5', supported_in_api: true, visibility: 'list', priority: 1, context_window: 272000 },
          { slug: 'gpt-5', display_name: 'GPT-5', supported_in_api: false, visibility: 'hide', priority: 2, context_window: 272000 },
          { slug: 'gpt-5-codex', display_name: 'GPT-5 Codex', supported_in_api: true, visibility: 'list', priority: 3, context_window: 272000 },
          { slug: 'gpt-5.1-codex', display_name: 'GPT-5.1 Codex', supported_in_api: true, visibility: 'list', priority: 4, context_window: 272000 },
          { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4 Mini', supported_in_api: true, visibility: 'list', priority: 5, context_window: 272000 },
        ] });
      }
      if (urlStr.includes('/codex/usage')) {
        return Response.json({ rate_limit: { primary_window: { used_percent: 3 } } });
      }
      throw new Error(`unexpected URL ${urlStr}`);
    });

    const discovered = await discoverOAuthAccount(db, {
      provider: 'openai',
      encrypted_access_token: access.encrypted,
      access_iv: access.iv,
      access_auth_tag: access.authTag,
    });

    expect(discovered.models.map(model => model.id).sort()).toEqual(['gpt-5', 'gpt-5.4-mini', 'gpt-5.5']);
    updateOAuthModels(db, discovered.models);

    const rows = db.prepare(`
      SELECT model_id, enabled FROM models
       WHERE platform = 'openai' AND display_name LIKE '%browser account%'
       ORDER BY model_id
    `).all() as { model_id: string; enabled: number }[];
    expect(rows).toEqual([
      { model_id: 'gpt-5', enabled: 1 },
      { model_id: 'gpt-5.4-mini', enabled: 1 },
      { model_id: 'gpt-5.5', enabled: 1 },
    ]);
  });

  it('disables stale blacklisted Codex rows and removes them from fallbacks on refresh', () => {
    const db = initDb(':memory:');
    const stale = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
      VALUES ('openai', 'gpt-5-codex', 'GPT-5 Codex (ChatGPT browser account)', 1, 5, 'Frontier', 1)
    `).run();
    insertFallback(db, Number(stale.lastInsertRowid));

    updateOAuthModels(db, [{
      id: 'gpt-5.5',
      displayName: 'GPT-5.5 (ChatGPT browser account)',
      platform: 'openai',
      priority: 1,
      speedRank: 5,
      sizeLabel: 'Frontier',
      contextWindow: 272000,
      supported: true,
      visibility: 'list',
    }]);

    const staleRow = db.prepare("SELECT enabled FROM models WHERE platform = 'openai' AND model_id = 'gpt-5-codex'").get() as { enabled: number };
    expect(staleRow.enabled).toBe(0);
    const staleFallback = db.prepare('SELECT COUNT(*) AS c FROM fallback_config WHERE model_db_id = ?').get(Number(stale.lastInsertRowid)) as { c: number };
    expect(staleFallback.c).toBe(0);
  });

  it('stores Antigravity browser-account models under google-oauth and keeps them enabled by default', () => {
    const db = initDb(':memory:');
    updateOAuthModels(db, [{
      id: 'gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro (Antigravity browser account)',
      platform: 'google-oauth',
      priority: 6,
      speedRank: 5,
      sizeLabel: 'Frontier',
      contextWindow: 1048576,
      supported: true,
      visibility: 'list',
    }]);

    const oauth = db.prepare("SELECT platform, enabled FROM models WHERE model_id = 'gemini-2.5-pro' AND display_name LIKE '%browser account%'").get() as { platform: string; enabled: number };
    expect(oauth).toEqual({ platform: 'google-oauth', enabled: 1 });
    const apiRows = db.prepare("SELECT COUNT(*) AS c FROM models WHERE platform = 'google' AND display_name LIKE '%browser account%'").get() as { c: number };
    expect(apiRows.c).toBe(0);
  });


  it('refreshes an expired Antigravity access token before live Code Assist model discovery', async () => {
    const db = initDb(':memory:');
    initEncryptionKey(db);
    const staleAccess = encrypt('stale-antigravity-access-token');
    const refresh = encrypt('antigravity-refresh-token|duet-project|managed-project');
    const account = db.prepare(`
      INSERT INTO oauth_accounts (provider, label, account_hint, encrypted_access_token, access_iv, access_auth_tag, encrypted_refresh_token, refresh_iv, refresh_auth_tag, expires_at, enabled)
      VALUES ('antigravity', 'Antigravity browser', 'captain@example.com', ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(staleAccess.encrypted, staleAccess.iv, staleAccess.authTag, refresh.encrypted, refresh.iv, refresh.authTag, new Date(Date.now() - 60_000).toISOString());
    const key = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, source, oauth_account_id)
      VALUES ('google-oauth', 'Antigravity browser', ?, ?, ?, 'healthy', 1, 'oauth', ?)
    `).run(staleAccess.encrypted, staleAccess.iv, staleAccess.authTag, Number(account.lastInsertRowid));

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://oauth2.googleapis.com/token') {
        const params = new URLSearchParams(String((init as any).body));
        expect(params.get('grant_type')).toBe('refresh_token');
        expect(params.get('client_id')).toBe('1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com');
        expect(params.get('refresh_token')).toBe('antigravity-refresh-token');
        expect(params.get('client_secret')).toBeTruthy();
        return Response.json({ access_token: 'fresh', expires_in: 3600, token_type: 'Bearer' });
      }
      if (urlStr.endsWith('/v1internal:loadCodeAssist')) {
        expect((init as any).headers.Authorization).toBe('Bearer fresh');
        return Response.json({ cloudaicompanionProject: 'project-from-load' });
      }
      if (urlStr.endsWith('/v1internal:fetchAvailableModels')) {
        expect((init as any).headers.Authorization).toBe('Bearer fresh');
        return Response.json({ models: { 'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro', contextWindow: 1048576 } } });
      }
      throw new Error(`unexpected URL ${urlStr}`);
    });

    const discovered = await refreshOAuthAccountInventory(db, Number(account.lastInsertRowid));

    expect(discovered.models.map(model => model.id)).toEqual(['gemini-2.5-pro']);
    const updatedKey = db.prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE id = ?').get(Number(key.lastInsertRowid)) as any;
    expect(decrypt(updatedKey.encrypted_key, updatedKey.iv, updatedKey.auth_tag)).toBe('fresh');
  });


  it('keeps OAuth keys healthy without validating browser tokens against API-key endpoints', async () => {
    const db = initDb(':memory:');
    initEncryptionKey(db);
    const access = encrypt('chatgpt-access-token');
    const account = db.prepare(`
      INSERT INTO oauth_accounts (provider, label, account_hint, encrypted_access_token, access_iv, access_auth_tag, enabled)
      VALUES ('openai', 'OpenAI browser', 'captain@example.com', ?, ?, ?, 1)
    `).run(access.encrypted, access.iv, access.authTag);
    const key = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, source, oauth_account_id)
      VALUES ('openai', 'OpenAI browser', ?, ?, ?, 'invalid', 1, 'oauth', ?)
    `).run(access.encrypted, access.iv, access.authTag, Number(account.lastInsertRowid));

    const status = await checkKeyHealth(Number(key.lastInsertRowid));
    expect(status).toBe('healthy');
    const row = db.prepare('SELECT status, enabled FROM api_keys WHERE id = ?').get(Number(key.lastInsertRowid)) as { status: string; enabled: number };
    expect(row).toEqual({ status: 'healthy', enabled: 1 });
  });

  it('disables stale Antigravity OAuth catalog rows when Code Assist discovery loses permission', async () => {
    const db = initDb(':memory:');
    initEncryptionKey(db);
    const access = encrypt('google-oauth-token');
    const account = db.prepare(`
      INSERT INTO oauth_accounts (provider, label, account_hint, encrypted_access_token, access_iv, access_auth_tag, enabled)
      VALUES ('antigravity', 'Antigravity browser', 'captain@example.com', ?, ?, ?, 1)
    `).run(access.encrypted, access.iv, access.authTag);
    updateOAuthModels(db, [{
      id: 'gemini-3.1-pro-preview',
      displayName: 'Gemini 3.1 Pro preview (Antigravity browser account)',
      platform: 'google-oauth',
      priority: 1,
      speedRank: 6,
      sizeLabel: 'Frontier',
      contextWindow: 1048576,
      supported: true,
      visibility: 'list',
    }]);
    expect((db.prepare("SELECT COUNT(*) AS count FROM models WHERE platform = 'google-oauth' AND enabled = 1").get() as any).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'google-oauth')").get() as any).count).toBe(1);

    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.endsWith('/v1internal:loadCodeAssist')) {
        return Response.json({ cloudaicompanionProject: 'project-from-load' });
      }
      if (urlStr.endsWith('/v1internal:fetchAvailableModels')) {
        return Response.json({ error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } }, { status: 403 });
      }
      throw new Error(`unexpected URL ${urlStr}`);
    });

    await expect(refreshOAuthAccountInventory(db, Number(account.lastInsertRowid))).rejects.toThrow(/PERMISSION_DENIED|permission/i);
    expect((db.prepare("SELECT COUNT(*) AS count FROM models WHERE platform = 'google-oauth' AND enabled = 1").get() as any).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'google-oauth')").get() as any).count).toBe(0);
    const metadata = JSON.parse((db.prepare('SELECT metadata_json FROM oauth_accounts WHERE id = ?').get(Number(account.lastInsertRowid)) as any).metadata_json);
    expect(metadata.oauthModelCount).toBe(0);
    expect(metadata.oauthNeedsReconnect).toBe(true);
    expect(metadata.oauthDiscoveryError).toContain('PERMISSION_DENIED');
  });
});
