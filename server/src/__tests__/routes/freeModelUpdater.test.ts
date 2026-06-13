import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { freeModelUpdater } from '../../services/freeModelUpdater.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  server.close();
  return { status: res.status, body: raw ? JSON.parse(raw) : null };
}

describe('free model updater routes', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    getDb().prepare("UPDATE free_model_updater_settings SET enabled = 0, refresh_interval_hours = 6, status = 'idle', error_message = NULL, detected_count = 0, last_run_at = NULL, next_run_at = NULL WHERE id = 1").run();
  });

  it('returns default status', async () => {
    const res = await request(app, 'GET', '/api/settings/free-model-updater/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, refreshIntervalHours: 6, status: 'idle' });
  });

  it('enables and disables updater', async () => {
    const enabled = await request(app, 'POST', '/api/settings/free-model-updater/enable', { refreshIntervalHours: 2 });
    expect(enabled.status).toBe(200);
    expect(enabled.body.enabled).toBe(true);
    expect(enabled.body.refreshIntervalHours).toBe(2);

    const disabled = await request(app, 'POST', '/api/settings/free-model-updater/disable');
    expect(disabled.status).toBe(200);
    expect(disabled.body.enabled).toBe(false);
  });

  it('rejects invalid interval bodies', async () => {
    const res = await request(app, 'POST', '/api/settings/free-model-updater/enable', { refreshIntervalHours: 0 });
    expect(res.status).toBe(400);
  });

  it('triggers manual refresh', async () => {
    vi.spyOn(freeModelUpdater, 'refreshNow').mockResolvedValue({ success: true, detectedCount: 3 });
    const res = await request(app, 'POST', '/api/settings/free-model-updater/refresh-now');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, detectedCount: 3, estimatedDuration: 'medium' });
  });
});
