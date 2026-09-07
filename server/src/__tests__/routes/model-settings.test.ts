import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../app.js';
import { closeDb, createNamedClientApiKey, getDb, initDb, updateClientApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { getProvider } from '../../providers/index.js';

describe('model settings and credential preparation', () => {
  let server: Server;
  let base: string;
  beforeEach(() => {
    initDb(':memory:');
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeDb();
  });
  async function request(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { response, data: await response.json() };
  }

  it('edits limits in place, clears explicit nulls and preserves route order', async () => {
    const { data: created } = await request('/api/endpoints/groq/models', 'POST', {
      modelId: 'settings-model', displayName: 'Settings model', rpmLimit: 10, tpmLimit: 4000, contextWindow: 8192,
    });
    const db = getDb();
    const route = db.prepare('SELECT * FROM fallback_config WHERE model_db_id = ?').get(created.id);
    const edited = await request(`/api/endpoints/groq/models/${created.id}`, 'PATCH', { displayName: 'Renamed', rpmLimit: null });
    expect(edited.response.status).toBe(200);
    expect(edited.data).toMatchObject({ id: created.id, displayName: 'Renamed', rpmLimit: null, tpmLimit: 4000, contextWindow: 8192 });
    expect(db.prepare('SELECT * FROM fallback_config WHERE model_db_id = ?').get(created.id)).toEqual(route);
    expect((await request(`/api/endpoints/groq/models/${created.id}`, 'PATCH', {})).response.status).toBe(400);
    expect((await request(`/api/endpoints/groq/models/${created.id}`, 'PATCH', { rpmLimit: 1.5 })).response.status).toBe(400);
    expect((await request(`/api/endpoints/groq/models/${created.id}`, 'PATCH', { rpmLimit: 1e100 })).response.status).toBe(400);
  });

  it('deletes a model and its routing row while preserving the remaining catalog', async () => {
    const { data: created } = await request('/api/endpoints/groq/models', 'POST', { modelId: 'remove-me', displayName: 'Temporary' });
    const db = getDb();
    const remaining = db.prepare('SELECT * FROM fallback_config WHERE model_db_id != ? ORDER BY id').all(created.id);
    expect((await request(`/api/endpoints/groq/models/${created.id}`, 'DELETE')).response.status).toBe(200);
    expect(db.prepare('SELECT * FROM fallback_config ORDER BY id').all()).toEqual(remaining);
    expect((await request(`/api/endpoints/groq/models/${created.id}`, 'DELETE')).response.status).toBe(404);
    expect(db.prepare('SELECT * FROM fallback_config ORDER BY id').all()).toEqual(remaining);
  });

  it('prepares an OAuth account and its metadata for a model probe', async () => {
    const db = getDb();
    const access = encrypt('fixture-access-token');
    const account = db.prepare(`INSERT INTO oauth_accounts (provider, label, account_hint, encrypted_access_token, access_iv, access_auth_tag, metadata_json)
      VALUES ('openai', 'Fixture account', 'fixture', ?, ?, ?, '{"plan":"test"}')`).run(access.encrypted, access.iv, access.authTag);
    db.prepare(`INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, source, oauth_account_id)
      VALUES ('openai', ?, ?, ?, 'oauth', ?)`).run(access.encrypted, access.iv, access.authTag, account.lastInsertRowid);
    const provider = getProvider('openai')!;
    const complete = vi.spyOn(provider, 'chatCompletion').mockResolvedValue({ id: 'probe', object: 'chat.completion', created: 0, model: 'probe-model', choices: [{ index: 0, message: { role: 'assistant', content: 'harbor-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } });
    const probe = await request('/api/endpoints/openai/models/probe', 'POST', { modelId: 'probe-model' });
    expect(probe.response.status).toBe(200);
    expect(complete).toHaveBeenCalledWith('fixture-access-token', expect.any(Array), 'probe-model', expect.objectContaining({ oauth: { accountId: Number(account.lastInsertRowid), provider: 'openai', accountHint: 'fixture', metadata: { plan: 'test' } } }));
  });

  it('preserves unrelated limits when patching a client quota', () => {
    const key = createNamedClientApiKey('App', null, { rpm: 10, rpd: 100, tpm: 1000, tpd: 10000 });
    expect(updateClientApiKey(key.id, { limits: { rpm: 20 } })?.limits).toEqual({ rpm: 20, rpd: 100, tpm: 1000, tpd: 10000 });
    expect(updateClientApiKey(key.id, { limits: { tpm: null } })?.limits).toEqual({ rpm: 20, rpd: 100, tpm: null, tpd: 10000 });
  });

  it('accounts for streaming output independently of chunk boundaries', async () => {
    await request('/api/keys', 'POST', { platform: 'groq', key: 'stream-accounting-fixture' });
    let parts = ['abcd'];
    vi.spyOn(getProvider('groq')!, 'streamChatCompletion').mockImplementation(async function* () {
      const envelope = { id: 'accounting', object: 'chat.completion.chunk' as const, created: 1, model: 'model' };
      for (const content of parts) yield { ...envelope, choices: [{ index: 0, delta: { content }, finish_reason: null }] };
      yield { ...envelope, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
    });
    const send = async () => {
      const response = await fetch(base + '/api/playground/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 16, stream_options: { include_usage: true } }),
      });
      expect(response.status).toBe(200);
      const frames = (await response.text()).split('\n\n').filter(frame => frame.startsWith('data: {')).map(frame => JSON.parse(frame.slice(6)));
      return frames.find(frame => frame.usage)?.usage;
    };
    const whole = await send();
    parts = ['a', 'b', 'c', 'd'];
    expect(await send()).toEqual(whole);
    expect(whole).toEqual({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  });

  it('returns JSON at API namespace roots and keeps dashboard API responses out of caches', async () => {
    for (const path of ['/api', '/v1', '/api/unknown']) {
      const { response, data } = await request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(data.error.type).toBe('not_found');
    }
    expect((await request('/api/keys')).response.headers.get('cache-control')).toContain('no-store');
  });
});
