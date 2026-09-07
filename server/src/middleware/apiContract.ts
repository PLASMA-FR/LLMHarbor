import type { Request, Response, NextFunction } from 'express';

const categories: Record<number, [string, string]> = {
  400: ['invalid_request_error', 'invalid_request'],
  401: ['authentication_error', 'invalid_api_key'],
  403: ['forbidden', 'access_denied'],
  404: ['not_found', 'not_found'],
  405: ['invalid_request_error', 'method_not_allowed'],
  409: ['conflict', 'resource_conflict'],
  410: ['gone', 'resource_gone'],
  413: ['invalid_request_error', 'request_too_large'],
  415: ['invalid_request_error', 'unsupported_media_type'],
  429: ['rate_limit_error', 'rate_limit_exceeded'],
  502: ['provider_error', 'upstream_error'],
  503: ['routing_error', 'service_unavailable'],
  504: ['provider_error', 'upstream_timeout'],
};

/** Add a common diagnostic envelope at the JSON boundary, preserving legacy
 * fields and route-specific codes. Streaming payloads retain their own contract.
 */
export function apiContract(req: Request, res: Response, next: NextFunction): void {
  const isApiRequest = /^\/(?:api|v1|e)(?:\/|$)/.test(req.path);
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode >= 400 && isApiRequest) {
      const record =
        body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
      const error =
        record.error && typeof record.error === 'object' ? (record.error as Record<string, unknown>) : {};
      const [type, code] = categories[res.statusCode] ?? ['server_error', 'internal_error'];
      if (res.statusCode === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="LLMHarbor"');
      return json({
        ...record,
        error: {
          message:
            typeof record.message === 'string' ? record.message : 'The request could not be completed.',
          type,
          code,
          param: null,
          ...error,
          request_id: String(res.locals.requestId ?? 'unknown'),
        },
      });
    }
    return json(body);
  };
  next();
}

export function requireJsonBody(req: Request, res: Response, next: NextFunction): void {
  const hasBody = Number(req.get('Content-Length') ?? 0) > 0 || Boolean(req.get('Transfer-Encoding'));
  const binaryBackup = /^\/api\/(?:backups|settings\/backup)\/import\/database\/?$/.test(req.path);
  if (
    hasBody &&
    !binaryBackup &&
    ['POST', 'PUT', 'PATCH'].includes(req.method) &&
    /^\/(?:api|v1|e)(?:\/|$)/.test(req.path) &&
    !req.is(['application/json', 'application/*+json'])
  ) {
    res
      .status(415)
      .json({
        error: {
          message: 'Send this request as JSON with Content-Type: application/json.',
          param: 'Content-Type',
        },
      });
    return;
  }
  next();
}
