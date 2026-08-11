const SQLITE_UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/**
 * Convert SQLite's timezone-less UTC datetime format into an unambiguous ISO
 * timestamp for API responses. Values already carrying ISO/offset semantics
 * are intentionally left unchanged.
 */
export function toUtcTimestamp(value: string): string;
export function toUtcTimestamp(value: null | undefined): null;
export function toUtcTimestamp(value: unknown): string | null;
export function toUtcTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const sqliteTimestamp = SQLITE_UTC_TIMESTAMP.exec(value);
  if (!sqliteTimestamp) return value;
  return `${sqliteTimestamp[1]}T${sqliteTimestamp[2]}Z`;
}
