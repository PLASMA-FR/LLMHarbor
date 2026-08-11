/**
 * Parse a canonical database resource id from an HTTP path segment.
 *
 * Number.parseInt accepts partial values such as `12junk`, signs, and values
 * outside JavaScript's safe integer range. Resource routes must reject those
 * values instead of accidentally operating on a different row.
 */
export function parsePositiveResourceId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;

  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
