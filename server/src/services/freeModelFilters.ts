import type { Platform, FreeModelDetectionMethod } from '@llmharbor/shared/types.js';
import type { ProviderCatalogModel } from '../providers/base.js';
import {
  FREE_MODEL_KEYWORDS,
  freeModelPolicyForPlatform,
  knownFreeModelsForPlatform,
  type ProviderFreePolicy,
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
  if (typeof value === 'string' && value.trim() !== '') {
    const normalized = value.trim().toLowerCase().replace(/^\$/, '');
    if (normalized === 'free') return true;
    return Number(normalized) === 0;
  }
  return false;
}

function rawRecord(row: ProviderCatalogModel): Record<string, unknown> {
  return row.raw && typeof row.raw === 'object' ? row.raw as Record<string, unknown> : {};
}

function hasZeroPricing(pricing: unknown): boolean {
  if (!pricing || typeof pricing !== 'object') return false;
  const obj = pricing as Record<string, unknown>;
  const prompt = obj.prompt ?? obj.input ?? obj.prompt_tokens ?? obj.input_tokens ?? obj.input_token ?? obj.prompt_price;
  const completion = obj.completion ?? obj.output ?? obj.completion_tokens ?? obj.output_tokens ?? obj.output_token ?? obj.completion_price;
  const aggregate = obj.price ?? obj.request_price ?? obj.request;
  const extraBillable = [
    obj.image,
    obj.image_output,
    obj.image_tokens,
    obj.audio,
    obj.audio_output,
    obj.web_search,
    obj.internal_reasoning,
    obj.input_cache_read,
    obj.input_cache_write,
  ];
  if (extraBillable.some(value => value !== undefined && !numericZero(value))) return false;
  if (prompt !== undefined || completion !== undefined) {
    return prompt !== undefined && completion !== undefined && numericZero(prompt) && numericZero(completion);
  }
  return aggregate !== undefined && numericZero(aggregate);
}

function keywordMethod(id: string, displayName: string): FreeModelDetectionMethod | null {
  const haystack = `${id} ${displayName}`.toLowerCase();
  return FREE_MODEL_KEYWORDS.some(keyword => new RegExp(`(^|[:/_\\-\\s()[\\]])${keyword}($|[:/_\\-\\s()[\\]])`).test(haystack)) ? 'keyword' : null;
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

function candidateFromRow(platform: Platform, row: ProviderCatalogModel, detectionMethod: FreeModelDetectionMethod): FilteredFreeModel {
  return {
    platform,
    modelId: row.id,
    displayName: displayNameFor(row),
    detectionMethod,
    contextWindow: row.contextWindow ?? null,
    raw: row.raw,
  };
}

function isActive(row: ProviderCatalogModel): boolean {
  const raw = rawRecord(row);
  return raw.active !== false && raw.deprecated !== true;
}

function isLikelyChatTextModel(platform: Platform, row: ProviderCatalogModel): boolean {
  const lower = `${row.id} ${displayNameFor(row)}`.toLowerCase();
  if (platform === 'groq' && /\b(whisper|distil-whisper|tts|speech|audio|moderation|guard)\b/.test(lower)) return false;
  const raw = rawRecord(row);
  const category = typeof raw.category === 'string' ? raw.category.toLowerCase() : '';
  if (category && !['text', 'chat', 'language'].includes(category)) return false;
  const architecture = raw.architecture && typeof raw.architecture === 'object' ? raw.architecture as Record<string, unknown> : {};
  const outputModalities = raw.output_modalities ?? raw.outputModalities ?? architecture.output_modalities;
  if (Array.isArray(outputModalities) && outputModalities.length > 0) {
    return outputModalities.some(value => String(value).toLowerCase() === 'text');
  }
  return true;
}

function providerTierCandidate(platform: Platform, row: ProviderCatalogModel): boolean {
  const raw = rawRecord(row);
  if (platform === 'github') {
    const tier = String(raw.rate_limit_tier ?? '').toLowerCase();
    if (!['low', 'high'].includes(tier)) return false;
    const modality = `${raw.task ?? ''} ${raw.model_type ?? ''} ${row.id}`.toLowerCase();
    return !modality.includes('embedding');
  }
  if (platform === 'llm7') {
    const tier = String(raw.tier ?? 'free').toLowerCase();
    return !['pro', 'paid', 'enterprise'].includes(tier);
  }
  if (platform === 'pollinations') {
    if (raw.paid_only === true || raw.paidOnly === true) return false;
    const tier = String(raw.tier ?? '').toLowerCase();
    if (tier === 'anonymous' || tier === 'free') return true;
    return isLikelyChatTextModel(platform, row);
  }
  return false;
}

export function filterFreeModels(platform: Platform, catalog: ProviderCatalogModel[], policyOverride?: ProviderFreePolicy): FilteredFreeModel[] {
  const policy = policyOverride ?? freeModelPolicyForPlatform(String(platform));
  const candidates: FilteredFreeModel[] = [];

  for (const row of catalog) {
    const displayName = displayNameFor(row);
    const keyword = keywordMethod(row.id, displayName);
    const zeroPrice = hasZeroPricing(row.pricing);

    if (!isActive(row) || !isLikelyChatTextModel(platform, row)) continue;

    if (policy === 'custom_catalog') {
      candidates.push(candidateFromRow(platform, row, 'unclassified_provider'));
      continue;
    }

    if (policy === 'openrouter_free_variant_catalog') {
      if (row.id.toLowerCase().endsWith(':free') && zeroPrice) candidates.push(candidateFromRow(platform, row, 'keyword'));
      continue;
    }

    if (policy === 'provider_declared_free_catalog') {
      if (rawRecord(row).isFree === true) candidates.push(candidateFromRow(platform, row, 'unclassified_provider'));
      continue;
    }

    if (policy === 'provider_tier_catalog') {
      if (providerTierCandidate(platform, row)) candidates.push(candidateFromRow(platform, row, 'unclassified_provider'));
      continue;
    }

    if (policy === 'account_free_tier_catalog') {
      candidates.push(candidateFromRow(platform, row, 'unclassified_provider'));
      continue;
    }

    if (policy === 'unclassified_all_catalog') {
      candidates.push(candidateFromRow(platform, row, 'unclassified_provider'));
      continue;
    }

    if (zeroPrice) {
      candidates.push(candidateFromRow(platform, row, 'pricing_tier'));
      continue;
    }

    if (keyword) candidates.push(candidateFromRow(platform, row, keyword));
  }

  if (policy === 'hardcoded_then_probe') candidates.push(...fromKnown(String(platform)));

  const deduped = new Map<string, FilteredFreeModel>();
  for (const candidate of candidates) {
    const key = `${candidate.platform}:${candidate.modelId}`;
    if (!deduped.has(key)) deduped.set(key, candidate);
  }
  return [...deduped.values()];
}
