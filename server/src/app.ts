import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Request, Response, NextFunction } from 'express';
import { keysRouter } from './routes/keys.js';
import { modelsRouter } from './routes/models.js';
import { proxyRouter } from './routes/proxy.js';
import { fallbackRouter } from './routes/fallback.js';
import { analyticsRouter } from './routes/analytics.js';
import { healthRouter } from './routes/health.js';
import { settingsRouter } from './routes/settings.js';
import { endpointsRouter } from './routes/endpoints.js';
import { oauthRouter } from './routes/oauth.js';
import { errorHandler } from './middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type ControlPlaneAccess = 'local' | 'trusted-network';

export interface CreateAppOptions {
  controlPlaneAccess?: ControlPlaneAccess;
}

const DEFAULT_DASHBOARD_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://[::1]:5173',
];

function getAllowedCorsOrigins() {
  const configuredOrigins = (process.env.DASHBOARD_ORIGINS ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  return new Set([...DEFAULT_DASHBOARD_ORIGINS, ...configuredOrigins]);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address.startsWith('127.');
}

function controlPlaneAccessFromEnv(): ControlPlaneAccess {
  if (process.env.LLMHARBOR_DASHBOARD_TRUSTED_NETWORK === '1'
    || process.env.LLMHARBOR_ALLOW_REMOTE_CONTROL_PLANE === '1') {
    return 'trusted-network';
  }
  return 'local';
}

function requireControlPlaneAccess(access: ControlPlaneAccess) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (access === 'trusted-network') {
      next();
      return;
    }

    if (isLoopbackAddress(req.socket.remoteAddress)) {
      next();
      return;
    }

    res.status(403).json({
      error: {
        message: 'LLMHarbor dashboard API is local-only. Bind the dashboard to Tailscale/VPN and set LLMHARBOR_DASHBOARD_TRUSTED_NETWORK=1 only behind your own network controls.',
        type: 'forbidden',
      },
    });
  };
}

function createBaseApp() {
  const app = express();
  const allowedCorsOrigins = getAllowedCorsOrigins();

  // CSP intentionally disabled — the SPA bundles inline styles and the OG
  // image is loaded from the same origin; enabling helmet's default CSP
  // breaks the React build's hashed-asset loader. HSTS off because this is
  // a single-user local proxy, served over HTTP by default. Enable HTTPS at a
  // trusted reverse proxy if exposing the public API over the internet.
  app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
  app.use(cors({
    origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
      callback(null, !origin || allowedCorsOrigins.has(origin));
    },
  }));
  app.use(express.json({ limit: '1mb' }));

  // Public liveness probe: no credentials or config data. The split public API
  // listener exposes this too so operators can check the port without an API key.
  app.get('/api/ping', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return app;
}

function mountOpenAiProxy(app: express.Express) {
  app.use('/v1', proxyRouter);
  app.use('/e/:endpointSlug/v1', proxyRouter);
}

export function createPublicApiApp() {
  const app = createBaseApp();

  // Public listener: only OpenAI-compatible proxy routes plus /api/ping.
  // No dashboard static files and no mutating /api control-plane routes.
  mountOpenAiProxy(app);
  app.use(errorHandler);
  app.use((_req, res) => {
    res.status(404).json({
      error: {
        message: 'Not found on the LLMHarbor public API listener. Use /v1 for OpenAI-compatible routes.',
        type: 'not_found',
      },
    });
  });

  return app;
}

export function createDashboardApp(options: CreateAppOptions = {}) {
  const app = createBaseApp();
  const controlPlaneAccess = options.controlPlaneAccess ?? controlPlaneAccessFromEnv();

  // The dashboard/control-plane API exposes local credentials and mutates the
  // router config. By default it is loopback-only. In split mode, bind the
  // dashboard listener to a Tailscale/VPN IP and set trusted-network access so
  // remote devices on that private overlay can use the control plane.
  app.use('/api', requireControlPlaneAccess(controlPlaneAccess));

  // Dashboard/control-plane API routes.
  app.use('/api/keys', keysRouter);
  app.use('/api/models', modelsRouter);
  app.use('/api/fallback', fallbackRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/endpoints', endpointsRouter);
  app.use('/api/oauth', oauthRouter);

  // Keep the local/Tailscale dashboard listener useful for playground calls too.
  mountOpenAiProxy(app);

  // Error handler (for API routes)
  app.use(errorHandler);

  // Serve client static files (after API error handler)
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  // SPA fallback — serve index.html for dashboard routes only.
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/v1/') || req.path.startsWith('/e/')) {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  return app;
}

export function createApp(options: CreateAppOptions = {}) {
  return createDashboardApp(options);
}
