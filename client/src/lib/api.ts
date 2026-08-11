const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, '')
const DEFAULT_TIMEOUT_MS = 45_000

interface ApiErrorPayload {
  error?: {
    message?: string
    type?: string
    code?: string
    [key: string]: unknown
  }
  message?: string
  [key: string]: unknown
}

export class ApiError extends Error {
  readonly status: number
  readonly type?: string
  readonly code?: string
  readonly details?: ApiErrorPayload

  constructor(message: string, status: number, payload?: ApiErrorPayload) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.type = payload?.error?.type
    this.code = payload?.error?.code
    this.details = payload
  }
}

export interface ApiFetchOptions extends RequestInit {
  timeoutMs?: number
}

function responseMessage(payload: ApiErrorPayload | undefined, fallback: string) {
  return payload?.error?.message ?? payload?.message ?? fallback
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new ApiError('The server returned malformed JSON.', response.status)
    }
  }

  return text
}

/** Fetch a dashboard API route with consistent JSON handling, cancellation, and errors. */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, headers, ...requestOptions } = options
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted) abortFromCaller()
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true })

  const timeout = window.setTimeout(
    () => controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError')),
    timeoutMs,
  )

  const requestHeaders = new Headers(headers)
  requestHeaders.set('Accept', 'application/json')
  if (requestOptions.body && !(requestOptions.body instanceof FormData) && !requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json')
  }

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...requestOptions,
      credentials: 'same-origin',
      headers: requestHeaders,
      signal: controller.signal,
    })
    const body = await parseResponseBody(response)

    if (!response.ok) {
      const payload = typeof body === 'object' && body !== null ? body as ApiErrorPayload : undefined
      const fallback = typeof body === 'string' && body.trim() ? body : `Request failed with HTTP ${response.status}`
      throw new ApiError(responseMessage(payload, fallback), response.status, payload)
    }

    return body as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (controller.signal.aborted) {
      const timedOut = controller.signal.reason instanceof DOMException && controller.signal.reason.name === 'TimeoutError'
      throw new ApiError(timedOut ? 'The server took too long to respond.' : 'The request was cancelled.', 0)
    }
    throw new ApiError(error instanceof Error ? error.message : 'Could not reach the LLMHarbor server.', 0)
  } finally {
    window.clearTimeout(timeout)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
}

export function getErrorMessage(error: unknown, fallback = 'Something went wrong.') {
  return error instanceof Error && error.message ? error.message : fallback
}

export function apiUrl(path: string) {
  return `${BASE_URL}${path}`
}
