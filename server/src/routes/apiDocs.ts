import { Router } from 'express';
import { buildOpenApi, controlApiDescription } from '../lib/openapi.js';
export const apiDocsRouter = Router();
let schema: ReturnType<typeof buildOpenApi> | undefined;
apiDocsRouter.get('/', (_req, res) => res.json(controlApiDescription));
apiDocsRouter.get('/openapi.json', (_req, res) => res.json((schema ??= buildOpenApi(true))));
