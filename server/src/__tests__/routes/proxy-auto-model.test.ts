import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { decrypt, encrypt } from '../../lib/crypto.js';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

describe('Virtual "auto" model', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM oauth_accounts').run();
    db.prepare('DELETE FROM requests').run();

    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_auto_model_test',
      label: 'auto-model',
    });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists "auto" as the first /v1/models entry', async () => {
    const { status, body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(status).toBe(200);
    expect(body.object).toBe('list');
    expect(body.data[0]).toMatchObject({
      id: 'auto',
      object: 'model',
      owned_by: 'llmharbor',
    });
    // Real routeable catalog models still follow and are exposed as provider/model.
    expect(body.data.length).toBeGreaterThan(1);
    expect(body.data.some((m: any) => typeof m.id === 'string' && m.id.startsWith('groq/'))).toBe(true);
  });

  it('hides fallback-disabled models and does not advertise auto when no eligible route remains', async () => {
    const db = getDb();
    const groqFallbacks = db.prepare(`
      SELECT fc.model_db_id, fc.enabled
        FROM fallback_config fc
        JOIN models m ON m.id = fc.model_db_id
       WHERE m.platform = 'groq'
    `).all() as Array<{ model_db_id: number; enabled: number }>;
    try {
      db.prepare("UPDATE fallback_config SET enabled = 0 WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'groq')").run();
      const result = await request(app, 'GET', '/v1/models', undefined, authHeaders());
      expect(result.status).toBe(200);
      expect(result.body.data).toEqual([]);
    } finally {
      const restore = db.prepare('UPDATE fallback_config SET enabled = ? WHERE model_db_id = ?');
      for (const row of groqFallbacks) restore.run(row.enabled, row.model_db_id);
    }
  });

  it('requires stream=true when stream_options is supplied', async () => {
    const result = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
      stream_options: { include_usage: true },
    }, authHeaders());
    expect(result.status).toBe(400);
    expect(result.body.error.type).toBe('invalid_request_error');
    expect(result.body.error.message).toContain('stream_options requires stream=true');
  });

  it('hides browser-account models from /v1/models when no live OAuth key can route them', async () => {
    const db = getDb();
    db.prepare(`
      INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
      VALUES ('openai', 'gpt-browser-routeable-test', 'GPT Browser Routeable Test (ChatGPT browser account)', 1, 1, 'Frontier', 1)
    `).run();
    db.prepare("UPDATE models SET enabled = 1 WHERE platform = 'openai' AND model_id = 'gpt-browser-routeable-test'").run();
    const browserModel = db.prepare("SELECT id FROM models WHERE platform = 'openai' AND model_id = 'gpt-browser-routeable-test'").get() as { id: number };
    db.prepare('INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(browserModel.id);

    const withoutKey = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(withoutKey.body.data.map((m: any) => m.id)).not.toContain('openai/gpt-browser-routeable-test');

    const token = encrypt('oauth-access-token');
    const account = db.prepare(`
      INSERT INTO oauth_accounts (provider, label, account_hint, encrypted_access_token, access_iv, access_auth_tag, metadata_json, enabled)
      VALUES ('openai', 'ChatGPT browser', 'captain@example.com', ?, ?, ?, ?, 1)
    `).run(token.encrypted, token.iv, token.authTag, JSON.stringify({ oauthNeedsReconnect: true }));
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, source, oauth_account_id)
      VALUES ('openai', 'ChatGPT browser', ?, ?, ?, 'healthy', 1, 'oauth', ?)
    `).run(token.encrypted, token.iv, token.authTag, Number(account.lastInsertRowid));

    const reconnecting = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(reconnecting.body.data.map((m: any) => m.id)).not.toContain('openai/gpt-browser-routeable-test');

    db.prepare("UPDATE oauth_accounts SET metadata_json = '{}' WHERE id = ?").run(Number(account.lastInsertRowid));
    const routeable = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(routeable.body.data.map((m: any) => m.id)).toContain('openai/gpt-browser-routeable-test');
  });

  it('treats model:"auto" as auto-route instead of a 400', async () => {
    const origFetch = global.fetch;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-auto',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'routed via auto' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('routed via auto');
  });

  it('skips a failed model route instead of exhausting retries across all of its credentials', async () => {
    const db = getDb();
    const fallbackSnapshot = db.prepare('SELECT model_db_id, priority, enabled FROM fallback_config').all() as Array<{ model_db_id: number; priority: number; enabled: number }>;
    const groqModel = db.prepare("SELECT id, model_id FROM models WHERE platform = 'groq' AND enabled = 1 LIMIT 1").get() as { id: number; model_id: string };
    const cohereModel = db.prepare("SELECT id, model_id FROM models WHERE platform = 'cohere' AND enabled = 1 LIMIT 1").get() as { id: number; model_id: string };
    expect(groqModel).toBeTruthy();
    expect(cohereModel).toBeTruthy();
    db.prepare('UPDATE fallback_config SET enabled = 0').run();
    db.prepare('UPDATE fallback_config SET enabled = 1, priority = 1 WHERE model_db_id = ?').run(groqModel.id);
    db.prepare('UPDATE fallback_config SET enabled = 1, priority = 2 WHERE model_db_id = ?').run(cohereModel.id);
    const insertKey = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, 'healthy', 1)
    `);
    for (let index = 0; index < 24; index++) {
      const key = encrypt(`extra-groq-${index}`);
      insertKey.run('groq', `extra-${index}`, key.encrypted, key.iv, key.authTag);
    }
    const cohereKey = encrypt('healthy-cohere-fallback');
    insertKey.run('cohere', 'healthy cohere', cohereKey.encrypted, cohereKey.iv, cohereKey.authTag);

    let groqCalls = 0;
    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const target = String(url);
      if (target.includes('api.groq.com')) {
        groqCalls++;
        return Response.json({ error: { message: 'model removed' } }, { status: 404 });
      }
      if (target.includes('api.cohere.ai')) {
        return Response.json({
          id: 'cohere-fallback', object: 'chat.completion', created: 1, model: cohereModel.model_id,
          choices: [{ index: 0, message: { role: 'assistant', content: 'healthy route reached' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        });
      }
      return originalFetch(url, init);
    });

    try {
      const result = await request(app, 'POST', '/v1/chat/completions', {
        model: 'auto', messages: [{ role: 'user', content: 'route around removed model' }],
      }, authHeaders());
      expect(result.status).toBe(200);
      expect(result.body.choices[0].message.content).toBe('healthy route reached');
      expect(groqCalls).toBe(1);
      expect(result.headers.get('x-fallback-attempts')).toBe('1');
    } finally {
      const restore = db.prepare('UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?');
      for (const row of fallbackSnapshot) restore.run(row.priority, row.enabled, row.model_db_id);
    }
  });


  it('enforces request limits on the authenticated local client API key', async () => {
    const created = await request(app, 'POST', '/api/settings/api-keys', {
      label: 'one-shot local client',
      limits: { rpm: 1 },
    });
    expect(created.status).toBe(201);

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        return Response.json({
          id: 'chatcmpl-local-limit',
          object: 'chat.completion',
          created: 123,
          model: 'openai/gpt-oss-120b',
          choices: [{ index: 0, message: { role: 'assistant', content: 'first call ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
        });
      }
      return origFetch(url, init);
    });

    const headers = { Authorization: `Bearer ${created.body.key}` };
    const first = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    }, headers);
    expect(first.status).toBe(200);

    const second = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello again' }],
    }, headers);
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('client_key_limit_exceeded');
    expect(second.body.error.metric).toBe('rpm');
    expect(second.headers.get('retry-after')).toBeTruthy();
  });

  it('preflights token limits before routing to an upstream provider', async () => {
    const created = await request(app, 'POST', '/api/settings/api-keys', {
      label: 'tiny token budget',
      limits: { tpm: 2 },
    });
    expect(created.status).toBe(201);

    let upstreamCalled = false;
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) upstreamCalled = true;
      return origFetch(url, init);
    });
    const blocked = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hello' }],
    }, { Authorization: `Bearer ${created.body.key}` });

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('client_key_limit_exceeded');
    expect(blocked.body.error.metric).toBe('tpm');
    expect(upstreamCalled).toBe(false);
  });

  it('still rejects an unknown model with model_not_found', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'definitely-not-a-real-model',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
  });

  it('accepts provider/model IDs on the local API and returns the routed provider/model id', async () => {
    const origFetch = global.fetch;
    let upstreamModel: string | undefined;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        upstreamModel = JSON.parse(String(init?.body ?? '{}')).model;
        return Response.json({
          id: 'chatcmpl-prefixed-model',
          object: 'chat.completion',
          created: 123,
          model: upstreamModel,
          choices: [{ index: 0, message: { role: 'assistant', content: 'routed by provider/model id' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
        });
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'groq/llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(upstreamModel).toBe('llama-3.3-70b-versatile');
    expect(headers.get('x-routed-via')).toBe('groq/llama-3.3-70b-versatile');
    expect(body.model).toBe('groq/llama-3.3-70b-versatile');
    expect(body._routed_via).toEqual({ platform: 'groq', model: 'llama-3.3-70b-versatile' });
  });

  it('does not confuse an unprefixed model id that itself contains slashes with provider/model parsing', async () => {
    const db = getDb();
    db.prepare(`
      INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
      VALUES ('openrouter', 'openai/gpt-oss-120b:free', 'GPT-OSS 120B (OpenRouter Free)', 1, 1, 'Large', 1)
    `).run();
    db.prepare("UPDATE models SET enabled = 1 WHERE platform = 'openrouter' AND model_id = 'openai/gpt-oss-120b:free'").run();
    const token = encrypt('openrouter-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('openrouter', 'openrouter slash model', ?, ?, ?, 'healthy', 1)
    `).run(token.encrypted, token.iv, token.authTag);

    const origFetch = global.fetch;
    let upstreamModel: string | undefined;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('openrouter.ai/api/v1/chat/completions')) {
        upstreamModel = JSON.parse(String(init?.body ?? '{}')).model;
        return Response.json({
          id: 'chatcmpl-slashy-legacy-model',
          object: 'chat.completion',
          created: 123,
          model: upstreamModel,
          choices: [{ index: 0, message: { role: 'assistant', content: 'legacy slash id still works' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
        });
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'openai/gpt-oss-120b:free',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(upstreamModel).toBe('openai/gpt-oss-120b:free');
    expect(body.model).toBe('openrouter/openai/gpt-oss-120b:free');
  });

  it('falls back when an explicit catalog model has a retryable upstream failure', async () => {
    const addGoogle = await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google-explicit-fallback-test',
      label: 'google-explicit-fallback',
    });
    expect(addGoogle.status).toBe(201);

    const origFetch = global.fetch;
    let googleCalls = 0;
    let groqCalled = false;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('generativelanguage.googleapis.com')) {
        googleCalls++;
        return Response.json({ error: { message: 'internal error encountered' } }, { status: 500 });
      }
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        groqCalled = true;
        const upstreamModel = JSON.parse(String(init?.body ?? '{}')).model;
        return Response.json({
          id: 'chatcmpl-explicit-fallback',
          object: 'chat.completion',
          created: 123,
          model: upstreamModel,
          choices: [{ index: 0, message: { role: 'assistant', content: 'fallback succeeded' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
        });
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(googleCalls).toBeGreaterThan(0);
    expect(groqCalled).toBe(true);
    expect(headers.get('x-routed-via')).toBe('groq/llama-3.3-70b-versatile');
    expect(Number(headers.get('x-fallback-attempts'))).toBeGreaterThan(0);
    expect(body.choices[0].message.content).toBe('fallback succeeded');
    expect(body.error?.code).not.toBe('model_no_fallback');
  });

  it('isolates an upstream 401 to the rejected credential and falls back without a rate-limit penalty', async () => {
    const secondKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq', key: 'gsk-second-auth-key', label: 'second auth key',
    });
    expect(secondKey.status).toBe(201);

    let calls = 0;
    const seenAuthorization = new Set<string>();
    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (!String(url).includes('api.groq.com/openai/v1/chat/completions')) return originalFetch(url, init);
      calls++;
      seenAuthorization.add(String((init?.headers as Record<string, string>)?.Authorization));
      if (calls === 1) return Response.json({ error: { message: 'invalid upstream credential' } }, { status: 401 });
      const model = JSON.parse(String(init?.body)).model;
      return Response.json({
        id: 'auth-fallback', object: 'chat.completion', created: 1, model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'second credential worked' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      });
    });

    const result = await request(app, 'POST', '/v1/chat/completions', {
      model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'auth fallback' }],
    }, authHeaders());
    expect(result.status).toBe(200);
    expect(result.body.choices[0].message.content).toBe('second credential worked');
    expect(calls).toBe(2);
    expect(seenAuthorization.size).toBe(2);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM api_keys WHERE platform = 'groq' AND status = 'invalid'").get())
      .toMatchObject({ count: 1 });

    const rows = getDb().prepare('SELECT request_id, attempt, is_final, status FROM requests ORDER BY id').all() as any[];
    expect(new Set(rows.map(row => row.request_id)).size).toBe(1);
    expect(rows).toEqual([
      expect.objectContaining({ attempt: 1, is_final: 0, status: 'error' }),
      expect.objectContaining({ attempt: 2, is_final: 1, status: 'success' }),
    ]);
  });

  it('refreshes an OAuth access token once after an early upstream 401', async () => {
    const db = getDb();
    const modelId = 'gpt-oauth-401-refresh';
    db.prepare(`
      INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
      VALUES ('openai', ?, 'OAuth 401 refresh', 1, 1, 'Frontier', 1)
    `).run(modelId);
    const model = db.prepare("SELECT id FROM models WHERE platform = 'openai' AND model_id = ?").get(modelId) as { id: number };
    db.prepare('INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(model.id);

    const stale = encrypt('stale-oauth-access');
    const refresh = encrypt('rotating-refresh-token');
    const account = db.prepare(`
      INSERT INTO oauth_accounts (
        provider, label, encrypted_access_token, access_iv, access_auth_tag,
        encrypted_refresh_token, refresh_iv, refresh_auth_tag, expires_at, enabled
      ) VALUES ('openai', 'OAuth refresh account', ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      stale.encrypted, stale.iv, stale.authTag,
      refresh.encrypted, refresh.iv, refresh.authTag,
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    );
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, source, oauth_account_id)
      VALUES ('openai', 'OAuth refresh account', ?, ?, ?, 'healthy', 1, 'oauth', ?)
    `).run(stale.encrypted, stale.iv, stale.authTag, Number(account.lastInsertRowid));

    let chatCalls = 0;
    let refreshCalls = 0;
    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlString = String(url);
      if (urlString === 'https://auth.openai.com/oauth/token') {
        refreshCalls++;
        return Response.json({ access_token: 'fresh-oauth-access', refresh_token: 'next-refresh-token', expires_in: 3600 });
      }
      if (urlString === 'https://chatgpt.com/backend-api/codex/responses') {
        chatCalls++;
        const authorization = String((init?.headers as Record<string, string>)?.Authorization);
        if (authorization === 'Bearer stale-oauth-access') {
          return Response.json({ error: { message: 'expired access token' } }, { status: 401 });
        }
        expect(authorization).toBe('Bearer fresh-oauth-access');
        return new Response(
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'refreshed route' })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return originalFetch(url, init);
    });

    const result = await request(app, 'POST', '/v1/chat/completions', {
      model: `openai/${modelId}`,
      messages: [{ role: 'user', content: 'recover the revoked token' }],
    }, authHeaders());

    expect(result.status).toBe(200);
    expect(result.body.choices[0].message.content).toBe('refreshed route');
    expect(chatCalls).toBe(2);
    expect(refreshCalls).toBe(1);
    const updated = db.prepare('SELECT encrypted_access_token, access_iv, access_auth_tag FROM oauth_accounts WHERE id = ?')
      .get(Number(account.lastInsertRowid)) as any;
    expect(decrypt(updated.encrypted_access_token, updated.access_iv, updated.access_auth_tag)).toBe('fresh-oauth-access');
    expect(db.prepare('SELECT status, enabled FROM api_keys WHERE oauth_account_id = ?').get(Number(account.lastInsertRowid)))
      .toEqual({ status: 'healthy', enabled: 1 });
  });

  it('reports mixed upstream failures as 502 instead of claiming every route was rate limited', async () => {
    const origFetch = global.fetch;
    let calls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        calls++;
        return calls === 1
          ? Response.json({ error: { message: 'upstream internal failure' } }, { status: 500 })
          : Response.json({ error: { message: 'rate limit exceeded' } }, { status: 429 });
      }
      return origFetch(url, init);
    });

    const result = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'exercise every fallback' }],
    }, authHeaders());

    expect(calls).toBeGreaterThan(1);
    expect(result.status).toBe(502);
    expect(result.body.error.code).toBe('provider_fallback_exhausted');
    expect(result.body.error.message).toContain('provider routes failed');
    expect(result.body.error.message).not.toContain('All models rate-limited');
  });

  it('never exposes or persists arbitrary provider response text', async () => {
    const echoedCredential = 'gsk_auto_model_test';
    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.groq.com/openai/v1/chat/completions')) {
        expect(String((init?.headers as Record<string, string>)?.Authorization)).toContain(echoedCredential);
        return Response.json({ error: { message: `credential echoed verbatim: ${echoedCredential}` } }, { status: 500 });
      }
      return originalFetch(url, init);
    });

    const result = await request(app, 'POST', '/v1/chat/completions', {
      model: 'groq/llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'do not leak upstream bodies' }],
    }, authHeaders());

    expect(result.status).toBe(502);
    expect(result.raw).not.toContain(echoedCredential);
    const persistedErrors = getDb().prepare('SELECT error FROM requests WHERE error IS NOT NULL').all() as Array<{ error: string }>;
    expect(persistedErrors.length).toBeGreaterThan(0);
    expect(JSON.stringify(persistedErrors)).not.toContain(echoedCredential);
    expect(persistedErrors.every(row => /Upstream provider/.test(row.error))).toBe(true);
  });

  it('feeds repeated mid-stream protocol failures into the non-rate-limit route circuit', async () => {
    const db = getDb();
    const modelId = 'midstream-circuit-regression';
    db.prepare(`
      INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
      VALUES ('groq', ?, 'Mid-stream circuit regression', 1, 1, 'Test', 1)
    `).run(modelId);
    const model = db.prepare("SELECT id FROM models WHERE platform = 'groq' AND model_id = ?").get(modelId) as { id: number };
    db.prepare('INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(model.id);

    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (!String(url).includes('api.groq.com/openai/v1/chat/completions')) return originalFetch(url, init);
      expect(JSON.parse(String(init?.body)).model).toBe(modelId);
      return new Response(
        `data: ${JSON.stringify({
          id: 'partial', object: 'chat.completion.chunk', created: 1, model: modelId,
          choices: [{ index: 0, delta: { content: 'partial output' }, finish_reason: null }],
        })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await request(app, 'POST', '/v1/chat/completions', {
        model: `groq/${modelId}`,
        stream: true,
        messages: [{ role: 'user', content: 'trigger a truncated stream' }],
      }, authHeaders());
      expect(result.status).toBe(200);
      expect(result.raw).toContain('partial output');
      expect(result.raw).toContain('stream interrupted');
    }

    const fallback = await request(app, 'GET', '/api/fallback');
    const route = fallback.body.find((entry: any) => entry.modelDbId === model.id);
    expect(route).toMatchObject({
      eligible: false,
      skipReason: 'Temporarily isolated after repeated upstream failures',
      rateLimitHits: 0,
    });
    expect(route.routeFailureCount).toBeGreaterThanOrEqual(2);
    expect(Date.parse(route.routeFailureUntil)).toBeGreaterThan(Date.now());
  });

  it('isolates sticky routing state between client API keys with the same conversation opener', async () => {
    const addedGoogle = await request(app, 'POST', '/api/keys', {
      platform: 'google', key: 'google-sticky-isolation', label: 'sticky isolation',
    });
    expect(addedGoogle.status).toBe(201);
    const firstClient = await request(app, 'POST', '/api/settings/api-keys', { label: 'sticky first client' });
    const secondClient = await request(app, 'POST', '/api/settings/api-keys', { label: 'sticky second client' });
    const conversation = [
      { role: 'user', content: 'same opener across tenants' },
      { role: 'assistant', content: 'previous reply' },
      { role: 'user', content: 'continue' },
    ];

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        const model = JSON.parse(String(init?.body)).model;
        return Response.json({
          id: 'groq-sticky', object: 'chat.completion', created: 1, model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'groq' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      if (urlStr.includes('generativelanguage.googleapis.com')) {
        return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'google' }] }, finishReason: 'STOP' }], usageMetadata: {} });
      }
      return origFetch(url, init);
    });

    const first = await request(app, 'POST', '/v1/chat/completions', {
      model: 'groq/llama-3.3-70b-versatile', messages: conversation,
    }, { Authorization: `Bearer ${firstClient.body.key}` });
    expect(first.status).toBe(200);
    expect(first.headers.get('x-routed-via')).toContain('groq/');

    const second = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto', messages: conversation,
    }, { Authorization: `Bearer ${secondClient.body.key}` });
    expect(second.status).toBe(200);
    expect(second.headers.get('x-routed-via')).toContain('google/');
  });

  it('keeps the first routed model for second-turn and tool-result follow-ups', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google', key: 'google-sticky-followup', label: 'sticky followup competitor',
    });
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        const model = JSON.parse(String(init?.body)).model;
        return Response.json({
          id: 'groq-followup', object: 'chat.completion', created: 1, model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'groq' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      if (urlStr.includes('generativelanguage.googleapis.com')) {
        return Response.json({ candidates: [{ content: { parts: [{ text: 'google' }] }, finishReason: 'STOP' }], usageMetadata: {} });
      }
      return origFetch(url, init);
    });

    const opener = { role: 'user', content: 'sticky followup opener' };
    const initial = await request(app, 'POST', '/v1/chat/completions', {
      model: 'groq/llama-3.3-70b-versatile', messages: [opener],
    }, authHeaders());
    expect(initial.headers.get('x-routed-via')).toContain('groq/');

    const secondTurn = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto', messages: [opener, { role: 'assistant', content: 'first response' }, { role: 'user', content: 'continue' }],
    }, authHeaders());
    expect(secondTurn.headers.get('x-routed-via')).toContain('groq/');

    const toolFollowup = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [
        opener,
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"value":"ok"}' },
      ],
    }, authHeaders());
    expect(toolFollowup.headers.get('x-routed-via')).toContain('groq/');
  });
});
