import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAttemptDeadlineSignal } from '../../routes/proxy.js';

describe('fallback attempt deadline', () => {
  afterEach(() => vi.useRealTimers());
  it('lets an active stream outlive the fallback window while retaining client cancellation', () => {
    vi.useFakeTimers();
    const client = new AbortController();
    const attempt = createAttemptDeadlineSignal(client.signal, Date.now() + 1000);
    attempt.clearDeadline();
    vi.advanceTimersByTime(10_000);
    expect(attempt.signal.aborted).toBe(false);
    client.abort(new Error('Client disconnected'));
    expect(attempt.signal.reason?.message).toBe('Client disconnected');
    attempt.cancel();
  });
});
