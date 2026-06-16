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
  it('identifies only OpenRouter :free zero-price catalog rows', () => {
    const result = filterFreeModels('openrouter', [
      model('deepseek/deepseek-chat-v3.1:free', { pricing: { prompt: '0', completion: '0' } }),
      model('paid/model', { pricing: { prompt: '0.25', completion: '0.50' } }),
      model('zero/model', { pricing: { prompt: '0', completion: '0' } }),
      model('sneaky/model:free', { pricing: { prompt: '0', completion: '0', image: '0.01' } }),
    ]);

    expect(result.map(row => row.modelId)).toEqual(['deepseek/deepseek-chat-v3.1:free']);
    expect(result[0].detectionMethod).toBe('keyword');
  });

  it('adds all Groq catalog rows as unclassified provider free-tier candidates', () => {
    const result = filterFreeModels('groq', [
      model('llama-3.3-70b-versatile'),
      model('openai/gpt-oss-120b'),
    ]);

    expect(result).toHaveLength(2);
    expect(result.every(row => row.detectionMethod === 'unclassified_provider')).toBe(true);
  });

  it('uses hardcoded fallback models only for hardcoded providers', () => {
    expect(filterFreeModels('ollama', []).map(row => row.modelId)).toContain('qwen3-coder-next');
    expect(filterFreeModels('pollinations', [])).toEqual([]);
  });

  it('uses provider-declared free flags for Kilo instead of zero pricing alone', () => {
    const result = filterFreeModels('kilo', [
      model('openrouter/owl-alpha', { pricing: { prompt: '0', completion: '0' }, raw: { isFree: true } }),
      model('google/lyria-3-pro-preview', { pricing: { prompt: '0', completion: '0' }, raw: { isFree: false } }),
    ]);

    expect(result.map(row => row.modelId)).toEqual(['openrouter/owl-alpha']);
    expect(result[0].detectionMethod).toBe('unclassified_provider');
  });

  it('excludes paid LLM7 tiers while accepting free-tier catalog rows', () => {
    const result = filterFreeModels('llm7', [
      model('codestral-latest', { raw: { id: 'codestral-latest' } }),
      model('minimax-m2.7', { raw: { id: 'minimax-m2.7', tier: 'pro' } }),
    ]);

    expect(result.map(row => row.modelId)).toEqual(['codestral-latest']);
  });

  it('keeps only custom catalog rows with free keywords or free pricing', () => {
    const result = filterFreeModels('custom-local-vllm', [
      model('local/qwen-coder'),
      model('local/free-coder'),
      model('local/zero-cost', { pricing: { prompt: '0', completion: '0' } }),
      model('local/string-free', { pricing: 'free' }),
    ], 'custom_catalog');
    expect(result.map(row => `${row.modelId}:${row.detectionMethod}`)).toEqual([
      'local/free-coder:keyword',
      'local/zero-cost:pricing_tier',
      'local/string-free:pricing_tier',
    ]);
  });

  it('deduplicates by platform and model id', () => {
    const result = filterFreeModels('openrouter', [
      model('x/free:free', { pricing: { prompt: '0', completion: '0' } }),
      model('x/free:free', { pricing: { prompt: '0', completion: '0' } }),
    ]);
    expect(result).toHaveLength(1);
  });
});
