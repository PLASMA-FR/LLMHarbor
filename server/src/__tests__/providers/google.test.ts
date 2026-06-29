import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleProvider } from '../../providers/google.js';

describe('GoogleProvider', () => {
  let provider: GoogleProvider;

  beforeEach(() => {
    provider = new GoogleProvider();
  });

  it('should have correct platform and name', () => {
    expect(provider.platform).toBe('google');
    expect(provider.name).toBe('Google AI Studio');
  });

  it('should call Gemini API and return OpenAI-compatible response', async () => {
    const mockResponse = {
      candidates: [{
        content: { parts: [{ text: 'Hello from Gemini!' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    };

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as any);

    const result = await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Hi' }],
      'gemini-2.5-pro',
    );

    expect(result.object).toBe('chat.completion');
    expect(result.choices[0].message.content).toBe('Hello from Gemini!');
    expect(result.choices[0].message.role).toBe('assistant');
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
    expect(result._routed_via?.platform).toBe('google');
  });

  it('should throw on API error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: () => Promise.resolve({ error: { message: 'Rate limit exceeded' } }),
    } as any);

    await expect(
      provider.chatCompletion('test-key', [{ role: 'user', content: 'Hi' }], 'gemini-2.5-pro')
    ).rejects.toThrow(/Rate limit exceeded/);
  });

  it('should validate key via models endpoint', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true } as any);
    expect(await provider.validateKey('valid-key')).toBe(true);

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 401 } as any);
    expect(await provider.validateKey('invalid-key')).toBe(false);
  });

  it('should translate system messages to systemInstruction', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'test-key',
      [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
      ],
      'gemini-2.5-pro',
    );

    expect(capturedBody.systemInstruction).toEqual({ parts: [{ text: 'You are helpful' }] });
    expect(capturedBody.contents).toHaveLength(1);
    expect(capturedBody.contents[0].role).toBe('user');
  });

  it('should translate OpenAI tools/tool_choice to Gemini tools/toolConfig', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Weather in Karachi?' }],
      'gemini-2.5-pro',
      {
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather for a city',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        }],
        tool_choice: {
          type: 'function',
          function: { name: 'get_weather' },
        },
      },
    );

    expect(capturedBody.tools[0].functionDeclarations[0].name).toBe('get_weather');
    expect(capturedBody.toolConfig.functionCallingConfig.mode).toBe('ANY');
    expect(capturedBody.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(['get_weather']);
  });

  it('should translate Gemini functionCall response to OpenAI tool_calls', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{
          content: {
            parts: [{
              functionCall: {
                id: 'call_123',
                name: 'get_weather',
                args: { city: 'Lahore' },
              },
            }],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 3,
          totalTokenCount: 15,
        },
      }),
    } as any);

    const result = await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'What is the weather?' }],
      'gemini-2.5-pro',
    );

    expect(result.choices[0].finish_reason).toBe('tool_calls');
    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message.tool_calls?.[0].id).toBe('call_123');
    expect(result.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
    expect(result.choices[0].message.tool_calls?.[0].function.arguments).toBe('{"city":"Lahore"}');
  });

  it('should preserve and pass through thought_signature', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{
            content: {
              parts: [{
                thoughtSignature: 'sig_123',
                functionCall: {
                  id: 'call_123',
                  name: 'get_weather',
                  args: { city: 'London' },
                },
              }],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      } as any;
    });

    // 1. Check extraction
    const result = await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Weather?' }],
      'gemini-2.5-pro',
    );

    expect(result.choices[0].message.tool_calls?.[0].thought_signature).toBe('sig_123');

    // 2. Check injection in next turn
    await provider.chatCompletion(
      'test-key',
      [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_123',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"London"}' },
            thought_signature: 'sig_123',
          }],
        },
        { role: 'tool', tool_call_id: 'call_123', content: '{"temp": 20}' },
      ],
      'gemini-2.5-pro',
    );

    const assistantEntry = capturedBody.contents.find((c: any) => c.role === 'model');
    expect(assistantEntry.parts[0].thoughtSignature).toBe('sig_123');
    expect(assistantEntry.parts[0].functionCall.name).toBe('get_weather');
  });

  // ── Streaming ──────────────────────────────────────────────────────────────
  // Build a Response-shaped object backed by a ReadableStream so the provider's
  // `res.body.getReader()` path executes for real (Node 20+ has both globally).
  function sseResponse(frames: string[]): any {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const f of frames) controller.enqueue(encoder.encode(f));
        controller.close();
      },
    });
    return { ok: true, body: stream };
  }

  async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const c of gen) out.push(c);
    return out;
  }

  it('streams text deltas and emits a final stop chunk', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}\n\n',
    ]));

    const chunks = await collect(provider.streamChatCompletion(
      'test-key',
      [{ role: 'user', content: 'Hi' }],
      'gemini-2.5-pro',
    ));

    const text = chunks.map(c => c.choices[0].delta.content ?? '').join('');
    expect(text).toBe('Hello');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
  });

  it('skips a malformed SSE frame instead of aborting the whole stream', async () => {
    // Regression: previously an unguarded JSON.parse would propagate, killing
    // the stream after a single bad chunk. Other providers (openai-compat,
    // cohere, cloudflare) already protect this path with try/catch.
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {oops not json\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]));

    const chunks = await collect(provider.streamChatCompletion(
      'test-key',
      [{ role: 'user', content: 'Hi' }],
      'gemini-2.5-pro',
    ));

    const text = chunks.map(c => c.choices[0].delta.content ?? '').join('');
    expect(text).toBe('Hello');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
  });

  it('streams functionCall parts as tool_calls with finish_reason=tool_calls', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_1","name":"get_weather","args":{"city":"Karachi"}}}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}\n\n',
    ]));

    const chunks = await collect(provider.streamChatCompletion(
      'test-key',
      [{ role: 'user', content: 'Weather?' }],
      'gemini-2.5-pro',
    ));

    const toolDeltas = chunks.flatMap(c => c.choices[0].delta.tool_calls ?? []);
    expect(toolDeltas).toHaveLength(1);
    expect(toolDeltas[0].function.name).toBe('get_weather');
    expect(toolDeltas[0].function.arguments).toBe('{"city":"Karachi"}');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('tool_calls');
  });

  it('streams Antigravity non-thinking models via generateContent fallback', async () => {
    let capturedUrl = '';
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      expect(JSON.parse((init as any).body).model).toBe('gemini-2.5-pro');
      return {
        ok: true,
        json: () => Promise.resolve({
          response: {
            candidates: [{ content: { parts: [{ text: 'oauth stream ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
          },
        }),
      } as any;
    });

    const chunks = await collect(provider.streamChatCompletion(
      'oauth-access-token',
      [{ role: 'user', content: 'Hi' }],
      'gemini-2.5-pro',
      { oauth: { accountId: 7, provider: 'antigravity', accountHint: 'captain@example.com', metadata: { cloudaicompanionProject: 'cloud-project-123' } } },
    ));

    expect(capturedUrl).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent');
    expect(chunks.map(c => c.choices[0].delta.content ?? '').join('')).toBe('oauth stream ok');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
  });

  it('uses Antigravity Code Assist wrapper for Google browser OAuth requests', async () => {
    let capturedUrl = '';
    let capturedHeaders: any;
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedHeaders = (init as any).headers;
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          response: {
            candidates: [{ content: { parts: [{ text: 'ahoy' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
          },
        }),
      } as any;
    });

    const result = await provider.chatCompletion(
      'oauth-access-token',
      [{ role: 'user', content: 'Hi' }],
      'gemini-2.5-pro',
      { oauth: { accountId: 7, provider: 'antigravity', accountHint: 'captain@example.com', metadata: { cloudaicompanionProject: 'cloud-project-123' } } },
    );

    expect(capturedUrl).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent');
    expect(capturedHeaders.Authorization).toBe('Bearer oauth-access-token');
    expect(capturedHeaders['User-Agent']).toBe('antigravity/1.15.8');
    expect(capturedHeaders['X-Goog-Api-Client']).toBe('google-cloud-sdk vscode');
    expect(capturedHeaders['X-Machine-Session-Id']).toBeTruthy();
    expect(capturedBody).toMatchObject({
      project: 'cloud-project-123',
      model: 'gemini-2.5-pro',
      userAgent: 'antigravity',
      requestType: 'agent',
    });
    expect(capturedBody.requestId).toMatch(/^agent-/);
    expect(capturedBody.request.sessionId).toEqual(expect.any(String));
    expect(capturedBody.request.sessionId).toHaveLength(49);
    expect(capturedBody.request.systemInstruction.parts[0].text).toContain('You are Antigravity');
    expect(capturedBody.request.systemInstruction.parts[1].text).toContain('[ignore]');
    expect(capturedBody.request.contents[0].parts[0].text).toBe('Hi');
    expect(result.choices[0].message.content).toBe('ahoy');
  });

  it('uses Code Assist SSE endpoint for non-streaming Antigravity thinking models', async () => {
    let capturedUrl = '';
    let capturedAccept = '';
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedAccept = String(((init as any).headers as any).Accept ?? '');
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"think"}]}}]}}\n\n' +
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ing"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":2,"totalTokenCount":4}}}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });

    const result = await provider.chatCompletion(
      'oauth-access-token',
      [{ role: 'user', content: 'Hi' }],
      'gemini-3-pro-preview',
      { oauth: { accountId: 7, provider: 'antigravity', accountHint: 'captain@example.com', metadata: { cloudaicompanionProject: 'cloud-project-123' } } },
    );

    expect(capturedUrl).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
    expect(capturedAccept).toBe('text/event-stream');
    expect(result.choices[0].message.content).toBe('thinking');
    expect(result.usage.total_tokens).toBe(4);
  });
});
