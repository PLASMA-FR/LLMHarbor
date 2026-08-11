import type { Request, Response, NextFunction } from 'express';
import { errorStatus, redactSensitive } from '../lib/errors.js';

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  const requestId = String(res.locals.requestId ?? 'unknown');
  const status = errorStatus(err) ?? 500;
  console.error(`[Error] request=${requestId} method=${req.method} path=${req.path} status=${status} message=${redactSensitive(err.message)}`);

  if (res.headersSent) return next(err);

  const isBodyTooLarge = (err as any).type === 'entity.too.large' || status === 413;
  const isBadJson = (err as any).type === 'entity.parse.failed';
  const expose = (err as any).expose === true || status < 500;
  const message = isBodyTooLarge
    ? 'Request body is too large.'
    : isBadJson
      ? 'Request body contains invalid JSON.'
      : expose
        ? redactSensitive(err.message)
        : 'Internal server error.';
  res.status(status).json({
    error: {
      message,
      type: isBodyTooLarge ? 'invalid_request_error' : isBadJson ? 'invalid_request_error' : status >= 500 ? 'server_error' : 'request_error',
      ...((err as any).code ? { code: String((err as any).code) } : {}),
      request_id: requestId,
    },
  });
}
