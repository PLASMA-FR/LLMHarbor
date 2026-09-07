import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import SwaggerParser from '@apidevtools/swagger-parser';
import { createApp, createPublicApiApp } from '../../app.js';
import { closeDb, getDb, initDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';

describe('API product contracts and SDK integration', () => {
  let server: Server;
  let upstream: Server;
  let base: string;
  let upstreamBase: string;
  let authorization: string | undefined;
  let upstreamBody: Record<string, any>;
  let fixturePlatform: string | undefined;
  beforeEach(async () => {
    initDb(':memory:');
    authorization = undefined;
    upstreamBody = {};
    upstream = createServer(async (req, res) => {
      authorization = req.headers.authorization;
      let raw = '';
      for await (const chunk of req) raw += chunk;
      upstreamBody = raw ? JSON.parse(raw) : {};
      const envelope = { id: 'sdk-response', created: 1, model: 'sdk-model' };
      const usage = { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 };
      if (upstreamBody.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(
          `data: ${JSON.stringify({ ...envelope, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'SDK stream' }, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ ...envelope, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            ...envelope,
            object: 'chat.completion',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'SDK response' }, finish_reason: 'stop' },
            ],
            usage,
          }),
        );
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const listener of [server, upstream]) {
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
    if (fixturePlatform) {
      const { clearDynamicProvider } = await import('../../providers/index.js');
      clearDynamicProvider(fixturePlatform);
      fixturePlatform = undefined;
    }
    closeDb();
  });
  async function api(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, body: (await response.json()) as any };
  }
  async function setup(apiKey = '') {
    const endpoint = await api('/api/providers', 'POST', {
      name: 'SDK fixture',
      baseUrl: upstreamBase,
      apiKey,
    });
    expect(endpoint.response.status).toBe(201);
    fixturePlatform = endpoint.body.platform;
    const model = await api(`/api/providers/${fixturePlatform}/models`, 'POST', {
      modelId: 'sdk-model',
      displayName: 'SDK model',
    });
    expect(model.response.status).toBe(201);
    expect(
      (await api(`/api/routing/models/${model.body.id}`, 'PATCH', { enabled: true })).response.status,
    ).toBe(200);
    const key = await api('/api/client-keys', 'POST', { label: 'SDK app', limits: { rpm: 20, tpd: 5000 } });
    return {
      model: model.body,
      key: key.body,
      client: new OpenAI({ baseURL: base + '/v1', apiKey: key.body.key, maxRetries: 0 }),
    };
  }

  it('serves valid OpenAPI documents for inference and control surfaces', async () => {
    for (const path of ['/v1/openapi.json', '/api/openapi.json']) {
      const { response, body } = await api(path);
      expect(response.status).toBe(200);
      await expect(SwaggerParser.validate(body)).resolves.toBeTruthy();
      expect(body.components.schemas.ChatRequest.properties.max_completion_tokens).toBeDefined();
    }
    const publicServer = createPublicApiApp().listen(0);
    try {
      const response = await fetch(
        `http://127.0.0.1:${(publicServer.address() as AddressInfo).port}/v1/openapi.json`,
      );
      const body = (await response.json()) as any;
      expect(Object.keys(body.paths).every((path) => path.startsWith('/v1'))).toBe(true);
    } finally {
      publicServer.closeAllConnections();
      await new Promise<void>((resolve) => publicServer.close(() => resolve()));
    }
  });

  it('supports the official SDK, developer messages, output limits and anonymous endpoints', async () => {
    const { client, key } = await setup();
    const result = await client.chat.completions
      .create({
        model: `${fixturePlatform}/sdk-model`,
        messages: [
          { role: 'developer', content: 'Be brief' },
          { role: 'user', content: 'hello' },
        ],
        max_completion_tokens: 8,
      })
      .withResponse();
    expect(result.data.choices[0].message.content).toBe('SDK response');
    expect(result.response.headers.get('x-request-id')).toBeTruthy();
    expect(upstreamBody.max_tokens).toBe(8);
    expect(upstreamBody.messages[0].role).toBe('system');
    expect(authorization).toBeUndefined();
    const keys = await api('/api/provider-keys');
    expect(keys.body[0]).toMatchObject({ source: 'anonymous', maskedKey: 'No API key required' });
    const history = await api(`/api/requests?clientKeyId=${key.id}`);
    expect(history.body.data[0]).toMatchObject({
      clientKeyLabel: 'SDK app',
      status: 'success',
      inputTokens: 2,
      outputTokens: 2,
    });
    const trace = await api(`/api/requests/${history.body.data[0].id}`);
    expect(trace.body.completeTrace).toBe(true);
    expect(trace.body.attempts).toHaveLength(1);
  });

  it('streams through the official SDK with a terminal usage frame', async () => {
    const { client } = await setup();
    const stream = await client.chat.completions.create({
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const frames = await Array.fromAsync(stream);
    expect(frames.map((frame) => frame.choices[0]?.delta.content ?? '').join('')).toBe('SDK stream');
    expect(frames.at(-1)).toMatchObject({ choices: [], usage: { total_tokens: 4 } });
  });

  it('rotates a client secret without resetting policy, quotas or enabled state', async () => {
    const { key, client } = await setup();
    await api(`/api/client-keys/${key.id}/access-policy`, 'PATCH', {
      platforms: [{ platform: 'groq', enabled: false }],
    });
    const rotated = await api(`/api/client-keys/${key.id}/rotate`, 'POST');
    expect(rotated.body).toMatchObject({ id: key.id, limits: key.limits, enabled: true });
    expect(rotated.body.key).not.toBe(key.key);
    await expect(client.models.list()).rejects.toMatchObject({ status: 401 });
    const next = new OpenAI({ baseURL: base + '/v1', apiKey: rotated.body.key, maxRetries: 0 });
    expect((await next.models.list()).data.length).toBeGreaterThan(0);
    for (const path of ['/api/client-keys', '/api/settings/api-keys'])
      expect(JSON.stringify((await api(path)).body)).not.toContain(rotated.body.key);
    const policy = await api(`/api/client-keys/${key.id}/access-policy`);
    expect(policy.body.platforms.find((provider: any) => provider.platform === 'groq').enabled).toBe(false);
  });

  it('returns field errors, request IDs, authentication challenges and method/media hints', async () => {
    const invalid = await api('/api/client-keys', 'POST', { label: '', limits: { rpm: -1 } });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.error).toMatchObject({
      code: 'validation_error',
      request_id: invalid.response.headers.get('x-request-id'),
    });
    expect(invalid.body.error.details.map((detail: any) => detail.path)).toEqual(
      expect.arrayContaining(['label', 'limits.rpm']),
    );
    const unauthorized = await api('/v1/models');
    expect(unauthorized.response.status).toBe(401);
    expect(unauthorized.response.headers.get('www-authenticate')).toContain('Bearer');
    const wrongMethod = await api('/v1/chat/completions');
    expect(wrongMethod.response.status).toBe(405);
    expect(wrongMethod.response.headers.get('allow')).toBe('POST');
    const media = await fetch(base + '/api/client-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(media.status).toBe(415);
    expect(((await media.json()) as any).error.param).toBe('Content-Type');
  });

  it('paginates keys without changing the legacy list shape', async () => {
    for (let i = 0; i < 4; i++) await api('/api/client-keys', 'POST', { label: `App ${i}` });
    expect(Array.isArray((await api('/api/client-keys')).body)).toBe(true);
    const first = (await api('/api/client-keys?limit=2')).body;
    expect(first.data).toHaveLength(2);
    expect(first.pagination.hasMore).toBe(true);
    const next = (await api(`/api/client-keys?limit=2&cursor=${first.pagination.nextCursor}`)).body;
    expect(next.data.every((key: any) => key.id < first.data.at(-1).id)).toBe(true);
    expect((await api('/api/client-keys?limit=1000')).response.status).toBe(400);
  });

  it('rejects stale routing edits without overwriting a concurrent change', async () => {
    const { model } = await setup();
    const snapshot = await api('/api/routing');
    await api(`/api/routing/models/${model.id}`, 'PATCH', { enabled: false });
    const saved = await api(
      '/api/routing',
      'PUT',
      snapshot.body.map((entry: any) => ({
        modelDbId: entry.modelDbId,
        priority: entry.priority,
        enabled: entry.enabled,
      })),
      { 'If-Match': snapshot.response.headers.get('etag')! },
    );
    expect(saved.response.status).toBe(409);
    expect(saved.body.error.code).toBe('routing_conflict');
    expect(
      getDb().prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(model.id),
    ).toEqual({ enabled: 0 });
  });

  it('keeps separate traces when applications reuse their correlation ID', async () => {
    const { client } = await setup();
    for (let i = 0; i < 2; i++)
      await client.chat.completions.create(
        { model: 'auto', messages: [{ role: 'user', content: 'hello' }] },
        { headers: { 'X-Request-Id': 'shared-correlation' } },
      );
    const page = (await api('/api/requests?q=shared-correlation')).body;
    expect(page.data).toHaveLength(2);
    expect(page.data[0].traceId).not.toBe(page.data[1].traceId);
    const trace = (await api(`/api/requests/${page.data[0].id}`)).body;
    expect(trace.attempts).toHaveLength(1);
  });

  it('accepts nullable SDK defaults and reports unsupported output formats', async () => {
    const { client, key } = await setup();
    const result = await client.chat.completions.create({
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
      max_completion_tokens: null,
      temperature: null,
      top_p: null,
      n: null,
      response_format: null,
    });
    expect(result.choices[0].message.content).toBe('SDK response');
    const rejected = await api(
      '/v1/chat/completions',
      'POST',
      { messages: [{ role: 'user', content: 'hello' }], response_format: { type: 'json_object' } },
      { Authorization: `Bearer ${key.key}` },
    );
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error.param).toBe('response_format.type');
  });

  it('keeps a replacement credential intact when an older health check completes', async () => {
    await setup('old-fixture-token');
    const key = (await api('/api/provider-keys')).body[0];
    let started!: () => void;
    let finish!: (valid: boolean) => void;
    const checking = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(getProvider(fixturePlatform!)!, 'validateKey').mockImplementation(async (token) => {
      expect(token).toBe('old-fixture-token');
      started();
      return new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    });
    const check = api(`/api/health/check/${key.id}`, 'POST');
    await checking;
    expect(
      (await api(`/api/provider-keys/${key.id}`, 'PATCH', { key: 'new-fixture-token', label: 'Updated key' }))
        .response.status,
    ).toBe(200);
    finish(false);
    await check;
    const updated = (await api(`/api/provider-keys/${key.id}`)).body;
    expect(updated).toMatchObject({ status: 'unknown', label: 'Updated key', enabled: true });
    expect(updated.maskedKey).not.toContain('new-fixture-token');
  });
});
