import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../../middleware/errorHandler.js';

describe('error handler', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not expose unexpected exception messages or secrets', async () => {
    const app = express();
    app.get('/explode', (_req, _res) => {
      throw new Error('database exploded with Bearer sk-super-secret-value-123456789');
    });
    app.use(errorHandler);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = app.listen(0);
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/explode`);
      const body = await response.json() as any;
      expect(response.status).toBe(500);
      expect(body.error.message).toBe('Internal server error.');
      expect(body.error.request_id).toBe('unknown');
      expect(JSON.stringify(body)).not.toContain('super-secret');
      expect(String(vi.mocked(console.error).mock.calls[0])).not.toContain('super-secret');
    } finally {
      server.close();
    }
  });
});
