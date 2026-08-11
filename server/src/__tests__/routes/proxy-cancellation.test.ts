import type { Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb } from '../../db/index.js';

describe('proxy downstream cancellation', () => {
  let server: Server | null = null;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '8'.repeat(64);
    initDb(':memory:');
    const app = createApp();
    server = app.listen(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    server?.closeAllConnections?.();
    server?.close();
    server = null;
  });

  it('aborts the upstream stream and records a neutral cancellation when the client disconnects', async () => {
    const db = getDb();
    const created = await fetch(`http://127.0.0.1:${(server!.address() as any).port}/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'groq', label: 'cancellation', key: 'gsk-cancellation' }),
    });
    expect(created.status).toBe(201);

    const originalFetch = global.fetch;
    let signal: AbortSignal | undefined;
    let started!: () => void;
    let aborted!: () => void;
    const upstreamStarted = new Promise<void>(resolve => { started = resolve; });
    const upstreamAborted = new Promise<void>(resolve => { aborted = resolve; });
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (!String(url).includes('api.groq.com/openai/v1/chat/completions')) {
        return originalFetch(url, init);
      }
      signal = init?.signal as AbortSignal;
      const body = new ReadableStream({
        start(controller) {
          started();
          const onAbort = () => {
            aborted();
            controller.error(signal?.reason ?? new Error('aborted'));
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });

    const downstream = new AbortController();
    const request = originalFetch(`http://127.0.0.1:${(server!.address() as any).port}/v1/chat/completions`, {
      method: 'POST',
      signal: downstream.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getUnifiedApiKey()}` },
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'cancel me' }] }),
    }).catch(error => error);

    await upstreamStarted;
    downstream.abort();
    await request;
    await upstreamAborted;

    for (let attempt = 0; attempt < 20; attempt++) {
      const row = db.prepare("SELECT status FROM requests WHERE status = 'cancelled' ORDER BY id DESC LIMIT 1").get();
      if (row) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(signal?.aborted).toBe(true);
    const log = db.prepare("SELECT status, error FROM requests WHERE status = 'cancelled' ORDER BY id DESC LIMIT 1").get() as any;
    expect(log).toEqual({ status: 'cancelled', error: 'Client disconnected' });
    const primary = db.prepare('SELECT id FROM client_api_keys ORDER BY id LIMIT 1').get() as { id: number };
    const usage = db.prepare("SELECT COALESCE(SUM(tokens), 0) AS tokens FROM client_api_key_usage WHERE client_api_key_id = ? AND kind = 'tokens'")
      .get(primary.id) as { tokens: number };
    expect(usage.tokens).toBeGreaterThan(0);
  });
});
