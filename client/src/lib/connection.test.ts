import { describe, expect, it } from 'vitest'
import { connectionBaseUrl, integrationExample, normalizeApiBase } from './connection'

describe('integration URL and examples', () => {
  const combined = {
    splitMode: false,
    dashboard: { host: '127.0.0.1', port: 3001 },
    publicApi: { host: '127.0.0.1', port: 3001, basePath: '/v1' },
  }
  it('uses the server listener for development SDK examples', () => {
    expect(connectionBaseUrl(combined, 'http://localhost:5173', '/', true)).toBe('http://localhost:3001/v1')
  })
  it('preserves a production reverse-proxy prefix', () => {
    expect(connectionBaseUrl(combined, 'https://gateway.example', '/harbor/')).toBe(
      'https://gateway.example/harbor/v1',
    )
  })
  it('supports a split IPv6 listener', () => {
    expect(
      connectionBaseUrl(
        { ...combined, splitMode: true, publicApi: { host: '::1', port: 3002, basePath: '/v1' } },
        'http://localhost:3001',
      ),
    ).toBe('http://[::1]:3002/v1')
  })
  it('normalizes common base URL mistakes', () => {
    expect(normalizeApiBase('http://localhost:3001')).toBe('http://localhost:3001/v1')
    expect(normalizeApiBase('https://gateway.example/harbor/v1/chat/completions/')).toBe(
      'https://gateway.example/harbor/v1',
    )
    expect(() => normalizeApiBase('https://key@example.com/v1')).toThrow('without credentials')
  })
  it('generates SDK examples using a client key environment variable', () => {
    expect(integrationExample('javascript', 'http://localhost:3001/v1')).toContain(
      'process.env.LLMHARBOR_API_KEY',
    )
    expect(integrationExample('python', 'http://localhost:3001/v1')).toContain(
      'base_url="http://localhost:3001/v1"',
    )
    const curl = integrationExample('curl', "https://example.test/a'b/v1")
    expect(curl).toContain("'https://example.test/a'\\''b/v1/chat/completions'")
    expect(curl).toContain('Authorization: Bearer $LLMHARBOR_API_KEY')
  })
})
