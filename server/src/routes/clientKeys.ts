import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getDb,
  createNamedClientApiKey,
  deleteClientApiKey,
  listClientApiKeys,
  updateClientApiKey,
  getClientApiKey,
  rotateClientApiKey,
} from '../db/index.js';
import { parsePositiveResourceId } from '../lib/resourceId.js';
import { sendValidationError } from '../lib/validation.js';
import { collectionResponse } from '../lib/pagination.js';
import {
  getClientApiKeyPolicySnapshot,
  isKnownClientPolicyPlatform,
  isKnownLocalApiRoute,
  updateClientApiKeyPolicy,
  type ClientAccessPolicyPatch,
} from '../services/accessPolicy.js';

export const clientKeysRouter = Router();

clientKeysRouter.get('/:id', (req, res) => {
  const id = parsePositiveResourceId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: { message: 'Provide a positive integer client key ID.', param: 'id' } });
    return;
  }
  const key = getClientApiKey(id);
  if (!key) {
    res.status(404).json({ error: { message: 'Client key not found.' } });
    return;
  }
  res.json(key);
});

clientKeysRouter.post('/:id/rotate', (req, res) => {
  const id = parsePositiveResourceId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: { message: 'Provide a positive integer client key ID.', param: 'id' } });
    return;
  }
  const parsed = z
    .object({})
    .strict()
    .safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const key = rotateClientApiKey(id);
  if (!key) {
    res.status(404).json({ error: { message: 'Client key not found.' } });
    return;
  }
  res.json(key);
});

const limitValueSchema = z.union([z.number().int().positive().safe(), z.null()]).optional();

export const clientKeyLimitsSchema = z
  .object({
    rpm: limitValueSchema,
    rpd: limitValueSchema,
    tpm: limitValueSchema,
    tpd: limitValueSchema,
  })
  .strict()
  .optional();

export const createClientKeySchema = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    limits: clientKeyLimitsSchema,
  })
  .strict();

export const updateClientKeySchema = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    enabled: z.boolean().optional(),
    limits: clientKeyLimitsSchema,
  })
  .strict()
  .refine((body) => body.label !== undefined || body.enabled !== undefined || body.limits !== undefined, {
    message: 'Provide label, enabled, or limits',
  });

export const accessPolicyPatchSchema = z
  .object({
    routes: z
      .array(
        z.object({
          route: z.string().min(1).max(80).refine(isKnownLocalApiRoute, 'Unknown local API route'),
          enabled: z.boolean(),
        }),
      )
      .max(32)
      .optional(),
    platforms: z
      .array(
        z.object({
          platform: z
            .string()
            .trim()
            .min(1)
            .max(80)
            .refine(isKnownClientPolicyPlatform, 'Unknown provider platform'),
          enabled: z.boolean(),
        }),
      )
      .max(512)
      .optional(),
    models: z
      .array(
        z.object({
          modelDbId: z.number().int().positive().safe(),
          enabled: z.boolean(),
        }),
      )
      .max(10_000)
      .optional(),
  })
  .strict()
  .refine((body) => body.routes !== undefined || body.platforms !== undefined || body.models !== undefined, {
    message: 'Provide routes, platforms, or models',
  });

// Personal API platform keys. Multiple enabled keys can authenticate against /v1.
clientKeysRouter.get('/', (req: Request, res: Response) => {
  collectionResponse(req, res, listClientApiKeys());
});

clientKeysRouter.get('/:id/access-policy', (req: Request, res: Response) => {
  const id = parsePositiveResourceId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const snapshot = getClientApiKeyPolicySnapshot(id);
  if (!snapshot) {
    res.status(404).json({ error: { message: 'Client key not found' } });
    return;
  }

  res.json(snapshot);
});

clientKeysRouter.patch('/:id/access-policy', (req: Request, res: Response) => {
  const id = parsePositiveResourceId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const parsed = accessPolicyPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }

  const db = getDb();
  if (parsed.data.models?.length) {
    const modelExists = db.prepare('SELECT id FROM models WHERE id = ?');
    const missing = parsed.data.models.find((item) => !modelExists.get(item.modelDbId));
    if (missing) {
      res.status(400).json({ error: { message: `Unknown model DB id ${missing.modelDbId}` } });
      return;
    }
  }

  const snapshot = updateClientApiKeyPolicy(id, parsed.data as ClientAccessPolicyPatch);
  if (!snapshot) {
    res.status(404).json({ error: { message: 'Client key not found' } });
    return;
  }

  res.json(snapshot);
});

clientKeysRouter.post('/', (req: Request, res: Response) => {
  const parsed = createClientKeySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }

  const key = createNamedClientApiKey(parsed.data.label ?? 'Personal key', null, parsed.data.limits);
  res.status(201).json(key);
});

clientKeysRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parsePositiveResourceId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const parsed = updateClientKeySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }

  const key = updateClientApiKey(id, parsed.data);
  if (!key) {
    res.status(404).json({ error: { message: 'Client key not found' } });
    return;
  }

  res.json(key);
});

clientKeysRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parsePositiveResourceId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const existing = getDb().prepare('SELECT id FROM client_api_keys WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ error: { message: 'Client key not found' } });
    return;
  }
  const count = (getDb().prepare('SELECT COUNT(*) AS count FROM client_api_keys').get() as { count: number })
    .count;
  if (count <= 1) {
    res
      .status(409)
      .json({
        error: {
          message: 'Create another client API key before deleting the final key.',
          type: 'conflict',
          code: 'last_client_key',
        },
      });
    return;
  }

  const deleted = deleteClientApiKey(id);
  if (!deleted) {
    res.status(404).json({ error: { message: 'Client key not found' } });
    return;
  }

  res.json({ success: true });
});
