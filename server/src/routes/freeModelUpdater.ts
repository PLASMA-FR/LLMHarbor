import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { freeModelUpdater } from '../services/freeModelUpdater.js';

export const freeModelUpdaterRouter = Router();

const intervalSchema = z.object({
  refreshIntervalHours: z.number().int().min(1).max(24).optional(),
}).strict();

freeModelUpdaterRouter.get('/status', (_req: Request, res: Response) => {
  res.json(freeModelUpdater.getStatus());
});

freeModelUpdaterRouter.post('/enable', (req: Request, res: Response) => {
  const parsed = intervalSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  res.json(freeModelUpdater.enable(parsed.data.refreshIntervalHours));
});

freeModelUpdaterRouter.post('/disable', (_req: Request, res: Response) => {
  res.json(freeModelUpdater.disable());
});

freeModelUpdaterRouter.post('/refresh-now', async (_req: Request, res: Response) => {
  const result = await freeModelUpdater.refreshNow();
  res.json({ ...result, estimatedDuration: 'medium' });
});

freeModelUpdaterRouter.get('/detected-models', async (_req: Request, res: Response) => {
  res.json(await freeModelUpdater.detectFreeModels());
});
