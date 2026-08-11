import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudflareProvider } from '../../providers/cloudflare.js';

describe('CloudflareProvider', () => {
  let provider: CloudflareProvider;

  beforeEach(() => {
    provider = new CloudflareProvider();
  });

  it('should have correct platform and name', () => {
    expect(provider.platform).toBe('cloudflare');
    expect(provider.name).toBe('Cloudflare Workers AI');
  });

  it('should parse account_id:token key format', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = (init as any).headers;
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'chatcmpl-cf',
          object: 'chat.completion',
          created: 123,
          model: '@cf/meta/llama-3.1-70b-instruct',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from CF!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      } as any;
    });

    const result = await provider.chatCompletion(
      'abc123:my-token-here',
      [{ role: 'user', content: 'Hi' }],
      '@cf/meta/llama-3.1-70b-instruct',
    );

    expect(capturedUrl).toContain('abc123');
    expect(capturedUrl).toContain('/ai/v1/chat/completions');
    expect(capturedHeaders['Authorization']).toBe('Bearer my-token-here');
    expect(capturedBody.model).toBe('@cf/meta/llama-3.1-70b-instruct');
    expect(result.choices[0].message.content).toBe('Hello from CF!');
  });

  it('should throw if key format is wrong', async () => {
    await expect(
      provider.chatCompletion('no-colon-here', [{ role: 'user', content: 'Hi' }], 'model')
    ).rejects.toMatchObject({ statusCode: 401, retryable: true, code: 'invalid_provider_credential' });
  });

  it('should convert null assistant content to empty string (CF rejects null)', async () => {
    let capturedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'chatcmpl-cf',
          object: 'chat.completion',
          created: 123,
          model: '@cf/meta/llama-3.1-70b-instruct',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'abc123:token',
      [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Karachi"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp":30}' },
      ],
      '@cf/meta/llama-3.1-70b-instruct',
    );

    expect(capturedBody.messages[1].content).toBe('');
    expect(capturedBody.messages[1].tool_calls).toHaveLength(1);
  });

  it('rejects malformed successful responses', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(Response.json({ success: true }) as any);
    await expect(provider.chatCompletion('abc123:token', [{ role: 'user', content: 'Hi' }], 'model'))
      .rejects.toMatchObject({ code: 'malformed_provider_response', retryable: true });
  });

  it('uses typed upstream errors and rejects an all-malformed stream', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(Response.json({ errors: [{ message: 'denied' }] }, { status: 403 }) as any);
    await expect(provider.chatCompletion('abc123:token', [{ role: 'user', content: 'Hi' }], 'model'))
      .rejects.toMatchObject({ statusCode: 403, retryable: true });

    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(
      'data: {bad-json}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ) as any);
    await expect(collect(provider.streamChatCompletion('abc123:token', [{ role: 'user', content: 'Hi' }], 'model')))
      .rejects.toMatchObject({ code: 'malformed_provider_response' });
  });

  it('validates both the token and its configured account scope', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(Response.json({ success: true, result: { status: 'active' } }))
      .mockResolvedValueOnce(Response.json({ success: true, result: { id: 'account-123' } }));

    await expect(provider.validateKey('account-123:token')).resolves.toBe(true);
    expect(fetchSpy.mock.calls.at(-1)?.[0]).toBe('https://api.cloudflare.com/client/v4/accounts/account-123');

    fetchSpy
      .mockResolvedValueOnce(Response.json({ success: true, result: { status: 'active' } }))
      .mockResolvedValueOnce(Response.json({ success: false }, { status: 404 }));
    await expect(provider.validateKey('wrong-account:token')).resolves.toBe(false);
  });
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}
