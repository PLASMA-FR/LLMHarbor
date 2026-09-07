import { afterEach, expect, it } from 'vitest';
import { closeDb, initDb } from '../../db/index.js';
import { getRateLimitStatus, recordTokens } from '../../services/ratelimit.js';

afterEach(() => closeDb());

it('does not double-count a persisted usage event when cleanup fails', () => {
  const db = initDb(':memory:');
  db.prepare("INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES ('old', 'old', 1, 'tokens', 2, 1)").run();
  db.exec("CREATE TEMP TRIGGER preserve_old_usage BEFORE DELETE ON rate_limit_usage BEGIN SELECT RAISE(ABORT, 'maintenance unavailable'); END");
  recordTokens('fixture', 'model', 10, 7);
  const status = getRateLimitStatus('fixture', 'model', 10, { rpm: null, rpd: null, tpm: 100, tpd: null });
  expect(status.tpm.used).toBe(7);
  expect(db.prepare("SELECT COUNT(*) AS count FROM rate_limit_usage WHERE platform = 'fixture'").get()).toEqual({ count: 1 });
});
