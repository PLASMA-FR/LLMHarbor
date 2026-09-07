import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { paginationSchema } from '../lib/pagination.js';
import { sendValidationError } from '../lib/validation.js';
import { parsePositiveResourceId } from '../lib/resourceId.js';
import { toUtcTimestamp } from '../lib/time.js';
import { redactSensitive } from '../lib/errors.js';

export const requestsRouter = Router();
export const requestListSchema = paginationSchema.extend({
  status: z.enum(['success', 'error', 'cancelled']).optional(),
  platform: z.string().trim().min(1).max(80).optional(),
  q: z.string().trim().max(160).optional(),
  clientKeyId: z.coerce.number().int().positive().safe().optional(),
});

interface RequestRow {
  id: number;
  request_id: string | null;
  trace_id: string | null;
  client_key_id: number | null;
  client_label?: string | null;
  platform: string;
  model_id: string;
  display_name?: string | null;
  attempt: number;
  is_final: number;
  status: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  error: string | null;
  created_at: string;
}
function serialize(row: RequestRow) {
  return {
    id: row.id,
    requestId: row.request_id,
    traceId: row.trace_id,
    clientKeyId: row.client_key_id,
    clientKeyLabel: row.client_label ?? null,
    platform: row.platform,
    modelId: row.model_id,
    displayName: row.display_name ?? row.model_id,
    attempt: row.attempt,
    isFinal: row.is_final === 1,
    status: row.status,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    latencyMs: row.latency_ms,
    error: row.error ? redactSensitive(row.error) : null,
    createdAt: toUtcTimestamp(row.created_at),
  };
}
const joinedRequest = `SELECT r.*, m.display_name, c.label AS client_label FROM requests r
  LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
  LEFT JOIN client_api_keys c ON c.id = r.client_key_id`;

requestsRouter.get('/', (req, res) => {
  const parsed = requestListSchema.safeParse(req.query);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { limit, cursor, status, platform, q, clientKeyId } = parsed.data;
  const clauses = ['r.is_final = 1'];
  const values: Array<string | number> = [];
  if (cursor !== undefined) {
    clauses.push('r.id < ?');
    values.push(cursor);
  }
  if (status) {
    clauses.push('r.status = ?');
    values.push(status);
  }
  if (platform) {
    clauses.push('r.platform = ?');
    values.push(platform);
  }
  if (clientKeyId !== undefined) {
    clauses.push('r.client_key_id = ?');
    values.push(clientKeyId);
  }
  if (q) {
    clauses.push(
      "(r.request_id LIKE ? ESCAPE '\\' OR r.trace_id LIKE ? ESCAPE '\\' OR r.model_id LIKE ? ESCAPE '\\')",
    );
    const search = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    values.push(search, search, search);
  }
  const rows = getDb()
    .prepare(`${joinedRequest} WHERE ${clauses.join(' AND ')} ORDER BY r.id DESC LIMIT ?`)
    .all(...values, limit + 1) as RequestRow[];
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit).map(serialize);
  res.json({ data, pagination: { limit, hasMore, nextCursor: hasMore ? String(data.at(-1)!.id) : null } });
});

requestsRouter.get('/:id', (req, res) => {
  const id = parsePositiveResourceId(req.params.id);
  if (id === null) {
    res
      .status(400)
      .json({ error: { message: 'Provide a positive request ID from the request history.', param: 'id' } });
    return;
  }
  const row = getDb().prepare(`${joinedRequest} WHERE r.id = ? AND r.is_final = 1`).get(id) as
    RequestRow | undefined;
  if (!row) {
    res.status(404).json({ error: { message: 'Request not found.' } });
    return;
  }
  const attempts = row.trace_id
    ? (getDb()
        .prepare(`${joinedRequest} WHERE r.trace_id = ? ORDER BY r.attempt, r.id`)
        .all(row.trace_id) as RequestRow[])
    : [row];
  res.json({
    request: serialize(row),
    attempts: attempts.map(serialize),
    completeTrace: Boolean(row.trace_id),
  });
});
