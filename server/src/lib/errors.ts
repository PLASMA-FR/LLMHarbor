const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi,
  /(access_token|refresh_token|authToken|api[_-]?key|client_secret|code_verifier)["'=:\s]+[^\s&"']+/gi,
  /([?&](?:key|token|access_token|refresh_token)=)[^&\s]+/gi,
  /\b(sk-[A-Za-z0-9_-]{12,}|llmharbor-[A-Fa-f0-9]{16,}|GOCSPX-[A-Za-z0-9_-]+)\b/g,
];

export function redactSensitive(value: unknown, maxLength = 1000): string {
  let result = String(value ?? 'unknown error');
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, match => {
      if (/^Bearer\s/i.test(match)) return 'Bearer [REDACTED]';
      const separator = match.match(/^([^:=?&]+["'=:\s]+)/)?.[1];
      if (separator) return `${separator}[REDACTED]`;
      const queryPrefix = match.match(/^([?&][^=]+=)/)?.[1];
      return queryPrefix ? `${queryPrefix}[REDACTED]` : '[REDACTED]';
    });
  }
  return result.slice(0, maxLength);
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly expose: boolean;

  constructor(status: number, code: string, message: string, expose = status < 500) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.expose = expose;
  }
}

export function errorStatus(error: unknown): number | null {
  const status = Number((error as { status?: unknown } | null)?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

/**
 * Return a bounded, frontend-safe category for a failure originating outside
 * LLMHarbor. Never echo an upstream response body: a custom endpoint can echo
 * its Authorization value in arbitrary formats that pattern redaction cannot
 * reliably recognize.
 */
export function safeUpstreamFailure(error: unknown, fallback = 'Upstream provider request failed.'): string {
  const status = Number((error as { statusCode?: unknown } | null)?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return `Upstream provider returned HTTP ${status}.`;
  }
  const code = String((error as { code?: unknown } | null)?.code ?? '').toLowerCase();
  if (code === 'malformed_provider_response') return 'Upstream provider returned a malformed response.';
  const name = String((error as { name?: unknown } | null)?.name ?? '');
  const message = String((error as { message?: unknown } | null)?.message ?? '');
  if (name === 'TimeoutError' || /\b(timeout|timed out|etimedout)\b/i.test(message)) {
    return 'Upstream provider request timed out.';
  }
  if (name === 'AbortError') return 'Upstream provider request was cancelled.';
  return fallback;
}
