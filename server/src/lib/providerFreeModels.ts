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

export const ANONYMOUS_MODEL_CATALOG_PLATFORMS = new Set(['pollinations', 'llm7']);

export const FREE_MODEL_KEYWORDS = ['free', 'trial', 'open-source', 'opensource'];

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
  {
    platform: 'kilo',
    modelId: 'nvidia/nemotron-3-super-120b-a12b:free',
    displayName: 'Nemotron 3 Super 120B (Kilo)',
    contextWindow: 262144,
    intelligenceRank: 22,
    speedRank: 9,
    sizeLabel: 'Frontier',
    monthlyTokenBudget: '~2-3M (200/hr)',
  },
  {
    platform: 'pollinations',
    modelId: 'openai-fast',
    displayName: 'GPT-OSS 20B (Pollinations)',
    contextWindow: 131072,
    intelligenceRank: 18,
    speedRank: 10,
    sizeLabel: 'Medium',
    monthlyTokenBudget: '~? (anon)',
  },
  {
    platform: 'llm7',
    modelId: 'gpt-oss-20b',
    displayName: 'GPT-OSS 20B (LLM7)',
    contextWindow: 131072,
    intelligenceRank: 18,
    speedRank: 10,
    sizeLabel: 'Medium',
    monthlyTokenBudget: '~2-3M (100/hr)',
  },
  {
    platform: 'llm7',
    modelId: 'codestral-latest',
    displayName: 'Codestral (LLM7)',
    contextWindow: 32000,
    intelligenceRank: 16,
    speedRank: 8,
    sizeLabel: 'Medium',
    monthlyTokenBudget: '~2-3M (100/hr)',
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
