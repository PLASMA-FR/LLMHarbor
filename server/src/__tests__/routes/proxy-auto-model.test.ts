import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

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
    const { status, body } = await request(app, 'GET', '/v1/models');
    expect(status).toBe(200);
    expect(body.object).toBe('list');
    expect(body.data[0]).toMatchObject({
      id: 'auto',
      object: 'model',
      owned_by: 'llmharbor',
    });
    // Real routeable catalog models still follow.
    expect(body.data.length).toBeGreaterThan(1);
  });

  it('hides browser-account models from /v1/models when no live OAuth key can route them', async () => {
    const db = getDb();
    db.prepare(`
      INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
      VALUES ('openai', 'gpt-browser-routeable-test', 'GPT Browser Routeable Test (ChatGPT browser account)', 1, 1, 'Frontier', 1)
    `).run();
    db.prepare("UPDATE models SET enabled = 1 WHERE platform = 'openai' AND model_id = 'gpt-browser-routeable-test'").run();

    const withoutKey = await request(app, 'GET', '/v1/models');
    expect(withoutKey.body.data.map((m: any) => m.id)).not.toContain('gpt-browser-routeable-test');

    const token = encrypt('oauth-access-token');
    const account = db.prepare(`
      INSERT INTO oauth_accounts (provider, label, account_hint, encrypted_access_token, access_iv, access_auth_tag, metadata_json, enabled)
      VALUES ('openai', 'ChatGPT browser', 'captain@example.com', ?, ?, ?, ?, 1)
    `).run(token.encrypted, token.iv, token.authTag, JSON.stringify({ oauthNeedsReconnect: true }));
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, source, oauth_account_id)
      VALUES ('openai', 'ChatGPT browser', ?, ?, ?, 'healthy', 1, 'oauth', ?)
    `).run(token.encrypted, token.iv, token.authTag, Number(account.lastInsertRowid));

    const reconnecting = await request(app, 'GET', '/v1/models');
    expect(reconnecting.body.data.map((m: any) => m.id)).not.toContain('gpt-browser-routeable-test');

    db.prepare("UPDATE oauth_accounts SET metadata_json = '{}' WHERE id = ?").run(Number(account.lastInsertRowid));
    const routeable = await request(app, 'GET', '/v1/models');
    expect(routeable.body.data.map((m: any) => m.id)).toContain('gpt-browser-routeable-test');
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

  it('does not fall back to a different model when an explicit catalog model fails upstream', async () => {
    const addGoogle = await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google-explicit-no-fallback-test',
      label: 'google-explicit-no-fallback',
    });
    expect(addGoogle.status).toBe(201);

    const origFetch = global.fetch;
    let googleCalled = false;
    let groqCalled = false;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('generativelanguage.googleapis.com')) {
        googleCalled = true;
        return Response.json({ error: { message: 'model not found' } }, { status: 404 });
      }
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        groqCalled = true;
        return Response.json({ error: { message: 'should not be called for strict model' } }, { status: 500 });
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(502);
    expect(googleCalled).toBe(true);
    expect(groqCalled).toBe(false);
    expect(headers.get('x-routed-via')).toBeNull();
    expect(body.error.code).toBe('model_no_fallback');
    expect(body.error.message).toContain('no fallback was attempted');
    expect(body.error.message).toContain('Google API error 404');
  });
});
