import { describe, expect, it } from 'vitest';
import { SseDecoder, readSseData } from '../../lib/sse.js';

describe('SSE framing', () => {
  it('preserves multiline data and mixed line endings at every chunk boundary', () => {
    const source = '\uFEFF: heartbeat\r\ndata: first\r\ndata: second\r\n\r\ndata: last\r\r';
    for (let split = 0; split <= source.length; split++) {
      const decoder = new SseDecoder();
      expect([...decoder.push(source.slice(0, split)), ...decoder.push(source.slice(split), true)])
        .toEqual(['first\nsecond', 'last']);
    }
  });

  it('decodes UTF-8 split across bytes and flushes the final event', async () => {
    const bytes = new TextEncoder().encode('data: harbor ⚓\n\ndata: [DONE]');
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }));
    expect(await Array.fromAsync(readSseData(response))).toEqual(['harbor ⚓', '[DONE]']);
  });

  it('enforces bounded event and line sizes', () => {
    const decoder = new SseDecoder(16);
    decoder.push('data: one\ndata: two\n');
    expect(() => decoder.push('data: three\ndata: four\n')).toThrow('event exceeds');
    expect(() => new SseDecoder(4).push('12345')).toThrow('line exceeds');
  });

  it('cancels and releases the reader on early completion', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: done\n\n')); },
      cancel() { cancelled = true; },
    }));
    for await (const _data of readSseData(response)) break;
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });
});
