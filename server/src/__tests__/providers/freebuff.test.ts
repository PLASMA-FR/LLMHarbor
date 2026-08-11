import { describe, it, expect, afterEach, vi } from 'vitest';
import { FreebuffProvider } from '../../providers/freebuff.js';

const MODEL = 'moonshotai/kimi-k2.6';
const SWITCH_MODEL = 'mimo/mimo-v2.5-pro';
const CHAT_URL = 'https://www.codebuff.com/api/v1/chat/completions';
const SESSION_URL = 'https://www.codebuff.com/api/v1/freebuff/session';

interface CapturedFetch {
  url: string;
  init: RequestInit;
}

function mockFreebuffFetch(chatResponse: Response) {
  const calls: CapturedFetch[] = [];
  let parentRunId = 'run-parent';
  let childRunId = 'run-child';

  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = String(url);
    const requestInit = init ?? {};
    calls.push({ url: urlStr, init: requestInit });

    if (urlStr === SESSION_URL && requestInit.method === 'POST') {
      return Response.json({
        status: 'active',
        instanceId: 'freebuff-instance-123',
        model: MODEL,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }

    if (urlStr === CHAT_URL) {
      return chatResponse;
    }

    if (urlStr === 'https://www.codebuff.com/api/v1/agent-runs') {
      const body = JSON.parse(String(requestInit.body ?? '{}'));
      if (body.action === 'START') {
        const runId = body.agentId === 'context-pruner' ? childRunId : parentRunId;
        return Response.json({ runId });
      }
      if (body.action === 'FINISH') return Response.json({ ok: true });
    }

    if (urlStr.includes('/api/v1/agent-runs/') && urlStr.endsWith('/steps')) {
      return Response.json({ stepId: `step-${calls.length}` });
    }

    throw new Error(`unexpected Freebuff fetch ${requestInit.method ?? 'GET'} ${urlStr}`);
  });

  return calls;
}

function findChatCall(calls: CapturedFetch[]) {
  const chatCall = calls.find(call => call.url === CHAT_URL);
  if (!chatCall) throw new Error('chat call was not made');
  return chatCall;
}

describe('FreebuffProvider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the Freebuff CLI/Codebuff SDK request shape for streaming chat', async () => {
    const provider = new FreebuffProvider();
    const calls = mockFreebuffFetch(new Response(
      [
        'data: {"id":"chunk-1","object":"chat.completion.chunk","created":1,"model":"moonshotai/kimi-k2.6","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}',
        'data: [DONE]',
        '',
      ].join('\n\n'),
      { headers: { 'content-type': 'text/event-stream' } },
    ));

    const chunks = [];
    for await (const chunk of provider.streamChatCompletion('freebuff-token', [{ role: 'user', content: 'hello' }], MODEL)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices[0].delta.content).toBe('hi');
    expect(chunks[1].choices[0].finish_reason).toBe('stop');
    const sessionCall = calls.find(call => call.url === SESSION_URL && call.init.method === 'POST');
    expect(sessionCall?.init.headers).toEqual({
      Authorization: 'Bearer freebuff-token',
      'x-freebuff-model': MODEL,
    });
    expect(sessionCall?.init.body).toBeUndefined();

    const chatCall = findChatCall(calls);
    expect(chatCall.init.headers).toEqual({
      Authorization: 'Bearer freebuff-token',
      'Content-Type': 'application/json',
      'user-agent': 'ai-sdk/openai-compatible/1.0.0/codebuff',
    });

    const body = JSON.parse(String(chatCall.init.body));
    expect(body.stream).toBe(true);
    expect(body.provider).toEqual({ allow_fallbacks: false });
    expect(body.provider.data_collection).toBeUndefined();
    expect(body.codebuff_metadata).toMatchObject({
      freebuff_instance_id: 'freebuff-instance-123',
      run_id: 'run-parent',
      cost_mode: 'free',
    });
    expect(body.codebuff_metadata.client_id).toEqual(expect.any(String));
    expect(body.codebuff_metadata.trace_session_id).toEqual(expect.any(String));
  });

  it('omits stream:false for non-streaming chat like the Codebuff SDK', async () => {
    const provider = new FreebuffProvider();
    const calls = mockFreebuffFetch(Response.json({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));

    const completion = await provider.chatCompletion('freebuff-token-nonstream', [{ role: 'user', content: 'hello' }], MODEL);

    expect(completion.choices[0].message.content).toBe('hi');
    const body = JSON.parse(String(findChatCall(calls).init.body));
    expect(body).not.toHaveProperty('stream');
    expect(body.provider).toEqual({ allow_fallbacks: false });
  });

  it('wraps client system prompts inside a CLI-compatible Buffy conversation', async () => {
    const provider = new FreebuffProvider();
    const calls = mockFreebuffFetch(Response.json({
      id: 'chatcmpl-2',
      object: 'chat.completion',
      created: 1,
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));

    await provider.chatCompletion('freebuff-token-system', [
      { role: 'system', content: 'You are Hermes Agent.' },
      { role: 'user', content: 'hello' },
    ], MODEL);

    const body = JSON.parse(String(findChatCall(calls).init.body));
    const systemMessages = body.messages.filter((message: any) => message.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toContain('You are Buffy');
    expect(body.messages[1]).toMatchObject({ role: 'user' });
    expect(body.messages[1].content).toContain('System instructions from the API client:');
    expect(body.messages[1].content).toContain('You are Hermes Agent.');
    expect(body.messages[1].content).toContain('User message:\nhello');
  });

  it('rejects an empty or truncated stream before emitting a synthetic chunk', async () => {
    const provider = new FreebuffProvider();
    mockFreebuffFetch(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    await expect((async () => {
      const chunks = [];
      for await (const chunk of provider.streamChatCompletion('freebuff-token-empty', [{ role: 'user', content: 'hello' }], MODEL)) chunks.push(chunk);
      return chunks;
    })()).rejects.toMatchObject({ code: 'malformed_provider_response' });

    vi.restoreAllMocks();
    mockFreebuffFetch(new Response(
      'data: {"id":"partial","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    await expect((async () => {
      for await (const _chunk of provider.streamChatCompletion('freebuff-token-truncated', [{ role: 'user', content: 'hello' }], MODEL)) { /* consume */ }
    })()).rejects.toThrow(/truncated/i);
  });

  it('uses typed provider errors and isolates cancellation between shared session waiters', async () => {
    const provider = new FreebuffProvider();
    mockFreebuffFetch(new Response(JSON.stringify({ error: 'expired' }), { status: 401 }));
    await expect(provider.chatCompletion('freebuff-token-unauthorized', [{ role: 'user', content: 'hello' }], MODEL))
      .rejects.toMatchObject({ statusCode: 401, retryable: true });

    vi.restoreAllMocks();
    const controller = new AbortController();
    let setupSignal: AbortSignal | undefined;
    let sessionCalls = 0;
    let resolveSession!: (response: Response) => void;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const target = String(url);
      if (target === SESSION_URL) {
        sessionCalls++;
        setupSignal = init?.signal ?? undefined;
        return new Promise<Response>(resolve => { resolveSession = resolve; });
      }
      if (target === 'https://www.codebuff.com/api/v1/agent-runs') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.action === 'START') return Response.json({ runId: body.agentId === 'context-pruner' ? 'run-child-shared' : 'run-parent-shared' });
        return Response.json({ ok: true });
      }
      if (target.includes('/api/v1/agent-runs/') && target.endsWith('/steps')) return Response.json({ ok: true });
      if (target === CHAT_URL) {
        return Response.json({
          id: 'shared-session-completion', object: 'chat.completion', created: 1, model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: 'remaining waiter completed' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      throw new Error(`unexpected request ${target}`);
    });
    const cancelled = provider.chatCompletion('freebuff-token-shared', [{ role: 'user', content: 'hello' }], MODEL, { signal: controller.signal });
    const remaining = provider.chatCompletion('freebuff-token-shared', [{ role: 'user', content: 'hello' }], MODEL);
    controller.abort(new DOMException('Client disconnected.', 'AbortError'));
    await expect(cancelled).rejects.toThrow(/Client disconnected/i);
    expect(setupSignal?.aborted).toBe(false);
    resolveSession(Response.json({
      status: 'active', instanceId: 'shared-session', model: MODEL,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    await expect(remaining).resolves.toMatchObject({ choices: [{ message: { content: 'remaining waiter completed' } }] });
    expect(sessionCalls).toBe(1);
  });

  it('preserves a streaming safety refusal without falling back as empty output', async () => {
    const provider = new FreebuffProvider();
    mockFreebuffFetch(new Response(
      [
        'data: {"id":"refusal","object":"chat.completion.chunk","created":1,"model":"moonshotai/kimi-k2.6","choices":[{"index":0,"delta":{"refusal":"I cannot help with that."},"finish_reason":"content_filter"}]}',
        'data: [DONE]',
        '',
      ].join('\n\n'),
      { headers: { 'content-type': 'text/event-stream' } },
    ));

    const chunks = [];
    for await (const chunk of provider.streamChatCompletion('freebuff-token-refusal', [{ role: 'user', content: 'unsafe' }], MODEL)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.refusal).toBe('I cannot help with that.');
    expect(chunks[0].choices[0].finish_reason).toBe('content_filter');
  });

  it('finalizes a created run when stream setup fails before a response body is read', async () => {
    const provider = new FreebuffProvider();
    const calls = mockFreebuffFetch(new Response('upstream unavailable', { status: 503 }));
    await expect((async () => {
      for await (const _chunk of provider.streamChatCompletion(
        'freebuff-token-stream-setup-failure', [{ role: 'user', content: 'hello' }], MODEL,
      )) { /* consume */ }
    })()).rejects.toMatchObject({ statusCode: 503, retryable: true });

    const finishedRuns = calls
      .filter(call => call.url.endsWith('/api/v1/agent-runs'))
      .map(call => JSON.parse(String(call.init.body ?? '{}')))
      .filter(body => body.action === 'FINISH')
      .map(body => body.runId);
    expect(finishedRuns).toContain('run-parent');
  });

  it('cleans up a partially-created run chain when child setup fails', async () => {
    const provider = new FreebuffProvider();
    const finishedRuns: string[] = [];
    let startCalls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const target = String(url);
      if (target === SESSION_URL) {
        return Response.json({
          status: 'active', instanceId: 'partial-chain-session', model: MODEL,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      if (target === 'https://www.codebuff.com/api/v1/agent-runs') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.action === 'START') {
          startCalls++;
          return startCalls === 1
            ? Response.json({ runId: 'partial-parent' })
            : new Response('child setup failed', { status: 503 });
        }
        if (body.action === 'FINISH') {
          finishedRuns.push(body.runId);
          return Response.json({ ok: true });
        }
      }
      throw new Error(`unexpected request ${target}`);
    });

    await expect(provider.chatCompletion(
      'freebuff-token-partial-chain', [{ role: 'user', content: 'hello' }], MODEL,
    )).rejects.toMatchObject({ statusCode: 503, retryable: true });
    expect(finishedRuns).toEqual(['partial-parent']);
  });

  it('releases the held Freebuff session and rejoins when switching models', async () => {
    const provider = new FreebuffProvider();
    const calls: CapturedFetch[] = [];
    const sessionPostResponses = [
      new Response(JSON.stringify({
        status: 'model_locked',
        currentModel: MODEL,
        requestedModel: SWITCH_MODEL,
        accessTier: 'full',
      }), { status: 409, headers: { 'content-type': 'application/json' } }),
      Response.json({
        status: 'active',
        instanceId: 'mimo-session-456',
        model: SWITCH_MODEL,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ];

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = String(url);
      const requestInit = init ?? {};
      calls.push({ url: urlStr, init: requestInit });

      if (urlStr === SESSION_URL && requestInit.method === 'POST') {
        const response = sessionPostResponses.shift();
        if (!response) throw new Error('unexpected extra session POST');
        return response;
      }
      if (urlStr === SESSION_URL && requestInit.method === 'DELETE') {
        return Response.json({ status: 'none' });
      }
      if (urlStr === CHAT_URL) {
        return Response.json({
          id: 'chatcmpl-switch',
          object: 'chat.completion',
          created: 1,
          model: SWITCH_MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: 'switched' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      if (urlStr === 'https://www.codebuff.com/api/v1/agent-runs') {
        const body = JSON.parse(String(requestInit.body ?? '{}'));
        if (body.action === 'START') return Response.json({ runId: body.agentId === 'context-pruner' ? 'run-child-switch' : 'run-parent-switch' });
        if (body.action === 'FINISH') return Response.json({ ok: true });
      }
      if (urlStr.includes('/api/v1/agent-runs/') && urlStr.endsWith('/steps')) {
        return Response.json({ stepId: `step-${calls.length}` });
      }
      throw new Error(`unexpected Freebuff fetch ${requestInit.method ?? 'GET'} ${urlStr}`);
    });

    const completion = await provider.chatCompletion('freebuff-token-switch', [{ role: 'user', content: 'hello' }], SWITCH_MODEL);

    expect(completion.choices[0].message.content).toBe('switched');
    const sessionCalls = calls.filter(call => call.url === SESSION_URL);
    expect(sessionCalls.map(call => call.init.method)).toEqual(['POST', 'DELETE', 'POST']);
    expect(sessionCalls[0].init.headers).toEqual({
      Authorization: 'Bearer freebuff-token-switch',
      'x-freebuff-model': SWITCH_MODEL,
    });
    expect(sessionCalls[1].init.headers).toEqual({ Authorization: 'Bearer freebuff-token-switch' });
    expect(sessionCalls[2].init.headers).toEqual({
      Authorization: 'Bearer freebuff-token-switch',
      'x-freebuff-model': SWITCH_MODEL,
    });
    const body = JSON.parse(String(findChatCall(calls).init.body));
    expect(body.codebuff_metadata.freebuff_instance_id).toBe('mimo-session-456');
  });
});
