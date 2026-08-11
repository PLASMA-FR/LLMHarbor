import fs from 'fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  canMakeRequest,
  canUseTokens,
  recordRequest,
  recordTokens,
  getRateLimitStatus,
  getNextCooldownDuration,
  releaseProviderCapacity,
  reserveProviderCapacity,
} from '../../services/ratelimit.js';
import { getDb, initDb } from '../../db/index.js';

function removeDbFile(dbPath: string) {
  for (const suffix of ['', '-shm', '-wal']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // Best-effort cleanup for temp SQLite files.
    }
  }
}

let uniqueId = Date.now();

function nextUniqueId() {
  uniqueId += 1;
  return uniqueId;
}

describe('Rate Limiter', () => {
  // Use unique identifiers per test to avoid cross-contamination
  let testId: number;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    testId = nextUniqueId();
  });

  describe('canMakeRequest', () => {
    it('should allow request when under RPM limit', () => {
      expect(canMakeRequest('groq', 'llama-70b', testId, {
        rpm: 30, rpd: null, tpm: null, tpd: null,
      })).toBe(true);
    });

    it('should deny request when RPM limit reached', () => {
      const limits = { rpm: 2, rpd: null, tpm: null, tpd: null };
      recordRequest('groq', 'llama-70b', testId);
      recordRequest('groq', 'llama-70b', testId);
      expect(canMakeRequest('groq', 'llama-70b', testId, limits)).toBe(false);
    });

    it('should deny request when RPD limit reached', () => {
      const limits = { rpm: null, rpd: 1, tpm: null, tpd: null };
      recordRequest('google', 'gemini', testId);
      expect(canMakeRequest('google', 'gemini', testId, limits)).toBe(false);
    });

    it('should allow request when limits are null (unlimited)', () => {
      expect(canMakeRequest('nvidia', 'nemotron', testId, {
        rpm: null, rpd: null, tpm: null, tpd: null,
      })).toBe(true);
    });
  });

  describe('canUseTokens', () => {
    it('should allow tokens when under TPM limit', () => {
      expect(canUseTokens('groq', 'llama-70b', testId, 500, {
        tpm: 6000, tpd: null,
      })).toBe(true);
    });

    it('should deny tokens when TPM limit would be exceeded', () => {
      recordTokens('cerebras', 'qwen3', testId, 50000);
      expect(canUseTokens('cerebras', 'qwen3', testId, 20000, {
        tpm: 60000, tpd: null,
      })).toBe(false);
    });

    it('should allow when limit is null', () => {
      expect(canUseTokens('nvidia', 'nemotron', testId, 100000, {
        tpm: null, tpd: null,
      })).toBe(true);
    });

    it('includes in-flight reservations so concurrent requests cannot oversubscribe TPM', () => {
      const limits = { tpm: 100, tpd: null };
      const reservation = reserveProviderCapacity('groq', `concurrent-${testId}`, testId, 80);
      try {
        expect(canUseTokens('groq', `concurrent-${testId}`, testId, 30, limits)).toBe(false);
        expect(canUseTokens('groq', `concurrent-${testId}`, testId, 20, limits)).toBe(true);
      } finally {
        releaseProviderCapacity(reservation);
      }
      expect(canUseTokens('groq', `concurrent-${testId}`, testId, 30, limits)).toBe(true);
    });

    it('retains an active stream reservation beyond ten minutes until explicit settlement', () => {
      vi.useFakeTimers();
      const model = `long-stream-${testId}`;
      const reservation = reserveProviderCapacity('groq', model, testId, 80);
      try {
        vi.advanceTimersByTime(11 * 60 * 1000);
        expect(canUseTokens('groq', model, testId, 30, { tpm: 100, tpd: null })).toBe(false);
      } finally {
        releaseProviderCapacity(reservation);
        vi.useRealTimers();
      }
    });

    it('adds failed persistence writes to successful SQLite reads instead of failing open', () => {
      const db = getDb();
      db.prepare(`
        CREATE TRIGGER fail_rate_limit_usage_insert
        BEFORE INSERT ON rate_limit_usage
        BEGIN
          SELECT RAISE(FAIL, 'simulated busy write');
        END
      `).run();
      recordTokens('groq', `write-failure-${testId}`, testId, 80);
      db.prepare('DROP TRIGGER fail_rate_limit_usage_insert').run();

      expect(canUseTokens('groq', `write-failure-${testId}`, testId, 30, {
        tpm: 100, tpd: null,
      })).toBe(false);
    });
  });

  it('includes an unpersisted request when a later SQLite read succeeds', () => {
    const db = getDb();
    db.prepare(`
      CREATE TRIGGER fail_rate_limit_usage_insert
      BEFORE INSERT ON rate_limit_usage
      BEGIN
        SELECT RAISE(FAIL, 'simulated busy write');
      END
    `).run();
    recordRequest('groq', `request-write-failure-${testId}`, testId);
    db.prepare('DROP TRIGGER fail_rate_limit_usage_insert').run();
    expect(canMakeRequest('groq', `request-write-failure-${testId}`, testId, {
      rpm: 1, rpd: null, tpm: null, tpd: null,
    })).toBe(false);
  });

  describe('getRateLimitStatus', () => {
    it('should return current usage counts', () => {
      const limits = { rpm: 30, rpd: 1000, tpm: 6000, tpd: null };
      recordRequest('groq', 'test-model', testId);
      recordRequest('groq', 'test-model', testId);
      recordTokens('groq', 'test-model', testId, 500);

      const status = getRateLimitStatus('groq', 'test-model', testId, limits);
      expect(status.rpm.used).toBe(2);
      expect(status.rpm.limit).toBe(30);
      expect(status.rpd.used).toBe(2);
      expect(status.tpm.used).toBe(500);
    });
  });

  describe('escalating cooldown', () => {
    it('escalates the 2nd/3rd/4th hit within 24h to 10m / 1h / 24h', () => {
      const id = nextUniqueId();
      const args = ['cerebras', `escalating-model-${id}`, id] as const;
      // 1st: 2 minutes
      expect(getNextCooldownDuration(...args)).toBe(2 * 60 * 1000);
      // 2nd: 10 minutes
      expect(getNextCooldownDuration(...args)).toBe(10 * 60 * 1000);
      // 3rd: 1 hour
      expect(getNextCooldownDuration(...args)).toBe(60 * 60 * 1000);
      // 4th: 24 hours
      expect(getNextCooldownDuration(...args)).toBe(24 * 60 * 60 * 1000);
      // 5th+ stays at 24h (quarantined until next quota window)
      expect(getNextCooldownDuration(...args)).toBe(24 * 60 * 60 * 1000);
    });

    it('counts independently per (platform, model, key)', () => {
      const id = nextUniqueId();
      // Different keys for the same model should each start at 2m, not share state.
      expect(getNextCooldownDuration('groq', `m-${id}`, id)).toBe(2 * 60 * 1000);
      expect(getNextCooldownDuration('groq', `m-${id}`, id + 1)).toBe(2 * 60 * 1000);
      expect(getNextCooldownDuration('groq', `m-${id}-other`, id)).toBe(2 * 60 * 1000);
    });
  });

  describe('persistent state', () => {
    it('preserves per-key usage and cooldowns after the limiter module reloads', async () => {
      process.env.ENCRYPTION_KEY = '0'.repeat(64);
      const dbPath = `/tmp/llmharbor-ratelimit-${nextUniqueId()}.db`;
      const keyId = 4242;
      let db: { close: () => void } | undefined;

      try {
        vi.resetModules();
        const dbModule = await import('../../db/index.js');
        db = dbModule.initDb(dbPath);
        const limiter = await import('../../services/ratelimit.js');

        limiter.recordRequest('groq', 'persistent-model', keyId);
        limiter.recordTokens('groq', 'persistent-model', keyId, 950);
        limiter.setCooldown('groq', 'persistent-model', keyId, 60_000);
        db.close();
        db = undefined;

        vi.resetModules();
        const dbModuleAfterReload = await import('../../db/index.js');
        db = dbModuleAfterReload.initDb(dbPath);
        const limiterAfterReload = await import('../../services/ratelimit.js');

        expect(limiterAfterReload.canMakeRequest('groq', 'persistent-model', keyId, {
          rpm: null, rpd: 1, tpm: null, tpd: null,
        })).toBe(false);
        expect(limiterAfterReload.canUseTokens('groq', 'persistent-model', keyId, 100, {
          tpm: null, tpd: 1000,
        })).toBe(false);
        expect(limiterAfterReload.isOnCooldown('groq', 'persistent-model', keyId)).toBe(true);
      } finally {
        db?.close();
        removeDbFile(dbPath);
      }
    });
  });
});
