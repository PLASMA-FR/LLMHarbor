import { describe, it, expect, afterEach, vi } from 'vitest';
import { FreebuffProvider } from '../../providers/freebuff.js';

const MODEL = 'moonshotai/kimi-k2.6';
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

    expect(chunks).toHaveLength(1);
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
});
