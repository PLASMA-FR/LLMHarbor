import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createNamedClientApiKey,
  deleteClientApiKey,
  getUnifiedApiKey,
  listClientApiKeys,
  regenerateUnifiedKey,
  updateClientApiKey,
} from '../db/index.js';

export const settingsRouter = Router();

const createClientKeySchema = z.object({
  label: z.string().min(1).max(80).optional(),
});

const updateClientKeySchema = z.object({
  label: z.string().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
}).refine(body => body.label !== undefined || body.enabled !== undefined, {
  message: 'Provide label or enabled',
});

// Backward-compatible primary key endpoint for older clients and docs.
settingsRouter.get('/api-key', (_req: Request, res: Response) => {
  res.json({ apiKey: getUnifiedApiKey() });
});

// Backward-compatible rotation of the oldest/default client key.
settingsRouter.post('/api-key/regenerate', (_req: Request, res: Response) => {
  const newKey = regenerateUnifiedKey();
  res.json({ apiKey: newKey });
});

// Personal API platform keys. Multiple enabled keys can authenticate against /v1.
settingsRouter.get('/api-keys', (_req: Request, res: Response) => {
  res.json(listClientApiKeys());
});

settingsRouter.post('/api-keys', (req: Request, res: Response) => {
  const parsed = createClientKeySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const key = createNamedClientApiKey(parsed.data.label ?? 'Personal key');
  res.status(201).json(key);
});

settingsRouter.patch('/api-keys/:id', (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const parsed = updateClientKeySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const key = updateClientApiKey(id, parsed.data);
  if (!key) {
    res.status(404).json({ error: { message: 'Client key not found' } });
    return;
  }

  res.json(key);
});

settingsRouter.delete('/api-keys/:id', (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const deleted = deleteClientApiKey(id);
  if (!deleted) {
    res.status(404).json({ error: { message: 'Client key not found' } });
    return;
  }

  res.json({ success: true });
});
