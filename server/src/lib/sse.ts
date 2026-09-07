import { ProviderProtocolError } from '../providers/base.js';

/** Incremental UTF-8 SSE data framing, including CR/LF and multiline fields.
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream
 */
export class SseDecoder {
  private line = '';
  private data: string[] = [];
  private dataLength = 0;
  private skipLf = false;
  private first = true;

  constructor(private readonly maxEventChars = 1_048_576) {}

  push(text: string, flush = false): string[] {
    if (this.first && text.length > 0) {
      text = text.replace(/^\uFEFF/, '');
      this.first = false;
    }
    if (this.skipLf && text.length > 0) {
      if (text.startsWith('\n')) text = text.slice(1);
      this.skipLf = false;
    }
    const events: string[] = [];
    const dispatch = () => {
      if (this.data.length) events.push(this.data.join('\n'));
      this.data = [];
      this.dataLength = 0;
    };
    const consume = (line: string) => {
      if (!line) { dispatch(); return; }
      if (line !== 'data' && !line.startsWith('data:')) return;
      const value = line === 'data' ? '' : line.slice(5).replace(/^ /, '');
      this.dataLength += value.length + 1;
      if (this.dataLength > this.maxEventChars) throw new ProviderProtocolError('Upstream SSE event exceeds the supported size.');
      this.data.push(value);
    };
    let cursor = 0;
    for (const match of text.matchAll(/\r\n|\r|\n/g)) {
      const line = this.line + text.slice(cursor, match.index);
      if (line.length > this.maxEventChars) throw new ProviderProtocolError('Upstream SSE line exceeds the supported size.');
      consume(line);
      this.line = '';
      cursor = match.index + match[0].length;
      this.skipLf = match[0] === '\r' && cursor === text.length;
    }
    this.line += text.slice(cursor);
    if (this.line.length > this.maxEventChars) throw new ProviderProtocolError('Upstream SSE line exceeds the supported size.');
    // Accept a final event without a blank line for compatible gateways that
    // close immediately after their terminal JSON/[DONE] payload.
    if (flush) {
      if (this.line) consume(this.line);
      this.line = '';
      dispatch();
    }
    return events;
  }
}

export async function* readSseData(response: Response): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderProtocolError('Upstream returned no streaming response body.');
  const text = new TextDecoder();
  const decoder = new SseDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* decoder.push(text.decode(value, { stream: true }));
    }
    yield* decoder.push(text.decode(), true);
  } finally {
    try { await reader.cancel?.(); } catch { /* already closed or cancelled */ }
    reader.releaseLock?.();
  }
}
