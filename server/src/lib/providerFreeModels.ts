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

export type ProviderFreePolicy =
  | 'priced_catalog'
  | 'openrouter_free_variant_catalog'
  | 'account_free_tier_catalog'
  | 'provider_declared_free_catalog'
  | 'provider_tier_catalog'
  | 'unclassified_all_catalog'
  | 'hardcoded_then_probe'
  | 'custom_catalog';

export const FREE_MODEL_PROVIDER_POLICIES: Record<string, ProviderFreePolicy> = {
  openrouter: 'openrouter_free_variant_catalog',
  cerebras: 'account_free_tier_catalog',
  ollama: 'hardcoded_then_probe',
  github: 'provider_tier_catalog',
  groq: 'account_free_tier_catalog',
  pollinations: 'provider_tier_catalog',
  llm7: 'provider_tier_catalog',
  kilo: 'provider_declared_free_catalog',
};

export const ANONYMOUS_MODEL_CATALOG_PLATFORMS = new Set(['pollinations', 'llm7', 'openrouter', 'kilo']);

export const FREE_MODEL_KEYWORDS = ['free'];

export const KNOWN_FREE_MODELS: KnownFreeModel[] = [
  {
    platform: 'github',
    modelId: 'openai/gpt-4.1',
    displayName: 'GPT-4.1 (GitHub)',
    contextWindow: 128000,
    intelligenceRank: 20,
    speedRank: 7,
    sizeLabel: 'Large',
    monthlyTokenBudget: '~9M',
  },
  {
    platform: 'ollama',
    modelId: 'qwen3-coder-next',
    displayName: 'Qwen3-Coder Next (Ollama)',
    contextWindow: 262144,
    intelligenceRank: 3,
    speedRank: 9,
    sizeLabel: 'Large',
    monthlyTokenBudget: '~10-20M',
  },
  {
    platform: 'ollama',
    modelId: 'gpt-oss:120b',
    displayName: 'GPT-OSS 120B (Ollama)',
    contextWindow: 131072,
    intelligenceRank: 6,
    speedRank: 9,
    sizeLabel: 'Large',
    monthlyTokenBudget: '~10-20M',
  },
];

export function knownFreeModelsForPlatform(platform: string): KnownFreeModel[] {
  return KNOWN_FREE_MODELS.filter(model => model.platform === platform);
}

export function freeModelPolicyForPlatform(platform: string): ProviderFreePolicy | undefined {
  return FREE_MODEL_PROVIDER_POLICIES[platform];
}

export function isFreeModelProvider(platform: string): boolean {
  return platform in FREE_MODEL_PROVIDER_POLICIES;
}
