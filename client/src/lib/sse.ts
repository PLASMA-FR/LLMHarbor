export interface ExtractedSseFrames {
  frames: string[]
  remainder: string
}

/** Split complete SSE events while preserving a partial event across chunks. */
export function extractSseFrames(buffer: string, flush = false): ExtractedSseFrames {
  const frames: string[] = []
  const boundary = /\r\n\r\n|\n\n|\r\r/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = boundary.exec(buffer)) !== null) {
    const frame = buffer.slice(cursor, match.index)
    if (frame.trim()) frames.push(frame)
    cursor = match.index + match[0].length
  }
  let remainder = buffer.slice(cursor)
  if (flush && remainder.trim()) {
    frames.push(remainder)
    remainder = ''
  }
  return { frames, remainder }
}

/** Return the joined data field for an SSE event; comments/other fields are ignored. */
export function readSseData(frame: string): string | null {
  const values: string[] = []
  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (line === 'data') {
      values.push('')
      continue
    }
    if (!line.startsWith('data:')) continue
    const value = line.slice(5)
    values.push(value.startsWith(' ') ? value.slice(1) : value)
  }
  return values.length > 0 ? values.join('\n') : null
}
