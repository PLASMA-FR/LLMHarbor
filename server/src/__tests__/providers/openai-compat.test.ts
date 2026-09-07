import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';

describe('OpenAICompatProvider', () => {
  let provider: OpenAICompatProvider;

  beforeEach(() => {
    provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'TestProvider',
      baseUrl: 'https://api.test.com/v1',
      extraHeaders: { 'X-Custom': 'test' },
    });
  });

  it('should set platform and name from config', () => {
    expect(provider.platform).toBe('groq');
    expect(provider.name).toBe('TestProvider');
  });

  it('should call API with correct URL and headers', async () => {
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
          id: 'test-id',
          object: 'chat.completion',
          created: 123,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion('my-key', [{ role: 'user', content: 'test' }], 'test-model');

    expect(capturedUrl).toBe('https://api.test.com/v1/chat/completions');
    expect(capturedHeaders['Authorization']).toBe('Bearer my-key');
    expect(capturedHeaders['X-Custom']).toBe('test');
    expect(capturedBody.messages[0].role).toBe('user');
  });

  it('should pass tool-calling params through untouched', async () => {
    let capturedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'test-id',
          object: 'chat.completion',
          created: 123,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [] }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'my-key',
      [{ role: 'user', content: 'what is weather?' }],
      'test-model',
      {
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        }],
        tool_choice: 'required',
        parallel_tool_calls: true,
      },
    );

    expect(capturedBody.tools).toHaveLength(1);
    expect(capturedBody.tool_choice).toBe('required');
    expect(capturedBody.parallel_tool_calls).toBe(true);
  });

  it('should throw on error response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Rate Limited',
      json: () => Promise.resolve({ error: { message: 'Too many requests' } }),
    } as any);

    await expect(
      provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model')
    ).rejects.toThrow(/Too many requests/);
  });

  it('rejects malformed successful responses instead of forwarding provider-specific garbage', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.reject(new SyntaxError('bad json')),
    } as any);
    await expect(provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model'))
      .rejects.toMatchObject({ code: 'malformed_provider_response', retryable: true });

    vi.spyOn(global, 'fetch').mockResolvedValueOnce(Response.json({ object: 'unexpected', choices: [] }) as any);
    await expect(provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model'))
      .rejects.toThrow(/without choices/i);
  });

  it('rejects malformed tool calls and normalizes negative choice indices', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(Response.json({
      choices: [{
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup' } }] },
        finish_reason: 'tool_calls',
      }],
    }) as any);
    await expect(provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model'))
      .rejects.toThrow(/malformed tool call/i);

    vi.spyOn(global, 'fetch').mockResolvedValueOnce(Response.json({
      choices: [{ index: -3, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }) as any);
    const response = await provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model');
    expect(response.choices[0].index).toBe(0);
  });

  it('should validate key using models endpoint', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 200 } as any);
    expect(await provider.validateKey('valid')).toBe(true);
  });

  it('lists OpenAI-compatible /models catalog rows with provider headers', async () => {
    const catalogProvider = new OpenAICompatProvider({
      platform: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      extraHeaders: { 'X-Title': 'LLMHarbor' },
    });
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    vi.spyOn(global, 'fetch').mockImplementationOnce(async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = (init as any).headers;
      return Response.json({
        data: [
          { id: 'deepseek/deepseek-chat-v3.1:free', name: 'DeepSeek Free', pricing: { prompt: '0', completion: '0' }, context_length: 131072 },
        ],
      });
    });

    const models = await catalogProvider.listModels('or-key');

    expect(capturedUrl).toBe('https://openrouter.ai/api/v1/models');
    expect(capturedHeaders.Authorization).toBe('Bearer or-key');
    expect(capturedHeaders['X-Title']).toBe('LLMHarbor');
    expect(models[0]).toMatchObject({
      id: 'deepseek/deepseek-chat-v3.1:free',
      displayName: 'DeepSeek Free',
      contextWindow: 131072,
    });
  });

  it('supports provider-specific model catalog URLs separate from inference base URLs', async () => {
    const catalogProvider = new OpenAICompatProvider({
      platform: 'github',
      name: 'GitHub Models',
      baseUrl: 'https://models.github.ai/inference',
      modelsUrl: 'https://models.github.ai/catalog/models',
    });
    let capturedUrl = '';
    vi.spyOn(global, 'fetch').mockImplementationOnce(async (url) => {
      capturedUrl = String(url);
      return Response.json([
        { id: 'openai/gpt-4.1', name: 'GPT-4.1', rate_limit_tier: 'high', limits: { max_input_tokens: 1048576 } },
      ]);
    });

    const models = await catalogProvider.listModels('gh-token');

    expect(capturedUrl).toBe('https://models.github.ai/catalog/models');
    expect(models[0]).toMatchObject({ id: 'openai/gpt-4.1', displayName: 'GPT-4.1', contextWindow: 1048576 });
    expect(models[0].raw).toMatchObject({ rate_limit_tier: 'high' });
  });

  it('normalizes common custom /models response shapes', async () => {
    const catalogProvider = new OpenAICompatProvider({
      platform: 'custom-local-vllm',
      name: 'Local vLLM',
      baseUrl: 'http://127.0.0.1:18888/v1',
    });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(Response.json({
      models: [
        'string-model',
        { name: 'name-only-model', context_window: '8192' },
        { model_id: 'model-id-field', display_name: 'Model ID Field', input_token: '0', output_token: '0' },
      ],
    }) as any);

    const models = await catalogProvider.listModels('');

    expect(models).toEqual([
      expect.objectContaining({ id: 'string-model', displayName: 'string-model' }),
      expect.objectContaining({ id: 'name-only-model', contextWindow: 8192 }),
      expect.objectContaining({ id: 'model-id-field', displayName: 'Model ID Field', pricing: { prompt: '0', completion: '0' } }),
    ]);
  });

  it('validateKey returns false on confirmed 401', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(body, { status: 401 }) as any);
    expect(await provider.validateKey('bad')).toBe(false);
    expect(cancelled).toBe(true);
  });

  it('validateKey reports transient HTTP failures as provider errors', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('unavailable', { status: 503 }) as any);
    await expect(provider.validateKey('temporarily-unavailable'))
      .rejects.toMatchObject({ statusCode: 503, retryable: true });
  });

  it('validateKey propagates transport errors instead of swallowing', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(provider.validateKey('any')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('blocks redirects for user-configured endpoints', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
      response.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an IP listener');
    const custom = new OpenAICompatProvider({
      platform: 'custom-local',
      name: 'Custom local',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      allowRedirects: false,
    });
    try {
      await expect(custom.listModels('key')).rejects.toMatchObject({ statusCode: 302 });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('rejects an empty or wholly malformed upstream stream', async () => {
    const empty = new ReadableStream({ start(controller) { controller.close(); } });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, body: empty } as any);
    await expect(collectStream(provider.streamChatCompletion('key', [{ role: 'user', content: 'hi' }], 'model')))
      .rejects.toThrow(/empty stream/i);

    const encoder = new TextEncoder();
    const malformed = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {not-json}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, body: malformed } as any);
    await expect(collectStream(provider.streamChatCompletion('key', [{ role: 'user', content: 'hi' }], 'model')))
      .rejects.toMatchObject({ code: 'malformed_provider_response' });
  });

  it('forwards stream_options and accepts a valid usage-only trailer after a completion choice', async () => {
    let requestBody: any;
    const encoder = new TextEncoder();
    vi.spyOn(global, 'fetch').mockImplementationOnce(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }));
    });
    const chunks = await collectStream(provider.streamChatCompletion(
      'key', [{ role: 'user', content: 'hi' }], 'model', { stream_options: { include_usage: true } },
    ));
    expect(requestBody.stream_options).toEqual({ include_usage: true });
    expect(chunks).toHaveLength(3);
    expect((chunks[1] as any).usage.total_tokens).toBe(3);
    expect((chunks[2] as any).choices[0].finish_reason).toBe('stop');
  });

  it('normalizes sparse stream metadata and choice indices consistently', async () => {
    const encoder = new TextEncoder();
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"index":-1,"delta":{"content":"a"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"changes-must-not-leak","choices":[{"delta":{"content":"b"},"finish_reason":"stop"}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    })));
    const chunks = await collectStream(provider.streamChatCompletion('key', [{ role: 'user', content: 'hi' }], 'requested-model')) as any[];
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ object: 'chat.completion.chunk', model: 'requested-model', choices: [{ index: 0 }] });
    expect(chunks[0].id).toMatch(/^chatcmpl-/);
    expect(chunks[1].id).toBe(chunks[0].id);
    expect(chunks[1].created).toBe(chunks[0].created);
    expect(chunks[1].choices[0].index).toBe(0);
  });

  it('rejects a stream delta with non-string content', async () => {
    const encoder = new TextEncoder();
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":{"text":"bad"}}}]}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    })));
    await expect(collectStream(provider.streamChatCompletion('key', [{ role: 'user', content: 'hi' }], 'model')))
      .rejects.toMatchObject({ code: 'malformed_provider_response' });
  });

  it('preserves a terminal safety refusal without falling back as an empty stream', async () => {
    const encoder = new TextEncoder();
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"refusal":"I cannot help with that."},"finish_reason":"content_filter"}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    })));
    const chunks = await collectStream(provider.streamChatCompletion('key', [{ role: 'user', content: 'unsafe' }], 'model')) as any[];
    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0]).toMatchObject({
      delta: { refusal: 'I cannot help with that.' },
      finish_reason: 'content_filter',
    });
  });

  it('rejects usage-only streams and choices:[] frames without valid usage', async () => {
    const encoder = new TextEncoder();
    const stream = (frame: string) => new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${frame}\n\ndata: [DONE]\n\n`));
        controller.close();
      },
    });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(stream('{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":0,"total_tokens":1}}')));
    await expect(collectStream(provider.streamChatCompletion('key', [{ role: 'user', content: 'hi' }], 'model')))
      .rejects.toMatchObject({ code: 'malformed_provider_response' });

    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(stream('{"choices":[]}')));
    await expect(collectStream(provider.streamChatCompletion('key', [{ role: 'user', content: 'hi' }], 'model')))
      .rejects.toMatchObject({ code: 'malformed_provider_response' });
  });

  it('keeps the timeout active while a non-streaming response body is consumed', async () => {
    class ShortBodyTimeoutProvider extends OpenAICompatProvider {
      protected override fetchWithTimeout(url: string, init: RequestInit, headersTimeoutMs?: number) {
        return super.fetchWithTimeout(url, init, headersTimeoutMs, 20);
      }
    }
    const shortTimeout = new ShortBodyTimeoutProvider({
      platform: 'custom-timeout', name: 'Slow body', baseUrl: 'http://127.0.0.1:8080/v1', timeoutMs: 20,
    });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(new ReadableStream({
      start() { /* headers arrive, but the body never makes progress */ },
    }), { status: 200 }));
    await expect(shortTimeout.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model'))
      .rejects.toThrow(/body timed out/i);
  });

  it('propagates caller cancellation into response body consumption', async () => {
    const controller = new AbortController();
    let upstreamSignal: AbortSignal | null = null;
    vi.spyOn(global, 'fetch').mockImplementationOnce(async (_url, init) => {
      upstreamSignal = init?.signal as AbortSignal;
      return {
        ok: true,
        json: () => init?.signal?.aborted
          ? Promise.reject(init.signal.reason)
          : new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          }),
      } as any;
    });
    const completion = provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model', { signal: controller.signal });
    controller.abort();
    await expect(completion).rejects.toThrow();
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it('folds reasoning_content into content when content is empty (Z.ai glm-4.5-flash style)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '', reasoning_content: 'the actual answer' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('the actual answer');
  });

  it('flattens array content into a string (Mistral magistral style)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('part one part two');
  });

  it('folds reasoning into content when content is empty (Ollama style — bare `reasoning` field)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '', reasoning: 'ollama answer' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('ollama answer');
  });

  it('prefers reasoning_content over reasoning when both are present', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '', reasoning_content: 'preferred', reasoning: 'fallback' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('preferred');
  });

  it('does NOT fold reasoning_content when tool_calls are present', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            reasoning_content: 'I am thinking about the tool',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
  });

  it('leaves real string content untouched', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'normal answer', reasoning_content: 'should not override' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('normal answer');
  });

  it('does not duplicate cumulative ChatGPT Codex OAuth stream snapshots', async () => {
    const openai = new OpenAICompatProvider({ platform: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' });
    const stream = sseStream([
      { response: { output_text: 'Hello' } },
      { response: { output_text: 'Hello!' } },
      { item: { content: [{ text: 'Hello!' }] } },
    ]);
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, body: stream } as any);

    const result = await openai.chatCompletion(
      'token',
      [{ role: 'user', content: 'hello' }],
      'gpt-5.5',
      { oauth: { accountId: 1, provider: 'openai' } },
    );

    expect(result.choices[0].message.content).toBe('Hello!');
  });

  it('maps max_tokens to max_output_tokens for the ChatGPT Responses adapter', async () => {
    const openai = new OpenAICompatProvider({ platform: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' });
    let requestBody: any;
    vi.spyOn(global, 'fetch').mockImplementationOnce(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return { ok: true, body: sseStream([{ delta: 'ok' }]) } as any;
    });
    await openai.chatCompletion(
      'token', [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'hello' }], 'gpt-5.5',
      { max_tokens: 321, oauth: { accountId: 1, provider: 'openai' } },
    );
    expect(requestBody.max_output_tokens).toBe(321);
    expect(requestBody.instructions).toBe('Be concise.');
  });

  it('streams only suffixes for cumulative ChatGPT Codex OAuth events', async () => {
    const openai = new OpenAICompatProvider({ platform: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' });
    const stream = sseStream([
      { response: { output_text: 'I’m' } },
      { response: { output_text: 'I’m doing well' } },
      { response: { output_text: 'I’m doing well, thanks!' } },
    ]);
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, body: stream } as any);

    const chunks: string[] = [];
    let finishReason: string | null = null;
    for await (const chunk of openai.streamChatCompletion(
      'token',
      [{ role: 'user', content: 'how are you' }],
      'gpt-5.5',
      { oauth: { accountId: 1, provider: 'openai' } },
    )) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) chunks.push(content);
      if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
    }

    expect(chunks.join('')).toBe('I’m doing well, thanks!');
    expect(finishReason).toBe('stop');
  });

  it('does not expose reasoning or function-argument deltas as assistant text', async () => {
    const openai = new OpenAICompatProvider({ platform: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      body: sseStream([
        { type: 'response.reasoning_text.delta', delta: 'private reasoning' },
        { type: 'response.function_call_arguments.delta', delta: '{"secret":true}' },
        { type: 'response.output_text.delta', delta: 'public answer' },
      ]),
    } as any);

    const result = await openai.chatCompletion(
      'token', [{ role: 'user', content: 'hello' }], 'gpt-5.5',
      { oauth: { accountId: 1, provider: 'openai' } },
    );
    expect(result.choices[0].message.content).toBe('public answer');
  });

  it('normalizes ChatGPT Responses refusals without routing around them', async () => {
    const openai = new OpenAICompatProvider({ platform: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      body: sseStream([
        { type: 'response.refusal.delta', delta: 'I cannot help with that.' },
      ]),
    } as any);

    const chunks = await collectStream(openai.streamChatCompletion(
      'token', [{ role: 'user', content: 'hello' }], 'gpt-5.5',
      { oauth: { accountId: 1, provider: 'openai' } },
    )) as any[];
    expect(chunks.map(chunk => chunk.choices[0]?.delta?.refusal ?? '').join('')).toBe('I cannot help with that.');
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('content_filter');
  });

  it('rejects an empty ChatGPT Codex OAuth stream', async () => {
    const openai = new OpenAICompatProvider({ platform: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, body: sseStream([]) } as any);
    await expect(openai.chatCompletion(
      'token', [{ role: 'user', content: 'hello' }], 'gpt-5.5',
      { oauth: { accountId: 1, provider: 'openai' } },
    )).rejects.toMatchObject({ code: 'malformed_provider_response' });
  });

  it('rejects truncated ChatGPT Codex OAuth streams after partial output', async () => {
    const openai = new OpenAICompatProvider({ platform: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      body: truncatedSseStream([{ type: 'response.output_text.delta', delta: 'partial' }]),
    } as any);
    await expect(openai.chatCompletion(
      'token', [{ role: 'user', content: 'hello' }], 'gpt-5.5',
      { oauth: { accountId: 1, provider: 'openai' } },
    )).rejects.toThrow(/truncated/i);

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      body: truncatedSseStream([{ type: 'response.output_text.delta', delta: 'partial' }]),
    } as any);
    await expect(collectStream(openai.streamChatCompletion(
      'token', [{ role: 'user', content: 'hello' }], 'gpt-5.5',
      { oauth: { accountId: 1, provider: 'openai' } },
    ))).rejects.toThrow(/truncated/i);
  });
});

function sseStream(events: unknown[]) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

function truncatedSseStream(events: unknown[]) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
}

async function collectStream(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

describe('OpenAICompatProvider - platform instances', () => {
  // Mirrors the actual registrations in server/src/providers/index.ts.
  // Update both when adding/removing a platform.
  const platforms = [
    { platform: 'groq',       name: 'Groq',          baseUrl: 'https://api.groq.com/openai/v1' },
    { platform: 'cerebras',   name: 'Cerebras',      baseUrl: 'https://api.cerebras.ai/v1' },
    { platform: 'sambanova',  name: 'SambaNova',     baseUrl: 'https://api.sambanova.ai/v1' },
    { platform: 'nvidia',     name: 'NVIDIA NIM',    baseUrl: 'https://integrate.api.nvidia.com/v1' },
    { platform: 'mistral',    name: 'Mistral',       baseUrl: 'https://api.mistral.ai/v1' },
    { platform: 'openrouter', name: 'OpenRouter',    baseUrl: 'https://openrouter.ai/api/v1' },
    { platform: 'github',     name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference' },
    { platform: 'zhipu',      name: 'Zhipu AI',      baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  ] as const;

  for (const p of platforms) {
    it(`${p.name} provider should make requests to ${p.baseUrl}`, async () => {
      const provider = new OpenAICompatProvider(p as any);

      let capturedUrl = '';
      vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        capturedUrl = url as string;
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'id', object: 'chat.completion', created: 1, model: 'm',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        } as any;
      });

      const result = await provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model');
      expect(capturedUrl).toContain(p.baseUrl);
      expect(result._routed_via?.platform).toBe(p.platform);
    });
  }
});
