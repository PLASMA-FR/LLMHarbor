import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import type { ProviderCatalogModel } from '../../providers/base.js';
import { FreeModelUpdater, type DiscoveryProvider } from '../../services/freeModelUpdater.js';

const provider = (models: ProviderCatalogModel[]): DiscoveryProvider => ({
  platform: 'openrouter',
  name: 'OpenRouter',
  listModels: async () => models,
});

const namedProvider = (platform: string, models: ProviderCatalogModel[], spy = vi.fn()): DiscoveryProvider => ({
  platform,
  name: platform,
  listModels: async (apiKey: string) => {
    spy(apiKey);
    return models;
  },
});

function insertApiKey(platform: string, status = 'healthy', enabled = 1): void {
  const encrypted = encrypt(`${platform}-key`);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(platform, `${platform} key`, encrypted.encrypted, encrypted.iv, encrypted.authTag, status, enabled);
}

describe('FreeModelUpdater', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns default disabled status', () => {
    const updater = new FreeModelUpdater({ now: () => new Date('2026-06-01T00:00:00.000Z') });
    expect(updater.getStatus()).toMatchObject({
      enabled: false,
      refreshIntervalHours: 6,
      status: 'idle',
      detectedCount: 0,
      selectedProviders: [],
      selectedProviderCount: 0,
    });
  });

  it('shows only built-in providers with enabled keys while preserving custom endpoints', () => {
    insertApiKey('openrouter');
    insertApiKey('groq', 'healthy', 0);
    insertApiKey('cerebras', 'error', 1);
    getDb().prepare(`
      INSERT INTO custom_endpoints (platform, name, base_url, timeout_ms, enabled)
      VALUES ('custom-local-vllm', 'Local vLLM', 'http://127.0.0.1:18888/v1', 120000, 1)
    `).run();

    const options = new FreeModelUpdater().getProviderOptions();

    expect(options.map(option => option.platform)).toEqual(['openrouter', 'custom-local-vllm']);
    expect(options.find(option => option.platform === 'openrouter')).toMatchObject({ source: 'built-in', hasEnabledKey: true });
    expect(options.find(option => option.platform === 'custom-local-vllm')).toMatchObject({ source: 'custom', detectionPolicy: 'custom_catalog', hasEnabledKey: false });
  });

  it('rejects keyless built-in selections but accepts enabled custom endpoints', () => {
    getDb().prepare(`
      INSERT INTO custom_endpoints (platform, name, base_url, timeout_ms, enabled)
      VALUES ('custom-local-vllm', 'Local vLLM', 'http://127.0.0.1:18888/v1', 120000, 1)
    `).run();
    const updater = new FreeModelUpdater();

    expect(() => updater.setSelectedProviders(['openrouter'])).toThrow('Unknown or disabled free-model updater provider');
    expect(updater.setSelectedProviders(['custom-local-vllm']).selectedProviders).toEqual(['custom-local-vllm']);
  });

  it('persists selected providers and filters injected discovery to only those providers', async () => {
    insertApiKey('groq');
    const openRouterSpy = vi.fn();
    const groqSpy = vi.fn();
    const updater = new FreeModelUpdater({
      providers: [
        namedProvider('openrouter', [{ id: 'x/free:free' }], openRouterSpy),
        { ...namedProvider('groq', [{ id: 'llama-3.3-70b-versatile' }], groqSpy), detectionPolicy: 'unclassified_all_catalog' },
      ],
      keyResolver: platform => `${platform}-key`,
    });

    updater.setSelectedProviders(['groq']);
    const detected = await updater.detectFreeModels();

    expect(updater.getStatus().selectedProviders).toEqual(['groq']);
    expect(openRouterSpy).not.toHaveBeenCalled();
    expect(groqSpy).toHaveBeenCalledTimes(1);
    expect(detected.map(model => `${model.platform}:${model.modelId}`)).toEqual(['groq:llama-3.3-70b-versatile']);
  });

  it('probes every selected custom endpoint catalog row and returns only responsive models', async () => {
    getDb().prepare(`
      INSERT INTO custom_endpoints (platform, name, base_url, timeout_ms, enabled)
      VALUES ('custom-local-vllm', 'Local vLLM', 'http://127.0.0.1:18888/v1', 120000, 1)
    `).run();
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(Response.json({
      data: [
        { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', name: 'Qwen Coder', context_length: 32768 },
        { id: 'paid/broken-model', name: 'Broken paid model' },
        { id: 'free/by-name', name: 'Free by name' },
        { id: 'priced/free-cost', name: 'Zero cost', pricing: { prompt: '0', completion: '0' } },
      ],
    }) as any);
    const probe = vi.fn(async model => ({ ok: model.modelId !== 'paid/broken-model' }));
    const updater = new FreeModelUpdater({ keyResolver: () => null, probeModel: probe });
    updater.setSelectedProviders(['custom-local-vllm']);

    const detected = await updater.detectFreeModels();

    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:18888/v1/models', expect.objectContaining({ method: 'GET' }));
    expect(probe).toHaveBeenCalledTimes(4);
    expect(probe.mock.calls.map(([model]) => model.modelId).sort()).toEqual([
      'Qwen/Qwen3-Coder-30B-A3B-Instruct',
      'free/by-name',
      'paid/broken-model',
      'priced/free-cost',
    ].sort());
    expect(detected.map(model => `${model.modelId}:${model.detectionMethod}`).sort()).toEqual([
      'Qwen/Qwen3-Coder-30B-A3B-Instruct:unclassified_provider',
      'free/by-name:keyword',
      'priced/free-cost:pricing_tier',
    ].sort());
  });

  it('clamps enable interval to 1-24 hours and computes next run', () => {
    const updater = new FreeModelUpdater({ now: () => new Date('2026-06-01T00:00:00.000Z') });
    updater.enable(99);
    const row = getDb().prepare('SELECT enabled, refresh_interval_hours, next_run_at FROM free_model_updater_settings WHERE id = 1').get() as any;
    expect(row.enabled).toBe(1);
    expect(row.refresh_interval_hours).toBe(24);
    expect(row.next_run_at).toBe('2026-06-02T00:00:00.000Z');
  });

  it('disables updater and clears next run', () => {
    const updater = new FreeModelUpdater({ now: () => new Date('2026-06-01T00:00:00.000Z') });
    updater.enable(6);
    updater.disable();
    expect(updater.getStatus()).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('discovers free models from injected providers without writing catalog rows', async () => {
    insertApiKey('openrouter');
    const updater = new FreeModelUpdater({
      now: () => new Date('2026-06-01T00:00:00.000Z'),
      providers: [provider([
        { id: 'deepseek/deepseek-chat-v3.1:free', displayName: 'DeepSeek free', contextWindow: 131072, pricing: { prompt: '0', completion: '0' } },
        { id: 'paid/model', displayName: 'Paid model' },
      ])],
      keyResolver: () => 'test-key',
    });
    updater.setSelectedProviders(['openrouter']);

    const detected = await updater.detectFreeModels();
    expect(detected.map(model => model.modelId)).toEqual(['deepseek/deepseek-chat-v3.1:free']);

    const row = getDb().prepare("SELECT id FROM models WHERE platform = 'openrouter' AND model_id = 'deepseek/deepseek-chat-v3.1:free'").get();
    expect(row).toBeUndefined();
  });

  it('upserts detected models and creates fallback plus metadata rows', async () => {
    insertApiKey('openrouter');
    const updater = new FreeModelUpdater({
      now: () => new Date('2026-06-01T00:00:00.000Z'),
      providers: [provider([{ id: 'free/model:free', displayName: 'Free Model', contextWindow: 1234, pricing: { prompt: '0', completion: '0' } }])],
      keyResolver: () => 'test-key',
      probeModel: async () => ({ ok: true, latencyMs: 10, sample: 'harbor-ok' }),
    });
    updater.setSelectedProviders(['openrouter']);

    const result = await updater.refreshNow();
    expect(result.detectedCount).toBe(1);

    const modelRow = getDb().prepare("SELECT * FROM models WHERE platform = 'openrouter' AND model_id = 'free/model:free'").get() as any;
    expect(modelRow.display_name).toBe('Free Model');
    expect(modelRow.enabled).toBe(1);

    const fallback = getDb().prepare('SELECT * FROM fallback_config WHERE model_db_id = ?').get(modelRow.id);
    expect(fallback).toBeTruthy();

    const metadata = getDb().prepare('SELECT * FROM model_free_metadata WHERE model_id = ?').get(modelRow.id) as any;
    expect(metadata.verification_status).toBe('verified');
    expect(metadata.detection_method).toBe('keyword');
  });

  it('does not expire unselected provider models during scoped refresh', async () => {
    insertApiKey('openrouter');
    const db = getDb();
    const openrouter = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled)
      VALUES ('openrouter', 'old/free:free', 'Old OpenRouter', 1, 1, 'Free', 'auto', 1)
    `).run();
    const groq = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled)
      VALUES ('groq', 'old-groq', 'Old Groq', 1, 1, 'Free', 'auto', 1)
    `).run();
    const metadata = db.prepare(`
      INSERT INTO model_free_metadata (model_id, detected_via_updater, created_by_updater, detection_method, verification_status)
      VALUES (?, 1, 1, 'keyword', 'verified')
    `);
    metadata.run(Number(openrouter.lastInsertRowid));
    metadata.run(Number(groq.lastInsertRowid));

    const updater = new FreeModelUpdater({
      providers: [
        namedProvider('openrouter', []),
        { ...namedProvider('groq', []), detectionPolicy: 'unclassified_all_catalog' },
      ],
      keyResolver: () => 'test-key',
    });
    updater.setSelectedProviders(['openrouter']);

    await updater.refreshNow();

    const openrouterRow = db.prepare('SELECT enabled FROM models WHERE id = ?').get(Number(openrouter.lastInsertRowid)) as any;
    const openrouterMeta = db.prepare('SELECT verification_status FROM model_free_metadata WHERE model_id = ?').get(Number(openrouter.lastInsertRowid)) as any;
    const groqRow = db.prepare('SELECT enabled FROM models WHERE id = ?').get(Number(groq.lastInsertRowid)) as any;
    const groqMeta = db.prepare('SELECT verification_status FROM model_free_metadata WHERE model_id = ?').get(Number(groq.lastInsertRowid)) as any;
    expect(openrouterRow.enabled).toBe(0);
    expect(openrouterMeta.verification_status).toBe('expired');
    expect(groqRow.enabled).toBe(1);
    expect(groqMeta.verification_status).toBe('verified');
  });

  it('disables stale custom endpoint models missing from a successful selected catalog refresh', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO custom_endpoints (platform, name, base_url, timeout_ms, enabled)
      VALUES ('custom-local-vllm', 'Local vLLM', 'http://127.0.0.1:18888/v1', 120000, 1)
    `).run();
    const stale = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled)
      VALUES ('custom-local-vllm', 'stale-model', 'Stale', 1, 1, 'Custom', 'custom', 1)
    `).run();
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(Response.json({ data: [{ id: 'fresh-model' }, { id: 'paid-broken-model' }] }) as any);
    const updater = new FreeModelUpdater({
      keyResolver: () => null,
      probeModel: async model => ({ ok: model.modelId === 'fresh-model' }),
    });
    updater.setSelectedProviders(['custom-local-vllm']);

    await updater.refreshNow();

    const staleRow = db.prepare('SELECT enabled FROM models WHERE id = ?').get(Number(stale.lastInsertRowid)) as any;
    const staleMeta = db.prepare('SELECT verification_status FROM model_free_metadata WHERE model_id = ?').get(Number(stale.lastInsertRowid)) as any;
    const fresh = db.prepare("SELECT enabled, monthly_token_budget FROM models WHERE platform = 'custom-local-vllm' AND model_id = 'fresh-model'").get() as any;
    const failed = db.prepare("SELECT id FROM models WHERE platform = 'custom-local-vllm' AND model_id = 'paid-broken-model'").get();
    expect(fresh.enabled).toBe(1);
    expect(fresh.monthly_token_budget).toBe('auto-discovered custom endpoint');
    expect(failed).toBeUndefined();
    expect(staleRow.enabled).toBe(0);
    expect(staleMeta.verification_status).toBe('expired');
  });

  it('marks discovered models no_key when no provider key is available', async () => {
    insertApiKey('groq');
    const updater = new FreeModelUpdater({
      providers: [{ ...namedProvider('groq', [{ id: 'llama-3.3-70b-versatile' }]), detectionPolicy: 'account_free_tier_catalog' }],
      keyResolver: () => null,
    });
    updater.setSelectedProviders(['groq']);

    await updater.refreshNow();
    const modelRow = getDb().prepare("SELECT id FROM models WHERE platform = 'groq' AND model_id = 'llama-3.3-70b-versatile'").get() as any;
    const metadata = getDb().prepare('SELECT verification_status FROM model_free_metadata WHERE model_id = ?').get(modelRow.id) as any;
    expect(metadata.verification_status).toBe('no_key');
  });

  it('disables an updater-created model after three probe failures', async () => {
    insertApiKey('openrouter');
    const updater = new FreeModelUpdater({
      providers: [provider([{ id: 'x/free:free', pricing: { prompt: '0', completion: '0' } }])],
      keyResolver: () => 'test-key',
      probeModel: async () => ({ ok: false, message: 'upstream 404' }),
    });
    updater.setSelectedProviders(['openrouter']);

    await updater.refreshNow();
    await updater.refreshNow();
    await updater.refreshNow();

    const modelRow = getDb().prepare("SELECT id, enabled FROM models WHERE platform = 'openrouter' AND model_id = 'x/free:free'").get() as any;
    const metadata = getDb().prepare('SELECT verification_status, consecutive_failures FROM model_free_metadata WHERE model_id = ?').get(modelRow.id) as any;
    expect(metadata.verification_status).toBe('unavailable');
    expect(metadata.consecutive_failures).toBe(3);
    expect(modelRow.enabled).toBe(0);
  });

  it('records error status when refresh throws', async () => {
    insertApiKey('openrouter');
    const updater = new FreeModelUpdater({
      providers: [{ platform: 'openrouter', name: 'OpenRouter', listModels: async () => { throw new Error('catalog down'); } }],
      keyResolver: () => 'test-key',
      failRefreshOnProviderError: true,
    });
    updater.setSelectedProviders(['openrouter']);

    await expect(updater.refreshNow()).rejects.toThrow('catalog down');
    expect(updater.getStatus()).toMatchObject({ status: 'error', errorMessage: expect.stringContaining('catalog down') });
  });

  it('does not run overlapping refreshes', async () => {
    insertApiKey('openrouter');
    let release!: () => void;
    const blocker = new Promise<void>(resolve => { release = resolve; });
    const updater = new FreeModelUpdater({
      providers: [{ platform: 'openrouter', name: 'OpenRouter', listModels: async () => { await blocker; return []; } }],
      keyResolver: () => 'test-key',
    });
    updater.setSelectedProviders(['openrouter']);

    const first = updater.refreshNow();
    const second = updater.refreshNow();
    release();
    await first;
    await expect(second).resolves.toMatchObject({ success: false, skipped: true });
  });

  it('schedules refresh when enabled and stops cleanly', async () => {
    insertApiKey('openrouter');
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue({ ok: true });
    const updater = new FreeModelUpdater({
      now: () => new Date('2026-06-01T00:00:00.000Z'),
      providers: [provider([{ id: 'x/free:free', pricing: { prompt: '0', completion: '0' } }])],
      keyResolver: () => 'test-key',
      probeModel: refresh,
    });
    updater.setSelectedProviders(['openrouter']);

    updater.enable(1);
    updater.start();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(refresh).toHaveBeenCalledTimes(1);

    updater.stop();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
