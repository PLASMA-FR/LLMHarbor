import { describe, it, expect, vi } from 'vitest';
import { createAttemptDeadlineSignal, isRateLimitFailure, isRetryableError } from '../../routes/proxy.js';
import { ProviderError } from '../../providers/base.js';

describe('isRetryableError', () => {
  describe('413 Payload Too Large', () => {
    it('treats explicit "413" in the error message as retryable', () => {
      expect(isRetryableError(new Error('GitHub Models API error 413: Request body too large'))).toBe(true);
      expect(isRetryableError(new Error('Cloudflare API error 413: Payload Too Large'))).toBe(true);
    });

    it('treats common 413 phrasings (no status code) as retryable', () => {
      expect(isRetryableError(new Error('Payload Too Large'))).toBe(true);
      expect(isRetryableError(new Error('Request body too large for this model'))).toBe(true);
      expect(isRetryableError(new Error('Request entity too large'))).toBe(true);
      expect(isRetryableError(new Error('Content too large'))).toBe(true);
    });
  });

  describe('404 model removed / not found (the bug #66 fixes)', () => {
    it('treats explicit "404" in the error message as retryable', () => {
      expect(isRetryableError(new Error('OpenRouter API error 404: Provider returned error'))).toBe(true);
      expect(isRetryableError(new Error('Groq API error 404: model not found'))).toBe(true);
    });

    it('catches OpenRouter\'s "No endpoints found" phrasing for deprecated models', () => {
      expect(isRetryableError(new Error('No endpoints found for openrouter/minimax/minimax-m2.5:free'))).toBe(true);
    });

    it('catches bare "not found" phrasing (any provider, any case)', () => {
      expect(isRetryableError(new Error('Model not found'))).toBe(true);
      expect(isRetryableError(new Error('The requested model was not found'))).toBe(true);
    });
  });

  describe('existing categories still classify correctly', () => {
    it('429 / rate limits are retryable', () => {
      expect(isRetryableError(new Error('429 Too Many Requests'))).toBe(true);
      expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
      expect(isRetryableError(new Error('quota exhausted'))).toBe(true);
    });

    it('5xx and network errors are retryable', () => {
      expect(isRetryableError(new Error('503 Service Unavailable'))).toBe(true);
      expect(isRetryableError(new Error('500 Internal Server Error'))).toBe(true);
      expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
      expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
      expect(isRetryableError(new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo failed'), { code: 'ENOTFOUND' }),
      }))).toBe(true);
    });

    it('only retries upstream auth failures when providers preserve the status', () => {
      expect(isRetryableError(new Error('401 Unauthorized'))).toBe(false);
      expect(isRetryableError(new Error('403 Forbidden'))).toBe(false);
      expect(isRetryableError(new ProviderError('401 Unauthorized', { statusCode: 401 }))).toBe(true);
      expect(isRetryableError(new ProviderError('402 Payment Required', { statusCode: 402 }))).toBe(true);
      expect(isRetryableError(new ProviderError('403 Forbidden', { statusCode: 403 }))).toBe(true);
      expect(isRetryableError(new Error('400 Bad Request'))).toBe(false);
      expect(isRetryableError(new Error('Invalid API key'))).toBe(false);
    });
  });
});

describe('rate-limit penalty classification', () => {
  it('only classifies actual 429/quota failures as rate-limit pressure', () => {
    expect(isRateLimitFailure(new ProviderError('rate limited', { statusCode: 429 }))).toBe(true);
    expect(isRateLimitFailure(new Error('quota exhausted'))).toBe(true);
    expect(isRateLimitFailure(new ProviderError('upstream failed', { statusCode: 500 }))).toBe(false);
    expect(isRateLimitFailure(new ProviderError('model missing', { statusCode: 404 }))).toBe(false);
    expect(isRateLimitFailure(new Error('ETIMEDOUT'))).toBe(false);
  });
});

describe('provider attempt deadline', () => {
  it('aborts at the remaining gateway deadline and preserves downstream cancellation', () => {
    vi.useFakeTimers();
    try {
      const downstream = new AbortController();
      const deadline = createAttemptDeadlineSignal(downstream.signal, Date.now() + 180_000);
      vi.advanceTimersByTime(179_999);
      expect(deadline.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(deadline.signal.aborted).toBe(true);
      expect(deadline.signal.reason).toMatchObject({ name: 'TimeoutError' });

      const secondDownstream = new AbortController();
      const second = createAttemptDeadlineSignal(secondDownstream.signal, Date.now() + 180_000);
      const downstreamReason = new DOMException('client left', 'AbortError');
      secondDownstream.abort(downstreamReason);
      expect(second.signal.aborted).toBe(true);
      expect(second.signal.reason).toBe(downstreamReason);
      deadline.cancel();
      second.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
