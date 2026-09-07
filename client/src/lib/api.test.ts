import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiFetch } from './api'

describe('dashboard API client', () => {
  beforeEach(() => vi.stubGlobal('window', globalThis))
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('reads JSON and problem+json responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })))
    await expect(apiFetch('/api/ping')).resolves.toEqual({ ok: true })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":{"message":"Unavailable","code":"unavailable"}}', { status: 503, headers: { 'Content-Type': 'application/problem+json' } })))
    await expect(apiFetch('/api/ping')).rejects.toMatchObject({ status: 503, message: 'Unavailable', code: 'unavailable' })
  })

  it('explains a misconfigured proxy instead of treating an HTML page as API data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>dashboard</html>', { headers: { 'Content-Type': 'text/html' } })))
    await expect(apiFetch('/api/keys')).rejects.toThrow('Expected JSON')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>proxy internals</html>', { status: 502 })))
    await expect(apiFetch('/api/keys')).rejects.toMatchObject({ message: 'Request failed with HTTP 502' })
  })

  it('handles empty successful responses and rejects malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    await expect(apiFetch('/api/keys', { method: 'DELETE' })).resolves.toBeUndefined()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{', { headers: { 'Content-Type': 'application/json' } })))
    await expect(apiFetch('/api/keys')).rejects.toBeInstanceOf(ApiError)
  })

  it('cancels a request at the configured timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })))
    const request = expect(apiFetch('/api/keys', { timeoutMs: 100 })).rejects.toMatchObject({ status: 0, message: 'The server took too long to respond.' })
    await vi.advanceTimersByTimeAsync(100)
    await request
  })
})
