import type {
  DetectedFreeModel,
  FreeModelUpdaterStatus,
  Platform,
} from '@llmharbor/shared/types.js';
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import type { ProviderCatalogModel } from '../providers/base.js';
import { getAllProviders, getProvider } from '../providers/index.js';
import {
  ANONYMOUS_MODEL_CATALOG_PLATFORMS,
  freeModelPolicyForPlatform,
  isFreeModelProvider,
} from '../lib/providerFreeModels.js';
import { filterFreeModels } from './freeModelFilters.js';

const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 24;
const DEFAULT_INTERVAL_HOURS = 6;
const PROBE_CONCURRENCY = 3;
const FAILURES_TO_DISABLE = 3;

export interface DiscoveryProvider {
  platform: Platform;
  name: string;
  listModels(apiKey: string): Promise<ProviderCatalogModel[]>;
}

type KeyResolver = (platform: Platform) => string | null;

type ProbeResult = {
  ok: boolean;
  latencyMs?: number;
  sample?: string;
  message?: string;
  noKey?: boolean;
};

type ProbeModel = (model: DetectedFreeModel) => Promise<ProbeResult>;

export interface FreeModelRefreshResult {
  success: boolean;
  detectedCount: number;
  skipped?: boolean;
}

export interface FreeModelUpdaterOptions {
  now?: () => Date;
  providers?: DiscoveryProvider[];
  keyResolver?: KeyResolver;
  probeModel?: ProbeModel;
  failRefreshOnProviderError?: boolean;
}

function clampInterval(hours: number | undefined): number {
  if (!Number.isFinite(hours)) return DEFAULT_INTERVAL_HOURS;
  return Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Math.trunc(hours!)));
}

function rowToStatus(row: any): FreeModelUpdaterStatus {
  return {
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    refreshIntervalHours: row.refresh_interval_hours,
    status: row.status,
    detectedCount: row.detected_count,
    errorMessage: row.error_message,
  };
}

function shortError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

function defaultKeyResolver(platform: Platform): string | null {
  const row = getDb().prepare(`
    SELECT encrypted_key, iv, auth_tag
      FROM api_keys
     WHERE platform = ?
       AND enabled = 1
       AND (status IN ('healthy', 'unknown') OR source = 'oauth')
     ORDER BY CASE status WHEN 'healthy' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END, id DESC
     LIMIT 1
  `).get(platform) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
  if (!row) return null;
  try {
    return decrypt(row.encrypted_key, row.iv, row.auth_tag);
  } catch {
    return null;
  }
}

function defaultProviders(): DiscoveryProvider[] {
  return getAllProviders()
    .filter(provider => isFreeModelProvider(String(provider.platform)))
    .map(provider => ({
      platform: provider.platform,
      name: provider.name,
      listModels: apiKey => provider.listModels(apiKey),
    }));
}

function rankFor(modelId: string): { intelligenceRank: number; speedRank: number; sizeLabel: string } {
  const lower = modelId.toLowerCase();
  if (lower.includes('qwen') || lower.includes('deepseek') || lower.includes('nemotron')) {
    return { intelligenceRank: 20, speedRank: 6, sizeLabel: 'Free' };
  }
  if (lower.includes('gpt-oss') || lower.includes('codestral')) {
    return { intelligenceRank: 24, speedRank: 7, sizeLabel: 'Free' };
  }
  if (lower.includes('llama')) {
    return { intelligenceRank: 28, speedRank: 7, sizeLabel: 'Free' };
  }
  return { intelligenceRank: 50, speedRank: 50, sizeLabel: 'Free' };
}

function ensureFallback(modelDbId: number): void {
  const db = getDb();
  const existing = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelDbId);
  if (existing) return;
  const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelDbId, maxPriority + 1);
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(workers);
}

export class FreeModelUpdater {
  private readonly now: () => Date;
  private readonly providers?: DiscoveryProvider[];
  private readonly keyResolver: KeyResolver;
  private readonly injectedProbeModel?: ProbeModel;
  private readonly failRefreshOnProviderError: boolean;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: FreeModelUpdaterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.providers = options.providers;
    this.keyResolver = options.keyResolver ?? defaultKeyResolver;
    this.injectedProbeModel = options.probeModel;
    this.failRefreshOnProviderError = options.failRefreshOnProviderError ?? false;
  }

  getStatus(): FreeModelUpdaterStatus {
    const row = getDb().prepare('SELECT * FROM free_model_updater_settings WHERE id = 1').get() as any;
    return rowToStatus(row);
  }

  enable(refreshIntervalHours?: number): FreeModelUpdaterStatus {
    const interval = clampInterval(refreshIntervalHours);
    const nextRunAt = new Date(this.now().getTime() + interval * 60 * 60 * 1000).toISOString();
    getDb().prepare(`
      UPDATE free_model_updater_settings
         SET enabled = 1,
             refresh_interval_hours = ?,
             next_run_at = ?,
             status = 'idle',
             error_message = NULL,
             updated_at = datetime('now')
       WHERE id = 1
    `).run(interval, nextRunAt);
    if (this.intervalId) this.start();
    return this.getStatus();
  }

  disable(): FreeModelUpdaterStatus {
    getDb().prepare(`
      UPDATE free_model_updater_settings
         SET enabled = 0,
             next_run_at = NULL,
             status = 'idle',
             updated_at = datetime('now')
       WHERE id = 1
    `).run();
    this.stop();
    return this.getStatus();
  }

  start(): void {
    const status = this.getStatus();
    if (!status.enabled) return;
    this.stop();
    this.intervalId = setInterval(() => {
      if (!this.getStatus().enabled) return;
      this.refreshNow().catch(error => console.error('[FreeModelUpdater] refresh failed:', error));
    }, status.refreshIntervalHours * 60 * 60 * 1000);
    this.intervalId.unref?.();
  }

  stop(): void {
    if (!this.intervalId) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  async detectFreeModels(): Promise<DetectedFreeModel[]> {
    const providers = this.providers ?? defaultProviders();
    const detected: DetectedFreeModel[] = [];
    const errors: string[] = [];

    for (const provider of providers) {
      const platform = String(provider.platform);
      const policy = freeModelPolicyForPlatform(platform);
      const key = this.keyResolver(provider.platform);
      const canListAnonymously = this.providers !== undefined || ANONYMOUS_MODEL_CATALOG_PLATFORMS.has(platform);
      let catalog: ProviderCatalogModel[] = [];

      if (key || canListAnonymously) {
        try {
          catalog = await provider.listModels(key ?? '');
        } catch (error) {
          errors.push(`${platform}: ${shortError(error)}`);
          if (this.failRefreshOnProviderError) throw error;
        }
      }

      if (!policy && catalog.length === 0) continue;
      for (const model of filterFreeModels(provider.platform, catalog)) {
        detected.push({
          platform: model.platform,
          modelId: model.modelId,
          displayName: model.displayName,
          detectionMethod: model.detectionMethod,
          verificationStatus: 'pending',
          contextWindow: model.contextWindow,
          lastVerifiedAt: null,
          lastError: null,
        });
      }
    }

    if (detected.length === 0 && errors.length > 0) {
      throw new Error(`Free model discovery failed: ${errors.join('; ')}`);
    }

    return detected;
  }

  private upsertDetectedModel(model: DetectedFreeModel): number {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
      .get(model.platform, model.modelId) as { id: number } | undefined;
    const ranks = rankFor(model.modelId);
    let modelDbId: number;

    if (existing) {
      modelDbId = existing.id;
      db.prepare(`
        UPDATE models
           SET display_name = ?,
               context_window = COALESCE(?, context_window),
               monthly_token_budget = CASE
                 WHEN monthly_token_budget = '' OR monthly_token_budget = 'custom' THEN 'auto-discovered free tier'
                 ELSE monthly_token_budget
               END
         WHERE id = ?
      `).run(model.displayName, model.contextWindow, modelDbId);
    } else {
      const result = db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'auto-discovered free tier', ?, 1)
      `).run(
        model.platform,
        model.modelId,
        model.displayName,
        ranks.intelligenceRank,
        ranks.speedRank,
        ranks.sizeLabel,
        model.contextWindow,
      );
      modelDbId = Number(result.lastInsertRowid);
    }

    ensureFallback(modelDbId);
    db.prepare(`
      INSERT INTO model_free_metadata (model_id, detected_via_updater, created_by_updater, detection_method, verification_status, last_seen_at)
      VALUES (?, 1, ?, ?, 'pending', ?)
      ON CONFLICT(model_id) DO UPDATE SET
        detected_via_updater = 1,
        detection_method = excluded.detection_method,
        last_seen_at = excluded.last_seen_at
    `).run(modelDbId, existing ? 0 : 1, model.detectionMethod, this.now().toISOString());

    return modelDbId;
  }

  private async defaultProbeModel(model: DetectedFreeModel): Promise<ProbeResult> {
    const apiKey = this.keyResolver(model.platform);
    if (!apiKey) return { ok: false, noKey: true, message: 'No enabled key available for probe.' };

    const provider = getProvider(String(model.platform));
    if (!provider) return { ok: false, message: `No provider registered for ${model.platform}.` };

    const started = Date.now();
    try {
      const completion = await provider.chatCompletion(apiKey, [
        { role: 'system', content: 'Reply with exactly: harbor-ok' },
        { role: 'user', content: 'LLMHarbor free model probe.' },
      ], model.modelId, { temperature: 0, max_tokens: 16 });
      const content = completion.choices?.[0]?.message?.content;
      return {
        ok: true,
        latencyMs: Date.now() - started,
        sample: typeof content === 'string' ? content : JSON.stringify(content ?? ''),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: shortError(error),
      };
    }
  }

  private applyProbeResult(modelDbId: number, probe: ProbeResult): void {
    const db = getDb();
    const current = db.prepare('SELECT consecutive_failures, created_by_updater FROM model_free_metadata WHERE model_id = ?')
      .get(modelDbId) as { consecutive_failures: number; created_by_updater: number } | undefined;
    const now = this.now().toISOString();

    if (probe.ok) {
      db.prepare(`
        UPDATE model_free_metadata
           SET verification_status = 'verified',
               consecutive_failures = 0,
               last_verified_at = ?,
               last_error = NULL
         WHERE model_id = ?
      `).run(now, modelDbId);
      if (current?.created_by_updater === 1) {
        db.prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(modelDbId);
      }
      return;
    }

    if (probe.noKey) {
      db.prepare(`
        UPDATE model_free_metadata
           SET verification_status = 'no_key',
               last_error = ?
         WHERE model_id = ?
      `).run(probe.message ?? 'No enabled key available for probe.', modelDbId);
      return;
    }

    const failures = (current?.consecutive_failures ?? 0) + 1;
    const unavailable = failures >= FAILURES_TO_DISABLE;
    db.prepare(`
      UPDATE model_free_metadata
         SET verification_status = ?,
             consecutive_failures = ?,
             last_error = ?
       WHERE model_id = ?
    `).run(unavailable ? 'unavailable' : 'pending', failures, probe.message ?? 'Probe failed.', modelDbId);

    if (unavailable && current?.created_by_updater === 1) {
      db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(modelDbId);
    }
  }

  private expireMissingModels(seenModelDbIds: number[]): void {
    const db = getDb();
    const rows = db.prepare(`
      SELECT model_id, created_by_updater
        FROM model_free_metadata
       WHERE detected_via_updater = 1
    `).all() as { model_id: number; created_by_updater: number }[];
    const seen = new Set(seenModelDbIds);
    for (const row of rows) {
      if (seen.has(row.model_id)) continue;
      db.prepare("UPDATE model_free_metadata SET verification_status = 'expired', last_error = 'Model was not present in the latest free-model discovery run.' WHERE model_id = ?").run(row.model_id);
      if (row.created_by_updater === 1) db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(row.model_id);
    }
  }

  async refreshNow(): Promise<FreeModelRefreshResult> {
    if (this.running) {
      return { success: false, skipped: true, detectedCount: this.getStatus().detectedCount };
    }

    this.running = true;
    const startedAt = this.now().toISOString();
    getDb().prepare(`
      UPDATE free_model_updater_settings
         SET status = 'running', error_message = NULL, updated_at = datetime('now')
       WHERE id = 1
    `).run();

    try {
      const detected = await this.detectFreeModels();
      const modelDbIds: number[] = [];
      for (const model of detected) {
        modelDbIds.push(this.upsertDetectedModel(model));
      }

      const probe = this.injectedProbeModel ?? (model => this.defaultProbeModel(model));
      await runWithConcurrency(detected.map((model, index) => ({ model, modelDbId: modelDbIds[index] })), PROBE_CONCURRENCY, async item => {
        const result = await probe(item.model);
        this.applyProbeResult(item.modelDbId, result);
      });

      this.expireMissingModels(modelDbIds);
      const status = this.getStatus();
      const nextRunAt = status.enabled
        ? new Date(this.now().getTime() + status.refreshIntervalHours * 60 * 60 * 1000).toISOString()
        : null;
      getDb().prepare(`
        UPDATE free_model_updater_settings
           SET status = 'idle',
               error_message = NULL,
               last_run_at = ?,
               next_run_at = ?,
               detected_count = ?,
               updated_at = datetime('now')
         WHERE id = 1
      `).run(startedAt, nextRunAt, detected.length);
      return { success: true, detectedCount: detected.length };
    } catch (error) {
      getDb().prepare(`
        UPDATE free_model_updater_settings
           SET status = 'error',
               error_message = ?,
               updated_at = datetime('now')
         WHERE id = 1
      `).run(shortError(error));
      throw error;
    } finally {
      this.running = false;
    }
  }
}

export const freeModelUpdater = new FreeModelUpdater();

export function startFreeModelUpdater(): void {
  freeModelUpdater.start();
}

export function stopFreeModelUpdater(): void {
  freeModelUpdater.stop();
}
