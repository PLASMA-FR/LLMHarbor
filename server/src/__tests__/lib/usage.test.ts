import { describe, expect, it } from 'vitest';
import { resolveUsage } from '../../lib/usage.js';

describe('usage reconciliation', () => {
  it('preserves explicitly reported zero completion tokens', () => {
    expect(resolveUsage({ prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 }, 8, 4))
      .toEqual({ prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 });
  });
  it('retains additional reported reasoning tokens in the total', () => {
    expect(resolveUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 50 }, 8, 4).total_tokens).toBe(50);
  });
  it('estimates missing usage and legacy all-zero placeholders', () => {
    const expected = { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 };
    expect(resolveUsage(undefined, 8, 4)).toEqual(expected);
    expect(resolveUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, 8, 4)).toEqual(expected);
  });
});
