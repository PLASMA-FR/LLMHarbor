import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb } from '../../db/index.js';
import { encrypt, decrypt, initEncryptionKey } from '../../lib/crypto.js';
import { discoverOAuthAccount, refreshOAuthAccountInventory, updateOAuthModels } from '../../services/oauth-discovery.js';
import { checkKeyHealth } from '../../services/health.js';
import { routeRequest } from '../../services/router.js';

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

  it('does not overwrite or disable a regular OpenAI-key model with OAuth inventory state', () => {
    const db = initDb(':memory:');
    initEncryptionKey(db);
    const token = encrypt('browser-token');
    const account = db.prepare(`
      INSERT INTO oauth_accounts (provider, label, encrypted_access_token, access_iv, access_auth_tag, enabled)
      VALUES ('openai', 'Browser account', ?, ?, ?, 1)
    `).run(token.encrypted, token.iv, token.authTag);
    const regular = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
      VALUES ('openai', 'shared-model', 'Operator-managed OpenAI model', 42, 3, 'Custom', 1)
    `).run();
    insertFallback(db, Number(regular.lastInsertRowid));

    updateOAuthModels(db, [{
      id: 'shared-model',
      displayName: 'Shared model (ChatGPT browser account)',
      platform: 'openai',
      priority: 1,
      speedRank: 5,
      sizeLabel: 'Frontier',
      contextWindow: 272_000,
      supported: true,
    }], Number(account.lastInsertRowid));
    updateOAuthModels(db, [], Number(account.lastInsertRowid));

    expect(db.prepare("SELECT display_name, intelligence_rank, enabled FROM models WHERE platform = 'openai' AND model_id = 'shared-model'").get())
      .toEqual({ display_name: 'Operator-managed OpenAI model', intelligence_rank: 42, enabled: 1 });
    expect((db.prepare('SELECT COUNT(*) AS count FROM fallback_config WHERE model_db_id = ?').get(Number(regular.lastInsertRowid)) as any).count).toBe(1);
  });

  it('fails over between Code Assist hosts on transport errors during discovery', async () => {
    const db = initDb(':memory:');
    initEncryptionKey(db);
    const access = encrypt('antigravity-token');
    const urls: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const urlString = typeof url === 'string' ? url : url.toString();
      urls.push(urlString);
      if (urls.length === 1 || urls.length === 3) {
        throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
      }
      if (urlString.endsWith('/v1internal:loadCodeAssist')) {
        return Response.json({ cloudaicompanionProject: 'project-from-alternate-host' });
      }
      return Response.json({
        models: { 'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro', contextWindow: 1_048_576 } },
      });
    });

    const discovered = await discoverOAuthAccount(db, {
      provider: 'antigravity',
      encrypted_access_token: access.encrypted,
      access_iv: access.iv,
      access_auth_tag: access.authTag,
    });

    expect(discovered.models.map(model => model.id)).toEqual(['gemini-2.5-pro']);
    expect(urls).toEqual([
      'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    ]);
  });

  it('keeps per-account model inventories isolated when accounts expose different models', () => {
    const db = initDb(':memory:');
    const firstToken = encrypt('first-account-token');
    const secondToken = encrypt('second-account-token');
    const first = db.prepare(`
      INSERT INTO oauth_accounts (provider, label, encrypted_access_token, access_iv, access_auth_tag, enabled)
      VALUES ('openai', 'First browser account', ?, ?, ?, 1)
    `).run(firstToken.encrypted, firstToken.iv, firstToken.authTag);
    const second = db.prepare(`
      INSERT INTO oauth_accounts (provider, label, encrypted_access_token, access_iv, access_auth_tag, enabled)
      VALUES ('openai', 'Second browser account', ?, ?, ?, 1)
    `).run(secondToken.encrypted, secondToken.iv, secondToken.authTag);
    for (const [accountId, token, label] of [
      [Number(first.lastInsertRowid), firstToken, 'First browser account'],
      [Number(second.lastInsertRowid), secondToken, 'Second browser account'],
    ] as const) {
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, source, oauth_account_id)
        VALUES ('openai', ?, ?, ?, ?, 'healthy', 1, 'oauth', ?)
      `).run(label, token.encrypted, token.iv, token.authTag, accountId);
    }
    const model = (id: string): any => ({
      id,
      displayName: `${id} (ChatGPT browser account)`,
      platform: 'openai',
      priority: 1,
      speedRank: 1,
      sizeLabel: 'Frontier',
      contextWindow: 100_000,
      supported: true,
    });
    updateOAuthModels(db, [model('gpt-account-only-a')], Number(first.lastInsertRowid));
    updateOAuthModels(db, [model('gpt-account-only-b')], Number(second.lastInsertRowid));

    const firstModel = db.prepare("SELECT id FROM models WHERE platform = 'openai' AND model_id = 'gpt-account-only-a'").get() as { id: number };
    const secondModel = db.prepare("SELECT id FROM models WHERE platform = 'openai' AND model_id = 'gpt-account-only-b'").get() as { id: number };
    expect(routeRequest(10, undefined, firstModel.id, true).oauth?.accountId).toBe(Number(first.lastInsertRowid));
    expect(routeRequest(10, undefined, secondModel.id, true).oauth?.accountId).toBe(Number(second.lastInsertRowid));
    expect((db.prepare('SELECT COUNT(*) AS count FROM oauth_account_models').get() as any).count).toBe(2);
  });


  it('refreshes an expired Antigravity access token before live Code Assist model discovery', async () => {
    const db = initDb(':memory:');
    initEncryptionKey(db);
    const staleAccess = encrypt('stale-antigravity-access-token');
    const refresh = encrypt('antigravity-refresh-token|duet-project|managed-project');
    const account = db.prepare(`
      INSERT INTO oauth_accounts (provider, label, account_hint, encrypted_access_token, access_iv, access_auth_tag, encrypted_refresh_token, refresh_iv, refresh_auth_tag, expires_at, metadata_json, enabled)
      VALUES ('antigravity', 'Antigravity browser', 'captain@example.com', ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(staleAccess.encrypted, staleAccess.iv, staleAccess.authTag, refresh.encrypted, refresh.iv, refresh.authTag, new Date(Date.now() - 60_000).toISOString(), JSON.stringify({ oauthNeedsReconnect: true, oauthDiscoveryError: 'previous permission failure' }));
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
    const metadata = JSON.parse((db.prepare('SELECT metadata_json FROM oauth_accounts WHERE id = ?').get(Number(account.lastInsertRowid)) as any).metadata_json);
    expect(metadata.oauthNeedsReconnect).toBe(false);
    expect(metadata.oauthDiscoveryError).toBeNull();
  });


  it('does not overwrite OAuth credential health without a successful refresh', async () => {
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
    expect(status).toBe('invalid');
    const row = db.prepare('SELECT status, enabled FROM api_keys WHERE id = ?').get(Number(key.lastInsertRowid)) as { status: string; enabled: number };
    expect(row).toEqual({ status: 'invalid', enabled: 1 });

    db.prepare("UPDATE oauth_accounts SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify({ oauthNeedsReconnect: true }), Number(account.lastInsertRowid));
    db.prepare("UPDATE api_keys SET status = 'healthy' WHERE id = ?").run(Number(key.lastInsertRowid));
    expect(await checkKeyHealth(Number(key.lastInsertRowid))).toBe('invalid');
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
    }], Number(account.lastInsertRowid));
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

    await expect(refreshOAuthAccountInventory(db, Number(account.lastInsertRowid))).rejects.toThrow(/HTTP 403/i);
    expect((db.prepare("SELECT COUNT(*) AS count FROM models WHERE platform = 'google-oauth' AND enabled = 1").get() as any).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'google-oauth')").get() as any).count).toBe(0);
    const metadata = JSON.parse((db.prepare('SELECT metadata_json FROM oauth_accounts WHERE id = ?').get(Number(account.lastInsertRowid)) as any).metadata_json);
    expect(metadata.oauthModelCount).toBe(0);
    expect(metadata.oauthNeedsReconnect).toBe(true);
    expect(metadata.oauthDiscoveryError).toBe('Upstream provider returned HTTP 403.');
  });

  it('removes only the failing account inventory when another OAuth account remains healthy', async () => {
    const db = initDb(':memory:');
    initEncryptionKey(db);
    const firstAccess = encrypt('first-google-oauth-token');
    const secondAccess = encrypt('second-google-oauth-token');
    const first = db.prepare(`
      INSERT INTO oauth_accounts (provider, label, encrypted_access_token, access_iv, access_auth_tag, enabled)
      VALUES ('antigravity', 'First Antigravity account', ?, ?, ?, 1)
    `).run(firstAccess.encrypted, firstAccess.iv, firstAccess.authTag);
    const second = db.prepare(`
      INSERT INTO oauth_accounts (provider, label, encrypted_access_token, access_iv, access_auth_tag, enabled)
      VALUES ('antigravity', 'Second Antigravity account', ?, ?, ?, 1)
    `).run(secondAccess.encrypted, secondAccess.iv, secondAccess.authTag);
    const discoveredModel = (id: string): any => ({
      id,
      displayName: `${id} (Antigravity browser account)`,
      platform: 'google-oauth',
      priority: 1,
      speedRank: 5,
      sizeLabel: 'Frontier',
      contextWindow: 1_048_576,
      supported: true,
    });
    updateOAuthModels(db, [discoveredModel('gemini-first-only')], Number(first.lastInsertRowid));
    updateOAuthModels(db, [discoveredModel('gemini-second-only')], Number(second.lastInsertRowid));

    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.endsWith('/v1internal:loadCodeAssist')) {
        return Response.json({ cloudaicompanionProject: 'project-from-load' });
      }
      if (urlStr.endsWith('/v1internal:fetchAvailableModels')) {
        return Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 });
      }
      throw new Error(`unexpected URL ${urlStr}`);
    });

    await expect(refreshOAuthAccountInventory(db, Number(first.lastInsertRowid))).rejects.toThrow(/HTTP 403/i);
    const rows = db.prepare(`
      SELECT model_id, enabled FROM models
       WHERE platform = 'google-oauth' AND model_id LIKE 'gemini-%-only'
       ORDER BY model_id
    `).all();
    expect(rows).toEqual([
      { model_id: 'gemini-first-only', enabled: 0 },
      { model_id: 'gemini-second-only', enabled: 1 },
    ]);
    expect((db.prepare('SELECT COUNT(*) AS count FROM oauth_account_models WHERE oauth_account_id = ?').get(Number(first.lastInsertRowid)) as any).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM oauth_account_models WHERE oauth_account_id = ?').get(Number(second.lastInsertRowid)) as any).count).toBe(1);
  });

  it('preserves last-known Antigravity inventory and quota metadata after a transient discovery failure', async () => {
    const db = initDb(':memory:');
    initEncryptionKey(db);
    const access = encrypt('transient-google-oauth-token');
    const metadata = {
      oauthModelCount: 1,
      oauthModelIds: ['gemini-transient-preserved'],
      oauthLimits: [{ label: 'daily', usedPercent: 25 }],
      oauthNeedsReconnect: false,
    };
    const account = db.prepare(`
      INSERT INTO oauth_accounts (provider, label, encrypted_access_token, access_iv, access_auth_tag, metadata_json, enabled)
      VALUES ('antigravity', 'Transient Antigravity account', ?, ?, ?, ?, 1)
    `).run(access.encrypted, access.iv, access.authTag, JSON.stringify(metadata));
    updateOAuthModels(db, [{
      id: 'gemini-transient-preserved', displayName: 'Preserved (Antigravity browser account)', platform: 'google-oauth',
      priority: 1, speedRank: 5, sizeLabel: 'Frontier', contextWindow: 1_048_576, supported: true,
    }], Number(account.lastInsertRowid));

    vi.spyOn(global, 'fetch').mockResolvedValue(Response.json({ error: 'temporarily unavailable' }, { status: 503 }));
    await expect(refreshOAuthAccountInventory(db, Number(account.lastInsertRowid))).rejects.toThrow(/503/);

    expect((db.prepare('SELECT COUNT(*) AS count FROM oauth_account_models WHERE oauth_account_id = ?').get(Number(account.lastInsertRowid)) as any).count).toBe(1);
    expect((db.prepare("SELECT enabled FROM models WHERE platform = 'google-oauth' AND model_id = 'gemini-transient-preserved'").get() as any).enabled).toBe(1);
    const preserved = JSON.parse((db.prepare('SELECT metadata_json FROM oauth_accounts WHERE id = ?').get(Number(account.lastInsertRowid)) as any).metadata_json);
    expect(preserved.oauthModelCount).toBe(1);
    expect(preserved.oauthModelIds).toEqual(['gemini-transient-preserved']);
    expect(preserved.oauthLimits).toEqual([{ label: 'daily', usedPercent: 25 }]);
    expect(preserved.oauthNeedsReconnect).toBe(false);
    expect(preserved.oauthDiscoveryError).toBe('Upstream provider returned HTTP 503.');
  });
});
