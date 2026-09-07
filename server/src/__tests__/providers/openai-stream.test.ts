import { describe, expect, it } from 'vitest';
import { streamOpenAIResponse } from '../../providers/openai-stream.js';

const completion = { choices: [{ delta: { content: 'Hello' } }] };
const terminal = { choices: [{ delta: {}, finish_reason: 'stop' }] };
const usage = { prompt_tokens: 8, completion_tokens: 0, total_tokens: 8 };
function parse(events: unknown[]) {
  return Array.fromAsync(streamOpenAIResponse(new Response(events.map(event =>
    `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`).join('')), 'Test provider', 'model', () => 'stable-id'));
}

describe('shared OpenAI stream contract', () => {
  it('normalizes envelopes and preserves usage, tools and refusal deltas', async () => {
    const chunks = await parse([
      { choices: [{ delta: { role: 'assistant' } }] },
      completion, { choices: [{ delta: { refusal: 'Declined' } }] },
      terminal, { choices: [], usage }, '[DONE]',
    ]);
    expect(chunks).toHaveLength(5);
    expect(chunks.every(chunk => chunk.id === 'stable-id' && chunk.model === 'model')).toBe(true);
    expect(chunks.at(-1)?.usage).toEqual(usage);
    expect(chunks[0].choices[0]).toMatchObject({ index: 0, finish_reason: null });
    expect(chunks[2].choices[0].delta.refusal).toBe('Declined');
  });

  it('supports multiline event data and terminal events without a trailing newline', async () => {
    const response = new Response('data: {"choices":\ndata: [{"delta":{"content":"ok"}}]}\n\ndata: [DONE]');
    const chunks = await Array.fromAsync(streamOpenAIResponse(response, 'Test', 'm', () => 'id'));
    expect(chunks[0].choices[0].delta.content).toBe('ok');
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe('stop');
  });

  it('adds a terminal tool choice only when upstream omitted one', async () => {
    const chunks = await parse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'weather', arguments: '{}' } }] } }] }, '[DONE]']);
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe('tool_calls');
  });

  it('rejects empty, truncated and malformed streams', async () => {
    await expect(parse([{ choices: [], usage }, '[DONE]'])).rejects.toThrow('without completion');
    await expect(parse([completion])).rejects.toThrow('truncated');
    await expect(parse(['invalid JSON'])).rejects.toThrow('malformed');
    await expect(parse([{ ...completion, usage: { ...usage, total_tokens: -1 } }])).rejects.toThrow('malformed');
  });

  it('streams reasoning output without buffering it as a metadata preamble', async () => {
    const reasoning = { choices: [{ delta: { reasoning_content: 'Thinking ' } }] };
    const chunks = await parse([...Array(100).fill(reasoning), completion, terminal, '[DONE]']);
    expect(chunks).toHaveLength(102);
    expect(chunks[0].choices[0].delta.reasoning_content).toBe('Thinking ');
  });
});
