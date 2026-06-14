import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
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

function insertApiKey(platform: string, status = 'healthy', enabled = 1): void {
  const encrypted = encrypt(`${platform}-key`);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(platform, `${platform} key`, encrypted.encrypted, encrypted.iv, encrypted.authTag, status, enabled);
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
    getDb().prepare('DELETE FROM free_model_updater_provider_preferences').run();
    getDb().prepare("DELETE FROM model_free_metadata").run();
    getDb().prepare('DELETE FROM api_keys').run();
    getDb().prepare("DELETE FROM models WHERE platform LIKE 'custom-%'").run();
    getDb().prepare("DELETE FROM custom_endpoints WHERE platform LIKE 'custom-%'").run();
    getDb().prepare("UPDATE free_model_updater_settings SET enabled = 0, refresh_interval_hours = 6, status = 'idle', error_message = NULL, detected_count = 0, last_run_at = NULL, next_run_at = NULL WHERE id = 1").run();
  });

  it('returns default status', async () => {
    const res = await request(app, 'GET', '/api/settings/free-model-updater/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, refreshIntervalHours: 6, status: 'idle', selectedProviders: [], selectedProviderCount: 0 });
  });

  it('lists built-in and custom provider options', async () => {
    insertApiKey('openrouter');
    insertApiKey('groq', 'healthy', 0);
    getDb().prepare(`
      INSERT INTO custom_endpoints (platform, name, base_url, timeout_ms, enabled)
      VALUES ('custom-local-vllm', 'Local vLLM', 'http://127.0.0.1:18888/v1', 120000, 1)
    `).run();

    const res = await request(app, 'GET', '/api/settings/free-model-updater/providers');
    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'openrouter', source: 'built-in', hasEnabledKey: true, selected: false }),
      expect.objectContaining({ platform: 'custom-local-vllm', source: 'custom', detectionPolicy: 'custom_catalog', selected: false }),
    ]));
    expect(res.body.providers.map((provider: any) => provider.platform)).not.toContain('groq');
  });

  it('persists selected built-in and custom providers', async () => {
    insertApiKey('openrouter');
    getDb().prepare(`
      INSERT INTO custom_endpoints (platform, name, base_url, timeout_ms, enabled)
      VALUES ('custom-local-vllm', 'Local vLLM', 'http://127.0.0.1:18888/v1', 120000, 1)
    `).run();

    const res = await request(app, 'PUT', '/api/settings/free-model-updater/providers', { selectedProviders: ['custom-local-vllm', 'openrouter'] });
    expect(res.status).toBe(200);
    expect(res.body.status.selectedProviders).toEqual(['custom-local-vllm', 'openrouter']);
    expect(res.body.providers.find((provider: any) => provider.platform === 'custom-local-vllm').selected).toBe(true);
  });

  it('rejects unknown provider selections and strict extra secret-like fields', async () => {
    const unknown = await request(app, 'PUT', '/api/settings/free-model-updater/providers', { selectedProviders: ['missing-provider'] });
    expect(unknown.status).toBe(400);

    const keyless = await request(app, 'PUT', '/api/settings/free-model-updater/providers', { selectedProviders: ['openrouter'] });
    expect(keyless.status).toBe(400);

    const extra = await request(app, 'PUT', '/api/settings/free-model-updater/providers', { selectedProviders: [], apiKey: 'secret' });
    expect(extra.status).toBe(400);
  });

  it('enables and disables updater', async () => {
    insertApiKey('openrouter');
    const enabled = await request(app, 'POST', '/api/settings/free-model-updater/enable', { refreshIntervalHours: 2, selectedProviders: ['openrouter'] });
    expect(enabled.status).toBe(200);
    expect(enabled.body.enabled).toBe(true);
    expect(enabled.body.refreshIntervalHours).toBe(2);
    expect(enabled.body.selectedProviders).toEqual(['openrouter']);

    const disabled = await request(app, 'POST', '/api/settings/free-model-updater/disable');
    expect(disabled.status).toBe(200);
    expect(disabled.body.enabled).toBe(false);
  });

  it('returns stored detected models without triggering live discovery', async () => {
    insertApiKey('openrouter');
    getDb().prepare("INSERT INTO free_model_updater_provider_preferences (platform, selected) VALUES ('openrouter', 1)").run();
    const model = getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, context_window, enabled)
      VALUES ('openrouter', 'x/free:free', 'X Free', 1, 1, 'Free', 'auto', 1234, 1)
    `).run();
    getDb().prepare(`
      INSERT INTO model_free_metadata (model_id, detected_via_updater, created_by_updater, detection_method, verification_status)
      VALUES (?, 1, 1, 'keyword', 'verified')
    `).run(Number(model.lastInsertRowid));
    const spy = vi.spyOn(freeModelUpdater, 'detectFreeModels');

    const res = await request(app, 'GET', '/api/settings/free-model-updater/detected-models');

    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    expect(res.body).toEqual([expect.objectContaining({ platform: 'openrouter', modelId: 'x/free:free', verificationStatus: 'verified' })]);
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
