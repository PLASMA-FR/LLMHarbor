import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { FreeModelUpdater, type DiscoveryProvider } from '../../services/freeModelUpdater.js';

const provider = (models: Array<{ id: string; displayName?: string; contextWindow?: number | null }>): DiscoveryProvider => ({
  platform: 'openrouter',
  name: 'OpenRouter',
  listModels: async () => models,
});

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
    });
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
    const updater = new FreeModelUpdater({
      now: () => new Date('2026-06-01T00:00:00.000Z'),
      providers: [provider([
        { id: 'deepseek/deepseek-chat-v3.1:free', displayName: 'DeepSeek free', contextWindow: 131072 },
        { id: 'paid/model', displayName: 'Paid model' },
      ])],
      keyResolver: () => 'test-key',
    });

    const detected = await updater.detectFreeModels();
    expect(detected.map(model => model.modelId)).toEqual(['deepseek/deepseek-chat-v3.1:free']);

    const row = getDb().prepare("SELECT id FROM models WHERE platform = 'openrouter' AND model_id = 'deepseek/deepseek-chat-v3.1:free'").get();
    expect(row).toBeUndefined();
  });

  it('upserts detected models and creates fallback plus metadata rows', async () => {
    const updater = new FreeModelUpdater({
      now: () => new Date('2026-06-01T00:00:00.000Z'),
      providers: [provider([{ id: 'free/model:free', displayName: 'Free Model', contextWindow: 1234 }])],
      keyResolver: () => 'test-key',
      probeModel: async () => ({ ok: true, latencyMs: 10, sample: 'harbor-ok' }),
    });

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

  it('marks discovered models no_key when no provider key is available', async () => {
    const updater = new FreeModelUpdater({
      providers: [provider([{ id: 'x/free:free' }])],
      keyResolver: () => null,
    });

    await updater.refreshNow();
    const modelRow = getDb().prepare("SELECT id FROM models WHERE platform = 'openrouter' AND model_id = 'x/free:free'").get() as any;
    const metadata = getDb().prepare('SELECT verification_status FROM model_free_metadata WHERE model_id = ?').get(modelRow.id) as any;
    expect(metadata.verification_status).toBe('no_key');
  });

  it('disables an updater-created model after three probe failures', async () => {
    const updater = new FreeModelUpdater({
      providers: [provider([{ id: 'x/free:free' }])],
      keyResolver: () => 'test-key',
      probeModel: async () => ({ ok: false, message: 'upstream 404' }),
    });

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
    const updater = new FreeModelUpdater({
      providers: [{ platform: 'openrouter', name: 'OpenRouter', listModels: async () => { throw new Error('catalog down'); } }],
      keyResolver: () => 'test-key',
      failRefreshOnProviderError: true,
    });

    await expect(updater.refreshNow()).rejects.toThrow('catalog down');
    expect(updater.getStatus()).toMatchObject({ status: 'error', errorMessage: expect.stringContaining('catalog down') });
  });

  it('does not run overlapping refreshes', async () => {
    let release!: () => void;
    const blocker = new Promise<void>(resolve => { release = resolve; });
    const updater = new FreeModelUpdater({
      providers: [{ platform: 'openrouter', name: 'OpenRouter', listModels: async () => { await blocker; return []; } }],
      keyResolver: () => 'test-key',
    });

    const first = updater.refreshNow();
    const second = updater.refreshNow();
    release();
    await first;
    await expect(second).resolves.toMatchObject({ success: false, skipped: true });
  });

  it('schedules refresh when enabled and stops cleanly', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue({ ok: true });
    const updater = new FreeModelUpdater({
      now: () => new Date('2026-06-01T00:00:00.000Z'),
      providers: [provider([{ id: 'x/free:free' }])],
      keyResolver: () => 'test-key',
      probeModel: refresh,
    });

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
