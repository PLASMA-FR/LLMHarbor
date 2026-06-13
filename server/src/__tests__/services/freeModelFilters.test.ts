import { describe, expect, it } from 'vitest';
import type { ProviderCatalogModel } from '../../providers/base.js';
import { filterFreeModels } from '../../services/freeModelFilters.js';

const model = (id: string, extra: Partial<ProviderCatalogModel> = {}): ProviderCatalogModel => ({
  id,
  displayName: id,
  contextWindow: null,
  ...extra,
});

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
    const result = filterFreeModels('groq', [
      model('llama-3.3-70b-versatile'),
      model('openai/gpt-oss-120b'),
    ]);

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
