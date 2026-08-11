import { describe, expect, it } from 'vitest'
import { extractSseFrames, readSseData } from './sse'

describe('SSE parsing', () => {
  it('preserves a partial event across network chunks', () => {
    const first = extractSseFrames('data: {"choices":[\n')
    expect(first.frames).toEqual([])

    const second = extractSseFrames(`${first.remainder}data: ]}\r\n\r\ndata: [DO`)
    expect(second.frames).toEqual(['data: {"choices":[\ndata: ]}'])
    expect(readSseData(second.frames[0]!)).toBe('{"choices":[\n]}')
    expect(second.remainder).toBe('data: [DO')
  })

  it('recognizes terminal events split at arbitrary boundaries', () => {
    const parsed = extractSseFrames('data: [DONE]\n\n')
    expect(readSseData(parsed.frames[0]!)).toBe('[DONE]')
    expect(parsed.remainder).toBe('')
  })

  it('ignores comments and flushes a final event without a blank line', () => {
    const parsed = extractSseFrames(': heartbeat\ndata: final', true)
    expect(parsed.remainder).toBe('')
    expect(readSseData(parsed.frames[0]!)).toBe('final')
  })
})
