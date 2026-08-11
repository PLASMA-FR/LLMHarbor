import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { toUtcTimestamp } from '../lib/time.js';

export const analyticsRouter = Router();

// Map range to a JS-computed ISO timestamp passed as a bind parameter.
// All-time returns null and the SQL predicates explicitly bypass date filtering,
// so it is truly every row rather than a lexical timestamp comparison.
const rangeSchema = z.enum(['24h', '7d', '30d', 'all', 'alltime']);

function getSinceTimestamp(range: z.infer<typeof rangeSchema>): string | null {
  const now = Date.now();
  switch (range) {
    case 'all':
    case 'alltime':
      return null;
    case '24h':
      return new Date(now - 24 * 60 * 60 * 1000).toISOString();
    case '30d':
      return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    case '7d':
      return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
}

function analyticsRange(req: Request, res: Response): { range: z.infer<typeof rangeSchema>; since: string | null } | null {
  const parsed = rangeSchema.safeParse(req.query.range ?? '7d');
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid range. Use 24h, 7d, 30d, or all.', type: 'invalid_request_error', code: 'invalid_analytics_range' } });
    return null;
  }
  return { range: parsed.data, since: getSinceTimestamp(parsed.data) };
}

// Summary stats
analyticsRouter.get('/summary', (req: Request, res: Response) => {
  const range = analyticsRange(req, res);
  if (!range) return;
  const { since } = range;
  const db = getDb();

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failure_count,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      AVG(CASE WHEN status != 'cancelled' THEN latency_ms END) as avg_latency_ms
    FROM requests
    WHERE is_final = 1 AND (? IS NULL OR created_at >= datetime(?))
  `).get(since, since) as any;

  const totalRequests = stats.total_requests ?? 0;
  const completedRequests = (stats.success_count ?? 0) + (stats.failure_count ?? 0);
  const successRate = completedRequests > 0 ? (stats.success_count / completedRequests) * 100 : 0;
  const totalTokens = (stats.total_input_tokens ?? 0) + (stats.total_output_tokens ?? 0);

  // Estimate cost savings: average ~$3/M input + $15/M output tokens (GPT-4o pricing)
  const inputCost = ((stats.total_input_tokens ?? 0) / 1_000_000) * 3;
  const outputCost = ((stats.total_output_tokens ?? 0) / 1_000_000) * 15;

  res.json({
    totalRequests,
    successfulRequests: stats.success_count ?? 0,
    failedRequests: stats.failure_count ?? 0,
    cancelledRequests: stats.cancelled_count ?? 0,
    successRate: Math.round(successRate * 10) / 10,
    totalInputTokens: stats.total_input_tokens ?? 0,
    totalOutputTokens: stats.total_output_tokens ?? 0,
    avgLatencyMs: Math.round(stats.avg_latency_ms ?? 0),
    estimatedCostSavings: Math.round((inputCost + outputCost) * 100) / 100,
  });
});

// Stats grouped by model
analyticsRouter.get('/by-model', (req: Request, res: Response) => {
  const range = analyticsRange(req, res);
  if (!range) return;
  const { since } = range;
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      r.platform,
      r.model_id,
      m.display_name,
      COUNT(*) as requests,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN r.status IN ('success', 'error') THEN 1 ELSE 0 END), 0) as success_rate,
      SUM(CASE WHEN r.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count,
      AVG(CASE WHEN r.status != 'cancelled' THEN r.latency_ms END) as avg_latency_ms,
      SUM(r.input_tokens) as total_input_tokens,
      SUM(r.output_tokens) as total_output_tokens
    FROM requests r
    LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.is_final = 1 AND (? IS NULL OR r.created_at >= datetime(?))
    GROUP BY r.platform, r.model_id
    ORDER BY requests DESC
  `).all(since, since) as any[];

  res.json(rows.map(r => ({
    platform: r.platform,
    modelId: r.model_id,
    displayName: r.display_name ?? r.model_id,
    requests: r.requests,
    successRate: Math.round((r.success_rate ?? 0) * 10) / 10,
    cancelledRequests: r.cancelled_count ?? 0,
    avgLatencyMs: Math.round(r.avg_latency_ms),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
  })));
});

// Stats grouped by platform
analyticsRouter.get('/by-platform', (req: Request, res: Response) => {
  const range = analyticsRange(req, res);
  if (!range) return;
  const { since } = range;
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      platform,
      COUNT(*) as requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 100.0 /
        NULLIF(SUM(CASE WHEN status IN ('success', 'error') THEN 1 ELSE 0 END), 0) as success_rate,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count,
      AVG(CASE WHEN status != 'cancelled' THEN latency_ms END) as avg_latency_ms,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens
    FROM requests
    WHERE is_final = 1 AND (? IS NULL OR created_at >= datetime(?))
    GROUP BY platform
    ORDER BY requests DESC
  `).all(since, since) as any[];

  res.json(rows.map(r => ({
    platform: r.platform,
    requests: r.requests,
    successRate: Math.round((r.success_rate ?? 0) * 10) / 10,
    cancelledRequests: r.cancelled_count ?? 0,
    avgLatencyMs: Math.round(r.avg_latency_ms),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
  })));
});

// Timeline data
analyticsRouter.get('/timeline', (req: Request, res: Response) => {
  const range = analyticsRange(req, res);
  if (!range) return;
  const intervalResult = z.enum(['hour', 'day']).safeParse(req.query.interval ?? (range.range === '24h' ? 'hour' : 'day'));
  if (!intervalResult.success) {
    res.status(400).json({ error: { message: 'Invalid interval. Use hour or day.', type: 'invalid_request_error', code: 'invalid_analytics_interval' } });
    return;
  }
  const interval = intervalResult.data;
  const { since } = range;
  const db = getDb();

  // dateFormat is a hardcoded whitelist — never user-controlled.
  const dateFormat = interval === 'hour' ? '%Y-%m-%dT%H:00:00Z' : '%Y-%m-%d';

  const rows = db.prepare(`
    SELECT
      strftime('${dateFormat}', created_at) as timestamp,
      COUNT(*) as requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failure_count,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count
    FROM requests
    WHERE is_final = 1 AND (? IS NULL OR created_at >= datetime(?))
    GROUP BY strftime('${dateFormat}', created_at)
    ORDER BY timestamp ASC
  `).all(since, since) as any[];

  res.json(rows.map(r => ({
    timestamp: r.timestamp,
    requests: r.requests,
    successCount: r.success_count,
    failureCount: r.failure_count,
    cancelledCount: r.cancelled_count,
  })));
});

// Error distribution (grouped by error type and platform)
analyticsRouter.get('/error-distribution', (req: Request, res: Response) => {
  const range = analyticsRange(req, res);
  if (!range) return;
  const { since } = range;
  const db = getDb();

  // Group errors by category (extract the key part of the error message)
  const rows = db.prepare(`
    SELECT
      platform,
      model_id,
      CASE
        WHEN error LIKE '%429%' OR error LIKE '%rate limit%' OR error LIKE '%too many%' OR error LIKE '%quota%' THEN 'Rate Limited (429)'
        WHEN error LIKE '%401%' OR error LIKE '%unauthorized%' OR (error LIKE '%invalid%' AND error LIKE '%key%') THEN 'Auth Error (401)'
        WHEN error LIKE '%403%' OR error LIKE '%forbidden%' THEN 'Forbidden (403)'
        WHEN error LIKE '%404%' OR error LIKE '%not found%' THEN 'Not Found (404)'
        WHEN error LIKE '%timeout%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
        WHEN error LIKE '%500%' OR error LIKE '%internal server%' THEN 'Server Error (500)'
        WHEN error LIKE '%503%' OR error LIKE '%unavailable%' THEN 'Unavailable (503)'
        ELSE 'Other'
      END as error_category,
      COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND (? IS NULL OR created_at >= datetime(?))
    GROUP BY platform, error_category
    ORDER BY count DESC
  `).all(since, since) as any[];

  // Also get totals by category
  const byCategory = db.prepare(`
    SELECT
      CASE
        WHEN error LIKE '%429%' OR error LIKE '%rate limit%' OR error LIKE '%too many%' OR error LIKE '%quota%' THEN 'Rate Limited (429)'
        WHEN error LIKE '%401%' OR error LIKE '%unauthorized%' OR (error LIKE '%invalid%' AND error LIKE '%key%') THEN 'Auth Error (401)'
        WHEN error LIKE '%403%' OR error LIKE '%forbidden%' THEN 'Forbidden (403)'
        WHEN error LIKE '%404%' OR error LIKE '%not found%' THEN 'Not Found (404)'
        WHEN error LIKE '%timeout%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
        WHEN error LIKE '%500%' OR error LIKE '%internal server%' THEN 'Server Error (500)'
        WHEN error LIKE '%503%' OR error LIKE '%unavailable%' THEN 'Unavailable (503)'
        ELSE 'Other'
      END as category,
      COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND (? IS NULL OR created_at >= datetime(?))
    GROUP BY category
    ORDER BY count DESC
  `).all(since, since) as any[];

  // Errors by platform
  const byPlatform = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND (? IS NULL OR created_at >= datetime(?))
    GROUP BY platform
    ORDER BY count DESC
  `).all(since, since) as any[];

  res.json({
    byCategory,
    byPlatform,
    detailed: rows,
  });
});

// Recent errors
analyticsRouter.get('/errors', (req: Request, res: Response) => {
  const range = analyticsRange(req, res);
  if (!range) return;
  const { since } = range;
  const db = getDb();

  const rows = db.prepare(`
    SELECT id, request_id, attempt, is_final, platform, model_id, error, latency_ms, created_at
    FROM requests
    WHERE status = 'error' AND (? IS NULL OR created_at >= datetime(?))
    ORDER BY created_at DESC, id DESC
    LIMIT 50
  `).all(since, since) as any[];

  res.json(rows.map(r => ({
    id: r.id,
    requestId: r.request_id,
    attempt: r.attempt,
    isFinal: r.is_final === 1,
    platform: r.platform,
    modelId: r.model_id,
    error: r.error,
    latencyMs: r.latency_ms,
    createdAt: toUtcTimestamp(r.created_at),
  })));
});

// Recent traffic for the operational overview. This intentionally returns a
// compact request record rather than the heavier grouped analytics payloads.
analyticsRouter.get('/recent', (req: Request, res: Response) => {
  const range = analyticsRange(req, res);
  if (!range) return;
  const limitResult = z.coerce.number().int().min(1).max(100).default(10).safeParse(req.query.limit);
  if (!limitResult.success) {
    res.status(400).json({ error: { message: 'Invalid limit. Use an integer from 1 to 100.', type: 'invalid_request_error', code: 'invalid_analytics_limit' } });
    return;
  }
  const rows = getDb().prepare(`
    SELECT r.id, r.platform, r.model_id, m.display_name, r.status,
           r.input_tokens, r.output_tokens, r.latency_ms, r.error, r.created_at
      FROM requests r
      LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
     WHERE r.is_final = 1 AND (? IS NULL OR r.created_at >= datetime(?))
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT ?
  `).all(range.since, range.since, limitResult.data) as any[];

  res.json(rows.map(row => ({
    id: row.id,
    platform: row.platform,
    modelId: row.model_id,
    displayName: row.display_name ?? undefined,
    status: row.status,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    latencyMs: row.latency_ms,
    error: row.error,
    createdAt: toUtcTimestamp(row.created_at),
  })));
});
