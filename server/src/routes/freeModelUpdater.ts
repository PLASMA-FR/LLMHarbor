import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { freeModelUpdater } from '../services/freeModelUpdater.js';

export const freeModelUpdaterRouter = Router();

const providerSelectionSchema = z.object({
  selectedProviders: z.array(z.string().min(1).max(120)).max(50),
}).strict();

const intervalSchema = z.object({
  refreshIntervalHours: z.number().int().min(1).max(24).optional(),
  selectedProviders: z.array(z.string().min(1).max(120)).max(50).optional(),
}).strict();

freeModelUpdaterRouter.get('/status', (_req: Request, res: Response) => {
  res.json(freeModelUpdater.getStatus());
});

freeModelUpdaterRouter.get('/providers', (_req: Request, res: Response) => {
  res.json({ providers: freeModelUpdater.getProviderOptions() });
});

freeModelUpdaterRouter.put('/providers', (req: Request, res: Response) => {
  const parsed = providerSelectionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  try {
    const status = freeModelUpdater.setSelectedProviders(parsed.data.selectedProviders);
    res.json({ status, providers: freeModelUpdater.getProviderOptions() });
  } catch (error) {
    res.status(400).json({ error: { message: error instanceof Error ? error.message : String(error) } });
  }
});

freeModelUpdaterRouter.post('/enable', (req: Request, res: Response) => {
  const parsed = intervalSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  if (parsed.data.selectedProviders) {
    try {
      freeModelUpdater.setSelectedProviders(parsed.data.selectedProviders);
    } catch (error) {
      res.status(400).json({ error: { message: error instanceof Error ? error.message : String(error) } });
      return;
    }
  }
  if (freeModelUpdater.getStatus().selectedProviderCount === 0) {
    res.status(400).json({ error: { message: 'Select at least one ready provider before enabling the beta updater.' } });
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
  res.json(freeModelUpdater.getDetectedModels());
});
