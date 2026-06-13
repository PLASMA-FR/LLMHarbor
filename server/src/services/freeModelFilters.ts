import type { Platform, FreeModelDetectionMethod } from '@llmharbor/shared/types.js';
import type { ProviderCatalogModel } from '../providers/base.js';
import {
  FREE_MODEL_KEYWORDS,
  freeModelPolicyForPlatform,
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
  const policy = freeModelPolicyForPlatform(String(platform));
  const candidates: FilteredFreeModel[] = [];

  for (const row of catalog) {
    const displayName = displayNameFor(row);
    const keyword = keywordMethod(row.id, displayName);
    const zeroPrice = hasZeroPricing(row.pricing);

    if (policy === 'unclassified_all_catalog') {
      candidates.push({
        platform,
        modelId: row.id,
        displayName,
        detectionMethod: 'unclassified_provider',
        contextWindow: row.contextWindow ?? null,
        raw: row.raw,
      });
      continue;
    }

    if (zeroPrice) {
      candidates.push({
        platform,
        modelId: row.id,
        displayName,
        detectionMethod: 'pricing_tier',
        contextWindow: row.contextWindow ?? null,
        raw: row.raw,
      });
      continue;
    }

    if (keyword) {
      candidates.push({
        platform,
        modelId: row.id,
        displayName,
        detectionMethod: keyword,
        contextWindow: row.contextWindow ?? null,
        raw: row.raw,
      });
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
