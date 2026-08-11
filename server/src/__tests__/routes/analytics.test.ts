import type { Express } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';

async function request(app: Express, route: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${route}`);
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json };
}

describe('analytics ranges', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '5'.repeat(64);
    initDb(':memory:');
    app = createApp();
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    const insert = db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('openai', 'gpt-recent', 1, 'success', 10, 5, 100, null, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString());
    insert.run('openai', 'gpt-old', 1, 'success', 20, 10, 200, null, new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString());
    insert.run('openai', 'gpt-legacy', 1, 'success', 40, 20, 300, null, '');
  });

  it('supports all-time analytics beside bounded ranges', async () => {
    const recent = await request(app, '/api/analytics/summary?range=30d');
    expect(recent.status).toBe(200);
    expect(recent.body.totalRequests).toBe(1);
    expect(recent.body.successfulRequests).toBe(1);
    expect(recent.body.failedRequests).toBe(0);
    expect(recent.body.totalInputTokens).toBe(10);

    const all = await request(app, '/api/analytics/summary?range=alltime');
    expect(all.status).toBe(200);
    expect(all.body.totalRequests).toBe(3);
    expect(all.body.totalInputTokens).toBe(70);

    const allAlias = await request(app, '/api/analytics/by-model?range=all');
    expect(allAlias.status).toBe(200);
    expect(allAlias.body.map((row: any) => row.modelId).sort()).toEqual(['gpt-legacy', 'gpt-old', 'gpt-recent']);
  });

  it('returns recent request records with camelCase fields and explicit UTC timestamps', async () => {
    const recent = await request(app, '/api/analytics/recent?range=all&limit=2');
    expect(recent.status).toBe(200);
    expect(recent.body).toHaveLength(2);
    expect(recent.body[0]).toEqual(expect.objectContaining({
      id: expect.any(Number),
      platform: 'openai',
      modelId: expect.any(String),
      status: 'success',
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      latencyMs: expect.any(Number),
    }));
    expect(recent.body[0].createdAt).toMatch(/Z$/);
  });

  it('rejects invalid ranges, intervals, and recent limits', async () => {
    expect((await request(app, '/api/analytics/summary?range=yesterday')).status).toBe(400);
    expect((await request(app, '/api/analytics/timeline?interval=minute')).status).toBe(400);
    expect((await request(app, '/api/analytics/recent?limit=1000')).status).toBe(400);
  });

  it('counts failed upstream attempts in error distribution without double-counting request summaries', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (
        request_id, attempt, is_final, platform, model_id, key_id, status,
        input_tokens, output_tokens, latency_ms, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run('fallback-request', 1, 0, 'groq', 'failed-model', 1, 'error', 4, 0, 20, 'Upstream provider returned HTTP 500.');
    db.prepare(`
      INSERT INTO requests (
        request_id, attempt, is_final, platform, model_id, key_id, status,
        input_tokens, output_tokens, latency_ms, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run('fallback-request', 2, 1, 'cohere', 'healthy-model', 2, 'success', 4, 2, 40, null);

    const summary = await request(app, '/api/analytics/summary?range=24h');
    expect(summary.body.totalRequests).toBe(1); // only the final fallback success; the attempt is diagnostic
    expect(summary.body.failedRequests).toBe(0);

    const distribution = await request(app, '/api/analytics/error-distribution?range=24h');
    expect(distribution.body.byCategory).toContainEqual({ category: 'Server Error (500)', count: 1 });
    expect(distribution.body.byPlatform).toContainEqual({ platform: 'groq', count: 1 });
  });
});
