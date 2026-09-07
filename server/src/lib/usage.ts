import type { TokenUsage } from '@llmharbor/shared/types.js';

export function isValidUsage(value: unknown): value is TokenUsage {
  if (!value || typeof value !== 'object') return false;
  const usage = value as Record<string, unknown>;
  return ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(field => (
    typeof usage[field] === 'number' && Number.isSafeInteger(usage[field]) && (usage[field] as number) >= 0
  ));
}

/** Preserve reported zero values. All-zero adapter placeholders mean unknown. */
export function resolveUsage(reported: TokenUsage | undefined, estimatedInput: number, estimatedOutput: number): TokenUsage {
  if (isValidUsage(reported) && reported && (reported.total_tokens > 0 || reported.prompt_tokens > 0 || reported.completion_tokens > 0)) {
    return {
      ...reported,
      total_tokens: Math.max(reported.total_tokens, reported.prompt_tokens + reported.completion_tokens),
    };
  }
  const prompt_tokens = Math.max(0, Math.ceil(estimatedInput));
  const completion_tokens = Math.max(0, Math.ceil(estimatedOutput));
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}
