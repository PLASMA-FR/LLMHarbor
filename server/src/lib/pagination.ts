import type { Request, Response } from 'express';
import { z } from 'zod';
import { sendValidationError } from './validation.js';

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z
    .string()
    .regex(/^[1-9]\d*$/, 'Use the nextCursor returned by the previous page.')
    .transform(Number)
    .refine(Number.isSafeInteger, 'Cursor is out of range.')
    .optional(),
});

/** Pagination is opt-in so existing callers keep receiving bare arrays. */
export function collectionResponse<T extends { id: number }>(req: Request, res: Response, rows: T[]): void {
  if (req.query.limit === undefined && req.query.cursor === undefined) {
    res.json(rows);
    return;
  }
  const parsed = paginationSchema.safeParse({ limit: req.query.limit, cursor: req.query.cursor });
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { limit, cursor } = parsed.data;
  const eligible = rows.filter((row) => cursor === undefined || row.id < cursor).sort((a, b) => b.id - a.id);
  const data = eligible.slice(0, limit);
  const hasMore = eligible.length > limit;
  res.json({ data, pagination: { limit, hasMore, nextCursor: hasMore ? String(data.at(-1)!.id) : null } });
}
