# Constant Free Model Updater Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build a user-controlled background updater that discovers free/no-card LLM models, filters and probes them safely, syncs them into LLMHarbor's catalog, and exposes status/control in Settings.

**Architecture:** Add a server-side service that discovers provider model catalogs, applies provider-specific free-model filters, upserts verified candidates into the existing `models` and `fallback_config` tables, and stores updater state/metadata in new SQLite tables. Use the existing Express dashboard API and React Query Settings page for controls; use `setInterval` like the existing health checker rather than adding `node-cron`.

**Tech Stack:** TypeScript, Node/Express 5, better-sqlite3, Vitest, React 19, React Query, existing shadcn/base-ui components.

---

## Current context / assumptions

- Workspace: `/home/ubuntu/LLMHarbor`.
- Existing scripts: `npm run test`, `npm run build` from the repo root.
- Server package has no scheduler dependency and already uses `setInterval` in `server/src/services/health.ts`; follow that pattern.
- Existing dashboard/control-plane routes are mounted in `server/src/app.ts`; they are local-only/trusted-network gated before `/api/*`.
- Existing model catalog lives in `server/src/db/index.ts` table `models`, with fallback routing rows in `fallback_config`.
- Existing provider registry lives in `server/src/providers/index.ts`; most target providers are `OpenAICompatProvider` instances.
- Existing custom endpoint model add/probe flow in `server/src/routes/endpoints.ts` is the best local pattern for model upsert and probe behavior.
- Current routing requires at least one enabled `api_keys` row for a provider to route traffic. The updater may discover/catalog free models without keys, but should mark probe status `pending`/`no_key` until a key or anonymous-placeholder key exists.
- Do not silently create upstream API keys for anonymous providers. If Pollinations/LLM7/Kilo can be called with a placeholder value, document/UI should say the user can add a key value like `anonymous`; the updater should not invent credentials behind the user's back.
- Coverage target is requested, but `server/package.json` currently has Vitest only and no coverage provider. If enforcing coverage in CI/scripts, add `@vitest/coverage-v8` as a server dev dependency in an implementation task.

## Proposed approach

1. Add durable settings and metadata tables:
   - `free_model_updater_settings`: singleton row with enabled flag, interval, timestamps, status, error, detected count.
   - `model_free_metadata`: one row per catalog model that was discovered/managed by the updater, with detection method, verification state, failure count, timestamps, and last error.
2. Add model listing support to providers:
   - Add a `ProviderCatalogModel` type and default `listModels()` method to `BaseProvider`.
   - Override `listModels()` in `OpenAICompatProvider` to call `/models` with provider headers.
   - Keep non-OpenAI providers returning `[]` unless explicitly implemented later.
3. Add deterministic free-model filtering:
   - `server/src/lib/providerFreeModels.ts` contains known no-card/free catalogs and provider policies.
   - `server/src/services/freeModelFilters.ts` converts raw provider catalog rows into `DetectedFreeModel` candidates and records why each model was included.
4. Add an updater service:
   - `server/src/services/freeModelUpdater.ts` orchestrates dry-run discovery, refresh runs, DB sync, probe attempts, stale/failure handling, and scheduling.
   - Use dependency injection (`now`, `fetch`, provider list, timers) where useful so tests do not rely on live network calls or real timers.
5. Add dashboard API routes:
   - Mount `server/src/routes/freeModelUpdater.ts` at `/api/settings/free-model-updater`.
6. Add Settings UI section:
   - Show status, detected count, last/next run, interval control, enable switch, manual refresh button, and preview list.
7. Add tests first, then implementation:
   - Unit tests for filters.
   - Unit tests for updater DB/scheduler/probe behavior using fake providers and `:memory:` DB.
   - Route tests for API contracts.
   - Existing build/test commands for full validation.

## Files likely to change

Create:
- `server/src/lib/providerFreeModels.ts`
- `server/src/services/freeModelFilters.ts`
- `server/src/services/freeModelUpdater.ts`
- `server/src/routes/freeModelUpdater.ts`
- `server/src/__tests__/services/freeModelFilters.test.ts`
- `server/src/__tests__/services/freeModelUpdater.test.ts`
- `server/src/__tests__/routes/freeModelUpdater.test.ts`

Modify:
- `server/src/db/index.ts`
- `server/src/providers/base.ts`
- `server/src/providers/openai-compat.ts`
- `server/src/app.ts`
- `server/src/index.ts`
- `shared/types.ts`
- `client/src/pages/SettingsPage.tsx`
- `server/package.json` and root lockfile only if coverage enforcement is added.

---

## Task 1: Add shared updater API types

**Objective:** Define the API contracts once in `shared/types.ts` so routes and UI use the same shapes.

**Files:**
- Modify: `shared/types.ts`

**Step 1: Add failing type-use compile target**

Before implementation, add server route/UI code later that imports these types and run `npm run build -w server`; it should fail until these types exist.

**Step 2: Add these types near the analytics/rate-limit types**

```ts
// ---- Free Model Updater Types ----
export type FreeModelDetectionMethod =
  | 'pricing_tier'
  | 'keyword'
  | 'hardcoded_list'
  | 'unclassified_provider';

export type FreeModelVerificationStatus =
  | 'pending'
  | 'verified'
  | 'unavailable'
  | 'expired'
  | 'no_key';

export type FreeModelUpdaterRunStatus = 'idle' | 'running' | 'error';

export interface FreeModelUpdaterStatus {
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  refreshIntervalHours: number;
  status: FreeModelUpdaterRunStatus;
  detectedCount: number;
  errorMessage: string | null;
}

export interface FreeModelUpdaterSettings extends FreeModelUpdaterStatus {}

export interface DetectedFreeModel {
  platform: Platform;
  modelId: string;
  displayName: string;
  detectionMethod: FreeModelDetectionMethod;
  verificationStatus: FreeModelVerificationStatus;
  contextWindow: number | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
}
```

**Step 3: Run focused build**

Run: `npm run build -w shared`

Expected: PASS.

**Optional commit only if the user authorized commits:**

```bash
git add shared/types.ts
git commit -m "feat: add free model updater shared types"
```

---

## Task 2: Add idempotent SQLite tables for updater state

**Objective:** Persist updater settings and per-model free-discovery metadata.

**Files:**
- Modify: `server/src/db/index.ts:68-264`
- Test: `server/src/__tests__/db/idempotency.test.ts`

**Step 1: Write failing DB idempotency assertions**

Add a test case to `server/src/__tests__/db/idempotency.test.ts`:

```ts
it('creates free model updater settings and metadata tables idempotently', () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  const db = initDb(':memory:');

  const settings = db.prepare('SELECT * FROM free_model_updater_settings WHERE id = 1').get() as any;
  expect(settings).toBeTruthy();
  expect(settings.enabled).toBe(0);
  expect(settings.refresh_interval_hours).toBe(6);
  expect(settings.status).toBe('idle');

  const metadataColumns = db.prepare('PRAGMA table_info(model_free_metadata)').all() as { name: string }[];
  expect(metadataColumns.map(col => col.name)).toContain('verification_status');
  expect(metadataColumns.map(col => col.name)).toContain('consecutive_failures');
});
```

Run: `npm run test -w server -- server/src/__tests__/db/idempotency.test.ts`

Expected: FAIL because the tables do not exist.

**Step 2: Add schema in `createTables()`**

Add the tables inside the existing `db.exec()` block in `createTables(db)`:

```sql
CREATE TABLE IF NOT EXISTS free_model_updater_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  next_run_at TEXT,
  refresh_interval_hours INTEGER NOT NULL DEFAULT 6,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'error')),
  error_message TEXT,
  detected_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS model_free_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL UNIQUE REFERENCES models(id) ON DELETE CASCADE,
  detected_via_updater INTEGER NOT NULL DEFAULT 1,
  detection_method TEXT NOT NULL CHECK (detection_method IN ('pricing_tier', 'keyword', 'hardcoded_list', 'unclassified_provider')),
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'unavailable', 'expired', 'no_key')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  last_verified_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_model_free_metadata_status ON model_free_metadata(verification_status);
```

Then after `db.exec(...)`, insert the singleton row:

```ts
db.prepare(`
  INSERT OR IGNORE INTO free_model_updater_settings (id, enabled, refresh_interval_hours, status)
  VALUES (1, 0, 6, 'idle')
`).run();
```

**Step 3: Run DB tests**

Run: `npm run test -w server -- server/src/__tests__/db/idempotency.test.ts`

Expected: PASS.

**Optional commit only if authorized.**

---

## Task 3: Add provider catalog listing support

**Objective:** Let the updater ask providers for model catalogs without duplicating provider URL/header knowledge.

**Files:**
- Modify: `server/src/providers/base.ts`
- Modify: `server/src/providers/openai-compat.ts`
- Test: `server/src/__tests__/providers/openai-compat.test.ts`

**Step 1: Write failing provider test**

In `server/src/__tests__/providers/openai-compat.test.ts`, add a test using `vi.spyOn(global, 'fetch')`:

```ts
it('lists OpenAI-compatible /models catalog rows with provider headers', async () => {
  const provider = new OpenAICompatProvider({
    platform: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    extraHeaders: { 'X-Title': 'LLMHarbor' },
  });

  vi.spyOn(global, 'fetch').mockResolvedValueOnce(Response.json({
    data: [
      { id: 'deepseek/deepseek-chat-v3.1:free', name: 'DeepSeek Free', pricing: { prompt: '0', completion: '0' }, context_length: 131072 },
    ],
  }));

  const models = await provider.listModels('or-key');

  expect(global.fetch).toHaveBeenCalledWith(
    'https://openrouter.ai/api/v1/models',
    expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({
        Authorization: 'Bearer or-key',
        'X-Title': 'LLMHarbor',
      }),
    }),
  );
  expect(models[0]).toMatchObject({ id: 'deepseek/deepseek-chat-v3.1:free' });
});
```

Run: `npm run test -w server -- server/src/__tests__/providers/openai-compat.test.ts`

Expected: FAIL because `listModels` does not exist.

**Step 2: Add catalog type and default method**

In `server/src/providers/base.ts`, add:

```ts
export interface ProviderCatalogModel {
  id: string;
  displayName?: string;
  contextWindow?: number | null;
  pricing?: unknown;
  raw?: unknown;
}
```

Inside `BaseProvider` add a default method:

```ts
async listModels(_apiKey: string): Promise<ProviderCatalogModel[]> {
  return [];
}
```

**Step 3: Override in `OpenAICompatProvider`**

Add to `server/src/providers/openai-compat.ts` imports:

```ts
import type { ProviderCatalogModel } from './base.js';
```

Add method inside `OpenAICompatProvider`:

```ts
async listModels(apiKey: string): Promise<ProviderCatalogModel[]> {
  const res = await this.fetchWithTimeout(this.endpoint('/models'), {
    method: 'GET',
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...this.extraHeaders,
    },
  }, 10000);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${this.name} model catalog error ${res.status}: ${text.slice(0, 240) || res.statusText}`);
  }

  const body = await res.json() as any;
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  return rows
    .filter((row: any) => typeof row?.id === 'string' && row.id.length > 0)
    .map((row: any) => ({
      id: row.id,
      displayName: row.name ?? row.display_name ?? row.id,
      contextWindow: typeof row.context_length === 'number'
        ? row.context_length
        : typeof row.context_window === 'number'
          ? row.context_window
          : null,
      pricing: row.pricing ?? row.cost ?? row.limits ?? null,
      raw: row,
    }));
}
```

**Step 4: Run provider tests**

Run: `npm run test -w server -- server/src/__tests__/providers/openai-compat.test.ts`

Expected: PASS.

---

## Task 4: Add known free catalog and provider policy data

**Objective:** Centralize hardcoded no-card/free provider knowledge and avoid burying policy in the updater.

**Files:**
- Create: `server/src/lib/providerFreeModels.ts`
- Test: indirectly via filter tests in Task 5

**Step 1: Create the policy module**

Use `write_file` to create `server/src/lib/providerFreeModels.ts`:

```ts
import type { Platform } from '@llmharbor/shared/types.js';

export interface KnownFreeModel {
  platform: Platform;
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  monthlyTokenBudget: string;
}

export type ProviderFreePolicy = 'priced_catalog' | 'unclassified_all_catalog' | 'hardcoded_then_probe';

export const FREE_MODEL_PROVIDER_POLICIES: Record<string, ProviderFreePolicy> = {
  openrouter: 'priced_catalog',
  cerebras: 'priced_catalog',
  ollama: 'hardcoded_then_probe',
  github: 'hardcoded_then_probe',
  groq: 'unclassified_all_catalog',
  pollinations: 'unclassified_all_catalog',
  llm7: 'unclassified_all_catalog',
  kilo: 'hardcoded_then_probe',
};

export const FREE_MODEL_KEYWORDS = ['free', 'trial', 'open-source', 'opensource'];

export const KNOWN_FREE_MODELS: KnownFreeModel[] = [
  {
    platform: 'pollinations',
    modelId: 'openai-fast',
    displayName: 'OpenAI Fast (Pollinations)',
    contextWindow: null,
    intelligenceRank: 50,
    speedRank: 5,
    sizeLabel: 'Anonymous',
    monthlyTokenBudget: 'anonymous free tier',
  },
  {
    platform: 'llm7',
    modelId: 'gpt-oss-20b',
    displayName: 'GPT-OSS 20B (LLM7)',
    contextWindow: null,
    intelligenceRank: 25,
    speedRank: 6,
    sizeLabel: 'Medium',
    monthlyTokenBudget: '100 req/hr free',
  },
  {
    platform: 'kilo',
    modelId: 'openai/gpt-oss-20b:free',
    displayName: 'GPT-OSS 20B (Kilo free)',
    contextWindow: null,
    intelligenceRank: 25,
    speedRank: 6,
    sizeLabel: 'Medium',
    monthlyTokenBudget: '200 req/hr/IP free',
  },
];

export function knownFreeModelsForPlatform(platform: string): KnownFreeModel[] {
  return KNOWN_FREE_MODELS.filter(model => model.platform === platform);
}
```

**Step 2: Keep this deliberately small**

Do not move the entire static seed catalog here in this task. The updater should use live provider catalogs first and only use this file as fallback/seed knowledge.

**Step 3: Verify TypeScript**

Run: `npm run build -w server`

Expected: PASS after later imports exist; this file alone should be type-valid.

---

## Task 5: Implement provider-specific free model filters with tests

**Objective:** Convert raw catalog rows into consistent free-model candidates and explain each inclusion.

**Files:**
- Create: `server/src/services/freeModelFilters.ts`
- Create: `server/src/__tests__/services/freeModelFilters.test.ts`

**Step 1: Write failing filter tests**

Create `server/src/__tests__/services/freeModelFilters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { filterFreeModels } from '../../services/freeModelFilters.js';

const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, displayName: id, contextWindow: null, raw: extra, ...extra });

describe('free model filters', () => {
  it('identifies OpenRouter :free and zero-price catalog rows', () => {
    const result = filterFreeModels('openrouter', [
      model('deepseek/deepseek-chat-v3.1:free'),
      model('paid/model', { pricing: { prompt: '0.25', completion: '0.50' } }),
      model('zero/model', { pricing: { prompt: '0', completion: '0' } }),
    ]);

    expect(result.map(row => row.modelId)).toEqual(['deepseek/deepseek-chat-v3.1:free', 'zero/model']);
    expect(result[0].detectionMethod).toBe('keyword');
    expect(result[1].detectionMethod).toBe('pricing_tier');
  });

  it('adds all Groq catalog rows as unclassified provider free-tier candidates', () => {
    const result = filterFreeModels('groq', [model('llama-3.3-70b-versatile'), model('openai/gpt-oss-120b')]);
    expect(result).toHaveLength(2);
    expect(result.every(row => row.detectionMethod === 'unclassified_provider')).toBe(true);
  });

  it('uses hardcoded fallback models when a hardcoded provider catalog is empty', () => {
    const result = filterFreeModels('pollinations', []);
    expect(result.map(row => row.modelId)).toContain('openai-fast');
    expect(result.find(row => row.modelId === 'openai-fast')?.detectionMethod).toBe('hardcoded_list');
  });

  it('deduplicates by platform and model id', () => {
    const result = filterFreeModels('openrouter', [model('x/free:free'), model('x/free:free')]);
    expect(result).toHaveLength(1);
  });
});
```

Run: `npm run test -w server -- server/src/__tests__/services/freeModelFilters.test.ts`

Expected: FAIL because the service does not exist.

**Step 2: Implement filter service**

Create `server/src/services/freeModelFilters.ts`:

```ts
import type { Platform, FreeModelDetectionMethod } from '@llmharbor/shared/types.js';
import type { ProviderCatalogModel } from '../providers/base.js';
import {
  FREE_MODEL_KEYWORDS,
  FREE_MODEL_PROVIDER_POLICIES,
  knownFreeModelsForPlatform,
} from '../lib/providerFreeModels.js';

export interface FilteredFreeModel {
  platform: Platform;
  modelId: string;
  displayName: string;
  detectionMethod: FreeModelDetectionMethod;
  contextWindow: number | null;
  raw?: unknown;
}

function numericZero(value: unknown): boolean {
  if (value === 0) return true;
  if (typeof value === 'string' && value.trim() !== '') return Number(value) === 0;
  return false;
}

function hasZeroPricing(pricing: unknown): boolean {
  if (!pricing || typeof pricing !== 'object') return false;
  const obj = pricing as Record<string, unknown>;
  const prompt = obj.prompt ?? obj.input ?? obj.prompt_tokens;
  const completion = obj.completion ?? obj.output ?? obj.completion_tokens;
  if (prompt === undefined && completion === undefined) return false;
  return numericZero(prompt ?? 0) && numericZero(completion ?? 0);
}

function keywordMethod(id: string, displayName: string): FreeModelDetectionMethod | null {
  const haystack = `${id} ${displayName}`.toLowerCase();
  return FREE_MODEL_KEYWORDS.some(keyword => haystack.includes(keyword)) ? 'keyword' : null;
}

function displayNameFor(row: ProviderCatalogModel): string {
  return row.displayName || row.id;
}

function fromKnown(platform: string): FilteredFreeModel[] {
  return knownFreeModelsForPlatform(platform).map(model => ({
    platform: model.platform,
    modelId: model.modelId,
    displayName: model.displayName,
    detectionMethod: 'hardcoded_list',
    contextWindow: model.contextWindow,
  }));
}

export function filterFreeModels(platform: Platform, catalog: ProviderCatalogModel[]): FilteredFreeModel[] {
  const policy = FREE_MODEL_PROVIDER_POLICIES[String(platform)];
  const candidates: FilteredFreeModel[] = [];

  for (const row of catalog) {
    const displayName = displayNameFor(row);
    const keyword = keywordMethod(row.id, displayName);
    const zeroPrice = hasZeroPricing(row.pricing);

    if (policy === 'unclassified_all_catalog') {
      candidates.push({ platform, modelId: row.id, displayName, detectionMethod: 'unclassified_provider', contextWindow: row.contextWindow ?? null, raw: row.raw });
      continue;
    }

    if (zeroPrice) {
      candidates.push({ platform, modelId: row.id, displayName, detectionMethod: 'pricing_tier', contextWindow: row.contextWindow ?? null, raw: row.raw });
      continue;
    }

    if (keyword) {
      candidates.push({ platform, modelId: row.id, displayName, detectionMethod: keyword, contextWindow: row.contextWindow ?? null, raw: row.raw });
    }
  }

  candidates.push(...fromKnown(String(platform)));

  const deduped = new Map<string, FilteredFreeModel>();
  for (const candidate of candidates) {
    const key = `${candidate.platform}:${candidate.modelId}`;
    if (!deduped.has(key)) deduped.set(key, candidate);
  }
  return [...deduped.values()];
}
```

**Step 3: Run filter tests**

Run: `npm run test -w server -- server/src/__tests__/services/freeModelFilters.test.ts`

Expected: PASS.

---

## Task 6: Create updater service skeleton and settings helpers

**Objective:** Add a testable service with status read/write, interval clamping, and no network behavior yet.

**Files:**
- Create: `server/src/services/freeModelUpdater.ts`
- Test: `server/src/__tests__/services/freeModelUpdater.test.ts`

**Step 1: Write failing service tests for settings**

Create `server/src/__tests__/services/freeModelUpdater.test.ts` with initial tests:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { FreeModelUpdater } from '../../services/freeModelUpdater.js';

describe('FreeModelUpdater settings', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    vi.restoreAllMocks();
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
});
```

Run: `npm run test -w server -- server/src/__tests__/services/freeModelUpdater.test.ts`

Expected: FAIL because service does not exist.

**Step 2: Implement minimal service skeleton**

Create `server/src/services/freeModelUpdater.ts` with these exported shapes:

```ts
import type { FreeModelUpdaterStatus } from '@llmharbor/shared/types.js';
import { getDb } from '../db/index.js';

const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 24;
const DEFAULT_INTERVAL_HOURS = 6;

export interface FreeModelUpdaterOptions {
  now?: () => Date;
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

export class FreeModelUpdater {
  private readonly now: () => Date;

  constructor(options: FreeModelUpdaterOptions = {}) {
    this.now = options.now ?? (() => new Date());
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
    return this.getStatus();
  }
}

export const freeModelUpdater = new FreeModelUpdater();
```

**Step 3: Run service tests**

Run: `npm run test -w server -- server/src/__tests__/services/freeModelUpdater.test.ts`

Expected: PASS.

---

## Task 7: Add discovery dry-run behavior

**Objective:** Discover candidates without mutating models so the UI can preview before enabling.

**Files:**
- Modify: `server/src/services/freeModelUpdater.ts`
- Test: `server/src/__tests__/services/freeModelUpdater.test.ts`

**Step 1: Add failing discovery tests**

Extend `freeModelUpdater.test.ts`:

```ts
it('discovers free models from injected providers without writing catalog rows', async () => {
  const updater = new FreeModelUpdater({
    now: () => new Date('2026-06-01T00:00:00.000Z'),
    providers: [{
      platform: 'openrouter',
      name: 'OpenRouter',
      listModels: async () => [
        { id: 'deepseek/deepseek-chat-v3.1:free', displayName: 'DeepSeek free', contextWindow: 131072 },
        { id: 'paid/model', displayName: 'Paid model', pricing: { prompt: '1', completion: '1' } },
      ],
    }],
    keyResolver: () => 'test-key',
  });

  const detected = await updater.detectFreeModels();
  expect(detected.map(model => model.modelId)).toEqual(['deepseek/deepseek-chat-v3.1:free']);

  const row = getDb().prepare("SELECT id FROM models WHERE platform = 'openrouter' AND model_id = 'deepseek/deepseek-chat-v3.1:free'").get();
  expect(row).toBeUndefined();
});
```

Expected: FAIL until `detectFreeModels`, provider injection, and key resolver exist.

**Step 2: Extend service dependencies**

Add minimal interfaces to `freeModelUpdater.ts`:

```ts
import type { Platform, DetectedFreeModel } from '@llmharbor/shared/types.js';
import type { BaseProvider, ProviderCatalogModel } from '../providers/base.js';
import { getAllProviders } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { filterFreeModels } from './freeModelFilters.js';

interface DiscoveryProvider {
  platform: Platform;
  name: string;
  listModels(apiKey: string): Promise<ProviderCatalogModel[]>;
}

type KeyResolver = (platform: Platform) => string | null;
```

Extend options:

```ts
providers?: DiscoveryProvider[];
keyResolver?: KeyResolver;
```

Default key resolver should pick an enabled healthy/unknown key if present:

```ts
function defaultKeyResolver(platform: Platform): string | null {
  const row = getDb().prepare(`
    SELECT encrypted_key, iv, auth_tag
      FROM api_keys
     WHERE platform = ?
       AND enabled = 1
       AND status IN ('healthy', 'unknown')
     ORDER BY CASE status WHEN 'healthy' THEN 0 ELSE 1 END, id DESC
     LIMIT 1
  `).get(platform) as any;
  if (!row) return null;
  try {
    return decrypt(row.encrypted_key, row.iv, row.auth_tag);
  } catch {
    return null;
  }
}
```

**Step 3: Implement dry-run discovery**

Add method:

```ts
async detectFreeModels(): Promise<DetectedFreeModel[]> {
  const providers = this.providers ?? getAllProviders();
  const detected: DetectedFreeModel[] = [];

  for (const provider of providers) {
    const key = this.keyResolver(provider.platform) ?? '';
    let catalog: ProviderCatalogModel[] = [];
    try {
      catalog = await provider.listModels(key);
    } catch (error) {
      catalog = [];
    }

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

  return detected;
}
```

Store `providers` and `keyResolver` in the constructor.

**Step 4: Run service tests**

Run: `npm run test -w server -- server/src/__tests__/services/freeModelUpdater.test.ts`

Expected: PASS.

---

## Task 8: Add DB sync for detected free models

**Objective:** Upsert detected models into `models`, `fallback_config`, and `model_free_metadata` without duplicating catalog rows.

**Files:**
- Modify: `server/src/services/freeModelUpdater.ts`
- Test: `server/src/__tests__/services/freeModelUpdater.test.ts`

**Step 1: Add failing sync test**

```ts
it('upserts detected models and creates fallback plus metadata rows', async () => {
  const updater = new FreeModelUpdater({
    now: () => new Date('2026-06-01T00:00:00.000Z'),
    providers: [{
      platform: 'openrouter',
      name: 'OpenRouter',
      listModels: async () => [{ id: 'free/model:free', displayName: 'Free Model', contextWindow: 1234 }],
    }],
    keyResolver: () => 'test-key',
    probeModel: async () => ({ ok: true, latencyMs: 10, sample: 'harbor-ok' }),
  });

  const result = await updater.refreshNow();
  expect(result.detectedCount).toBe(1);

  const model = getDb().prepare("SELECT * FROM models WHERE platform = 'openrouter' AND model_id = 'free/model:free'").get() as any;
  expect(model.display_name).toBe('Free Model');
  expect(model.enabled).toBe(1);

  const fallback = getDb().prepare('SELECT * FROM fallback_config WHERE model_db_id = ?').get(model.id);
  expect(fallback).toBeTruthy();

  const metadata = getDb().prepare('SELECT * FROM model_free_metadata WHERE model_id = ?').get(model.id) as any;
  expect(metadata.verification_status).toBe('verified');
  expect(metadata.detection_method).toBe('keyword');
});
```

Expected: FAIL until `refreshNow`, upsert, and probe injection exist.

**Step 2: Add upsert helpers**

Add helper functions in `freeModelUpdater.ts`:

```ts
function rankFor(modelId: string): { intelligenceRank: number; speedRank: number; sizeLabel: string } {
  const lower = modelId.toLowerCase();
  if (lower.includes('gpt-oss') || lower.includes('qwen') || lower.includes('deepseek')) return { intelligenceRank: 20, speedRank: 6, sizeLabel: 'Free' };
  if (lower.includes('llama')) return { intelligenceRank: 25, speedRank: 6, sizeLabel: 'Free' };
  return { intelligenceRank: 50, speedRank: 50, sizeLabel: 'Free' };
}

function ensureFallback(modelDbId: number): void {
  const db = getDb();
  const existing = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelDbId);
  if (existing) return;
  const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelDbId, maxPriority + 1);
}
```

Add an `upsertDetectedModel()` method that:

- Inserts into `models` with `monthly_token_budget = 'auto-discovered free tier'`.
- Uses `ON CONFLICT(platform, model_id) DO UPDATE` to update display name, context window, and monthly budget.
- Does not blindly override `models.enabled = 0` on an existing row unless the row is updater-managed and was previously unavailable/expired.
- Inserts/updates `model_free_metadata` with `last_seen_at` and detection method.
- Calls `ensureFallback(modelDbId)`.

**Step 3: Add probe dependency shape**

In options:

```ts
probeModel?: (model: DetectedFreeModel) => Promise<{ ok: boolean; latencyMs?: number; sample?: string; message?: string }>;
```

Default probe behavior will be expanded in Task 9. For this task, if no probe function exists, mark `verificationStatus = 'pending'`.

**Step 4: Implement `refreshNow()`**

`refreshNow()` should:

1. Set settings status to `running`, clear error.
2. Call `detectFreeModels()`.
3. Upsert each detected model.
4. Probe each detected model if `probeModel` exists.
5. Update metadata verification status.
6. Set settings status `idle`, `last_run_at`, `next_run_at`, `detected_count`.
7. On error, set status `error` and `error_message`, then rethrow for route tests.

Expected return:

```ts
{ success: true, detectedCount: number }
```

**Step 5: Run service tests**

Run: `npm run test -w server -- server/src/__tests__/services/freeModelUpdater.test.ts`

Expected: PASS.

---

## Task 9: Implement safe default probe behavior and failure handling

**Objective:** Probe models using existing provider chat completion infrastructure and disable repeatedly failing updater-managed rows.

**Files:**
- Modify: `server/src/services/freeModelUpdater.ts`
- Test: `server/src/__tests__/services/freeModelUpdater.test.ts`

**Step 1: Add failing tests**

Add tests for no-key and repeated failures:

```ts
it('marks discovered models no_key when no provider key is available', async () => {
  const updater = new FreeModelUpdater({
    providers: [{ platform: 'openrouter', name: 'OpenRouter', listModels: async () => [{ id: 'x/free:free' }] }],
    keyResolver: () => null,
  });

  await updater.refreshNow();
  const model = getDb().prepare("SELECT id FROM models WHERE platform = 'openrouter' AND model_id = 'x/free:free'").get() as any;
  const metadata = getDb().prepare('SELECT verification_status FROM model_free_metadata WHERE model_id = ?').get(model.id) as any;
  expect(metadata.verification_status).toBe('no_key');
});

it('disables an updater-managed model after three probe failures', async () => {
  const updater = new FreeModelUpdater({
    providers: [{ platform: 'openrouter', name: 'OpenRouter', listModels: async () => [{ id: 'x/free:free' }] }],
    keyResolver: () => 'test-key',
    probeModel: async () => ({ ok: false, message: 'upstream 404' }),
  });

  await updater.refreshNow();
  await updater.refreshNow();
  await updater.refreshNow();

  const model = getDb().prepare("SELECT id, enabled FROM models WHERE platform = 'openrouter' AND model_id = 'x/free:free'").get() as any;
  const metadata = getDb().prepare('SELECT verification_status, consecutive_failures FROM model_free_metadata WHERE model_id = ?').get(model.id) as any;
  expect(metadata.verification_status).toBe('unavailable');
  expect(metadata.consecutive_failures).toBe(3);
  expect(model.enabled).toBe(0);
});
```

**Step 2: Implement default probe**

Default probe should:

- Resolve a key with `keyResolver(platform)`.
- If no key, return `{ ok: false, message: 'No enabled key available for probe', noKey: true }`.
- Get provider with `getProvider(platform)`.
- Call `provider.chatCompletion(key, [{role:'system', content:'Reply with exactly: harbor-ok'}, {role:'user', content:'LLMHarbor free model probe.'}], model.modelId, { temperature: 0, max_tokens: 16 })`.
- Return `ok: true` if any response is received.
- Catch and return `ok: false` with a short error message.

Keep probe concurrency small: implement a simple `runWithConcurrency(items, 3, worker)` helper; do not add a dependency.

**Step 3: Implement failure metadata updates**

Rules:

- Success: `verification_status='verified'`, `consecutive_failures=0`, `last_verified_at=now`, `last_error=NULL`, `models.enabled=1` for updater-managed rows.
- No key: `verification_status='no_key'`, do not increment `consecutive_failures`, do not disable model.
- Failure count 1-2: `verification_status='pending'`, increment `consecutive_failures`, keep existing `models.enabled` value.
- Failure count >= 3: `verification_status='unavailable'`, increment, set `models.enabled=0` for updater-managed rows.

**Step 4: Run tests**

Run: `npm run test -w server -- server/src/__tests__/services/freeModelUpdater.test.ts`

Expected: PASS.

---

## Task 10: Add scheduler start/stop behavior

**Objective:** Run refreshes on a configurable interval only when enabled, and make it testable/stoppable.

**Files:**
- Modify: `server/src/services/freeModelUpdater.ts`
- Test: `server/src/__tests__/services/freeModelUpdater.test.ts`

**Step 1: Add failing timer tests**

Use fake timers:

```ts
it('schedules refresh when enabled and stops cleanly', async () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue({ success: true, detectedCount: 0 });
  const updater = new FreeModelUpdater({ now: () => new Date('2026-06-01T00:00:00.000Z'), refreshImpl: refresh });

  updater.enable(1);
  updater.start();
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(refresh).toHaveBeenCalledTimes(1);

  updater.stop();
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(refresh).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
```

If adding `refreshImpl` solely for tests feels too much, spy on `refreshNow()` instead.

**Step 2: Implement start/stop**

Add:

```ts
let intervalId: ReturnType<typeof setInterval> | null = null;

start(): void {
  if (intervalId) return;
  const status = this.getStatus();
  if (!status.enabled) return;
  intervalId = setInterval(() => {
    if (!this.getStatus().enabled) return;
    this.refreshNow().catch(error => console.error('[FreeModelUpdater] refresh failed:', error));
  }, status.refreshIntervalHours * 60 * 60 * 1000);
}

stop(): void {
  if (!intervalId) return;
  clearInterval(intervalId);
  intervalId = null;
}
```

When `enable()` is called, restart the timer if already running so interval changes apply.
When `disable()` is called, stop the timer.

Export wrappers:

```ts
export function startFreeModelUpdater(): void {
  freeModelUpdater.start();
}

export function stopFreeModelUpdater(): void {
  freeModelUpdater.stop();
}
```

**Step 3: Run service tests**

Run: `npm run test -w server -- server/src/__tests__/services/freeModelUpdater.test.ts`

Expected: PASS.

---

## Task 11: Add updater API routes

**Objective:** Expose status, enable/disable, manual refresh, and detected-model preview.

**Files:**
- Create: `server/src/routes/freeModelUpdater.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/__tests__/routes/freeModelUpdater.test.ts`

**Step 1: Write failing route tests**

Create `server/src/__tests__/routes/freeModelUpdater.test.ts` using the repo's local `request()` helper pattern:

```ts
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

  it('triggers manual refresh', async () => {
    vi.spyOn(freeModelUpdater, 'refreshNow').mockResolvedValue({ success: true, detectedCount: 3 });
    const res = await request(app, 'POST', '/api/settings/free-model-updater/refresh-now');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, detectedCount: 3 });
  });
});
```

Expected: FAIL until route exists and is mounted.

**Step 2: Implement route module**

Create `server/src/routes/freeModelUpdater.ts`:

```ts
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { freeModelUpdater } from '../services/freeModelUpdater.js';

export const freeModelUpdaterRouter = Router();

const intervalSchema = z.object({
  refreshIntervalHours: z.number().int().min(1).max(24).optional(),
}).strict();

freeModelUpdaterRouter.get('/status', (_req: Request, res: Response) => {
  res.json(freeModelUpdater.getStatus());
});

freeModelUpdaterRouter.post('/enable', (req: Request, res: Response) => {
  const parsed = intervalSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  res.json(freeModelUpdater.enable(parsed.data.refreshIntervalHours));
});

freeModelUpdaterRouter.post('/disable', (_req: Request, res: Response) => {
  res.json(freeModelUpdater.disable());
});

freeModelUpdaterRouter.post('/refresh-now', async (_req: Request, res: Response) => {
  const result = await freeModelUpdater.refreshNow();
  res.json({ ...result, estimatedDuration: 'medium' });
});

freeModelUpdaterRouter.get('/detected-models', async (_req: Request, res: Response) => {
  res.json(await freeModelUpdater.detectFreeModels());
});
```

**Step 3: Mount route in app**

In `server/src/app.ts`, import:

```ts
import { freeModelUpdaterRouter } from './routes/freeModelUpdater.js';
```

Mount before or near the existing settings route:

```ts
app.use('/api/settings/free-model-updater', freeModelUpdaterRouter);
app.use('/api/settings', settingsRouter);
```

**Step 4: Run route tests**

Run: `npm run test -w server -- server/src/__tests__/routes/freeModelUpdater.test.ts`

Expected: PASS.

---

## Task 12: Start updater on server startup

**Objective:** Start the background updater in real server runs without starting timers inside route/app unit tests.

**Files:**
- Modify: `server/src/index.ts`
- Test: existing server tests/build

**Step 1: Modify startup only**

In `server/src/index.ts`, import:

```ts
import { startFreeModelUpdater } from './services/freeModelUpdater.js';
```

Inside `main()`, after `initDb();`, call:

```ts
startFreeModelUpdater();
```

Do not call it from `createApp()`; tests instantiate apps and should not start long-lived timers.

**Step 2: Build server**

Run: `npm run build -w server`

Expected: PASS.

---

## Task 13: Add route and service error handling tests

**Objective:** Ensure provider failures, duplicate refreshes, and invalid settings are safe and transparent.

**Files:**
- Modify: `server/src/__tests__/services/freeModelUpdater.test.ts`
- Modify: `server/src/__tests__/routes/freeModelUpdater.test.ts`
- Modify: `server/src/services/freeModelUpdater.ts`
- Modify: `server/src/routes/freeModelUpdater.ts`

**Step 1: Add tests**

Service cases:

```ts
it('records error status when refresh throws', async () => {
  const updater = new FreeModelUpdater({
    providers: [{ platform: 'openrouter', name: 'OpenRouter', listModels: async () => { throw new Error('catalog down'); } }],
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
  });

  const first = updater.refreshNow();
  const second = updater.refreshNow();
  release();
  await first;
  await expect(second).resolves.toMatchObject({ success: false, skipped: true });
});
```

Route cases:

```ts
it('rejects invalid interval bodies', async () => {
  const res = await request(app, 'POST', '/api/settings/free-model-updater/enable', { refreshIntervalHours: 0 });
  expect(res.status).toBe(400);
});
```

**Step 2: Implement behavior**

- Add `private running = false` guard in `FreeModelUpdater`.
- If already running, return `{ success: false, skipped: true, detectedCount: currentStatus.detectedCount }`.
- Decide whether provider catalog failures are fatal or per-provider warnings. Safer default: per-provider warning for discovery; fatal only if `failRefreshOnProviderError` test option is true. Status should be `idle` if at least one provider succeeds; `error` if all providers fail.

**Step 3: Run tests**

Run:

```bash
npm run test -w server -- server/src/__tests__/services/freeModelUpdater.test.ts server/src/__tests__/routes/freeModelUpdater.test.ts
```

Expected: PASS.

---

## Task 14: Add Settings page UI section

**Objective:** Provide dashboard toggle, interval control, manual refresh, status, and detected-model preview.

**Files:**
- Modify: `client/src/pages/SettingsPage.tsx`
- Uses: `client/src/lib/api.ts`, `client/src/components/ui/switch.tsx`, existing `Button`, `Input`, `Badge`, `SectionTitle`, `SummaryTile`

**Step 1: Add local UI types/imports**

At top of `client/src/pages/SettingsPage.tsx`, add shared imports:

```ts
import type { DetectedFreeModel, FreeModelUpdaterStatus } from '../../../shared/types'
```

Add state near other `useState` calls:

```ts
const [freeUpdaterInterval, setFreeUpdaterInterval] = useState('6')
```

**Step 2: Add queries/mutations**

Inside `SettingsPage()`:

```ts
const { data: freeUpdaterStatus } = useQuery<FreeModelUpdaterStatus>({
  queryKey: ['free-model-updater-status'],
  queryFn: () => apiFetch('/api/settings/free-model-updater/status'),
})

const { data: detectedFreeModels = [], isFetching: detectingFreeModels } = useQuery<DetectedFreeModel[]>({
  queryKey: ['free-model-updater-detected-models'],
  queryFn: () => apiFetch('/api/settings/free-model-updater/detected-models'),
  staleTime: 60_000,
})

const enableFreeUpdater = useMutation({
  mutationFn: (refreshIntervalHours: number) => apiFetch<FreeModelUpdaterStatus>('/api/settings/free-model-updater/enable', {
    method: 'POST',
    body: JSON.stringify({ refreshIntervalHours }),
  }),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['free-model-updater-status'] }),
})

const disableFreeUpdater = useMutation({
  mutationFn: () => apiFetch<FreeModelUpdaterStatus>('/api/settings/free-model-updater/disable', { method: 'POST' }),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['free-model-updater-status'] }),
})

const refreshFreeModels = useMutation({
  mutationFn: () => apiFetch('/api/settings/free-model-updater/refresh-now', { method: 'POST' }),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['free-model-updater-status'] })
    queryClient.invalidateQueries({ queryKey: ['free-model-updater-detected-models'] })
    queryClient.invalidateQueries({ queryKey: ['client-api-key-access-policy'] })
  },
})
```

**Step 3: Add helper**

```ts
function toggleFreeUpdater(enabled: boolean) {
  if (enabled) {
    const parsed = Number.parseInt(freeUpdaterInterval, 10)
    enableFreeUpdater.mutate(Number.isFinite(parsed) ? Math.min(24, Math.max(1, parsed)) : 6)
  } else {
    disableFreeUpdater.mutate()
  }
}
```

**Step 4: Add JSX section near the top, after `<PageHeader />`**

Use existing styling conventions:

```tsx
<section className="panel-card rounded-2xl p-5 sm:p-6">
  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
    <SectionTitle
      title="Free model updater"
      description="Automatically discover no-card/free-tier provider models, probe them, and keep the local catalog fresh."
    />
    <div className="flex flex-wrap items-center gap-3">
      <Label className="text-xs text-muted-foreground">Interval (hours)</Label>
      <Input
        className="h-9 w-24"
        type="number"
        min={1}
        max={24}
        value={freeUpdaterInterval}
        onChange={event => setFreeUpdaterInterval(event.target.value)}
      />
      <Switch
        checked={freeUpdaterStatus?.enabled ?? false}
        onCheckedChange={toggleFreeUpdater}
        disabled={enableFreeUpdater.isPending || disableFreeUpdater.isPending}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={refreshFreeModels.isPending}
        onClick={() => refreshFreeModels.mutate()}
      >
        {refreshFreeModels.isPending ? 'Refreshing…' : 'Refresh now'}
      </Button>
    </div>
  </div>

  <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    <SummaryTile label="Status" value={freeUpdaterStatus?.status ?? 'idle'} detail={freeUpdaterStatus?.enabled ? 'Background refresh enabled.' : 'Background refresh disabled.'} />
    <SummaryTile label="Detected" value={freeUpdaterStatus?.detectedCount ?? detectedFreeModels.length} detail="Free candidates from live catalogs and fallback lists." />
    <SummaryTile label="Last run" value={freeUpdaterStatus?.lastRunAt ? new Date(freeUpdaterStatus.lastRunAt).toLocaleString() : 'Never'} detail="Most recent updater cycle." />
    <SummaryTile label="Next run" value={freeUpdaterStatus?.nextRunAt ? new Date(freeUpdaterStatus.nextRunAt).toLocaleString() : 'Off'} detail="Based on the configured interval." />
  </div>

  {freeUpdaterStatus?.errorMessage && (
    <div className="mt-4 rounded-2xl border border-rose-500/25 bg-rose-500/8 px-3 py-2 text-sm text-rose-700 dark:text-rose-200">
      {freeUpdaterStatus.errorMessage}
    </div>
  )}

  <div className="mt-5 rounded-2xl border border-border bg-background p-4">
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm font-medium">Detected free models preview</p>
      <Badge variant="secondary">{detectingFreeModels ? 'Scanning…' : `${detectedFreeModels.length} candidates`}</Badge>
    </div>
    <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
      {detectedFreeModels.length === 0 ? (
        <EmptyState title="No candidates loaded" description="Add provider keys or run refresh to populate the preview." />
      ) : detectedFreeModels.slice(0, 80).map(model => (
        <div key={`${model.platform}:${model.modelId}`} className="rounded-xl border border-border bg-card px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{model.displayName}</span>
            <Badge variant="outline">{model.platform}</Badge>
            <Badge variant="secondary">{model.detectionMethod}</Badge>
            <Badge variant={model.verificationStatus === 'verified' ? 'default' : 'secondary'}>{model.verificationStatus}</Badge>
          </div>
          <code className="mt-1 block truncate text-muted-foreground">{model.modelId}</code>
          {model.lastError && <p className="mt-1 text-rose-600 dark:text-rose-300">{model.lastError}</p>}
        </div>
      ))}
    </div>
  </div>
</section>
```

**Step 5: Build client**

Run: `npm run build -w client`

Expected: PASS.

---

## Task 15: Add coverage script if the coverage target is mandatory

**Objective:** Make the requested unit/integration coverage target measurable.

**Files:**
- Modify: `server/package.json`
- Modify: root lockfile (`package-lock.json`) after npm install

**Step 1: Check whether coverage provider is already available**

Run:

```bash
npm ls @vitest/coverage-v8 -w server
```

Expected currently: likely missing.

**Step 2: Add dependency only if enforcing coverage now**

Run:

```bash
npm install -D -w server @vitest/coverage-v8
```

Modify `server/package.json` scripts:

```json
"test:coverage": "vitest run --coverage"
```

**Step 3: Run coverage**

Run:

```bash
npm run test:coverage -w server -- server/src/__tests__/services/freeModelFilters.test.ts server/src/__tests__/services/freeModelUpdater.test.ts server/src/__tests__/routes/freeModelUpdater.test.ts
```

Expected: PASS, coverage output generated.

**Risk note:** Do not fail the entire feature solely because unrelated existing files keep global coverage below 85%. If strict coverage is needed, configure per-file or include thresholds for the new updater/filter modules.

---

## Task 16: Full validation and regression pass

**Objective:** Verify the full repo still tests and builds.

**Files:**
- No code changes unless failures expose necessary fixes.

**Step 1: Run targeted tests**

```bash
npm run test -w server -- \
  server/src/__tests__/services/freeModelFilters.test.ts \
  server/src/__tests__/services/freeModelUpdater.test.ts \
  server/src/__tests__/routes/freeModelUpdater.test.ts \
  server/src/__tests__/db/idempotency.test.ts \
  server/src/__tests__/providers/openai-compat.test.ts
```

Expected: PASS.

**Step 2: Run all tests**

```bash
npm run test
```

Expected: PASS.

**Step 3: Run full build**

```bash
npm run build
```

Expected: PASS.

**Step 4: Inspect diff**

```bash
git diff -- server/src shared/types.ts client/src server/package.json package-lock.json
```

Expected: Only intended files changed; no secrets; no unrelated formatting churn.

---

## Risks, tradeoffs, and open questions

- **Provider truth vs. heuristics:** Model names containing `free` are useful but not sufficient. The plan requires successful probe before marking verified and repeated failures before disabling, reducing risk from stale/paid/expired rows.
- **Anonymous providers:** LLMHarbor currently routes only through `api_keys`. The updater should discover anonymous-provider models but mark them `no_key` until the user adds a placeholder/upstream key. Do not create keys silently.
- **User-disabled model preservation:** Existing `models.enabled` does not distinguish user-disabled from updater-disabled. To avoid surprising users, the updater should only force-enable new rows or rows already marked in `model_free_metadata` as updater-managed and verified.
- **OpenAI-compatible `/models` variability:** Providers return different catalog shapes (`data`, `models`, `pricing`, `context_length`). The normalization in `OpenAICompatProvider.listModels()` must be defensive and covered by tests.
- **Scheduling in tests:** Start scheduler from `server/src/index.ts`, not `createApp()`, to avoid background timers in route tests.
- **Coverage target:** Adding coverage tooling changes package metadata. If the user only needs tests, skip Task 15; if they require a measurable ≥85% target, add the coverage dependency and thresholds.

## Success criteria

- `GET /api/settings/free-model-updater/status` returns typed updater state.
- Users can enable/disable the updater and set a 1-24 hour interval from Settings.
- Users can manually trigger refresh from Settings.
- `GET /api/settings/free-model-updater/detected-models` previews free-model candidates.
- The updater discovers from live catalogs when possible and from hardcoded fallback lists when needed.
- Free detection supports pricing-based, keyword-based, hardcoded, and unclassified-provider methods.
- New verified free models are upserted into `models`, enrolled in `fallback_config`, and tracked in `model_free_metadata`.
- Models with missing keys are marked `no_key`, not disabled.
- Models with repeated probe failures are marked `unavailable` and disabled only after the configured failure threshold.
- `npm run test` and `npm run build` pass from repo root.
