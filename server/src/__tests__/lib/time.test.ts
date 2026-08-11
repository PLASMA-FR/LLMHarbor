import { describe, expect, it } from 'vitest';
import { toUtcTimestamp } from '../../lib/time.js';

describe('toUtcTimestamp', () => {
  it('normalizes SQLite UTC datetimes to ISO-8601', () => {
    expect(toUtcTimestamp('2026-08-11 14:05:09')).toBe('2026-08-11T14:05:09Z');
    expect(toUtcTimestamp('2026-08-11 14:05:09.123')).toBe('2026-08-11T14:05:09.123Z');
  });

  it('preserves timestamps that already declare ISO or offset semantics', () => {
    expect(toUtcTimestamp('2026-08-11T14:05:09Z')).toBe('2026-08-11T14:05:09Z');
    expect(toUtcTimestamp('2026-08-11T16:05:09+02:00')).toBe('2026-08-11T16:05:09+02:00');
    expect(toUtcTimestamp('2026-08-11')).toBe('2026-08-11');
  });

  it('is null-safe and rejects non-string values', () => {
    expect(toUtcTimestamp(null)).toBeNull();
    expect(toUtcTimestamp(undefined)).toBeNull();
    expect(toUtcTimestamp('')).toBeNull();
    expect(toUtcTimestamp(1)).toBeNull();
  });
});
