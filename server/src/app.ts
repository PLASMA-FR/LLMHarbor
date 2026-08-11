import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import type { Request, Response, NextFunction } from 'express';
import { keysRouter } from './routes/keys.js';
import { modelsRouter } from './routes/models.js';
import { proxyRouter } from './routes/proxy.js';
import { fallbackRouter } from './routes/fallback.js';
import { analyticsRouter } from './routes/analytics.js';
import { healthRouter } from './routes/health.js';
import { settingsRouter } from './routes/settings.js';
import { freeModelUpdaterRouter } from './routes/freeModelUpdater.js';
import { endpointsRouter } from './routes/endpoints.js';
import { oauthRouter } from './routes/oauth.js';
import { backupRouter } from './routes/backup.js';
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
const DEFAULT_API_BODY_LIMIT = '16mb';
// A 128 MiB binary backup expands to ~171 MiB as base64. This parser is only
// mounted behind the dashboard control-plane boundary, never on public /v1.
const BACKUP_IMPORT_BODY_LIMIT = '180mb';
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalizeWebOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
      || (url.pathname !== '' && url.pathname !== '/')
      || url.search
      || url.hash) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function firstConfiguredEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function configuredDashboardOrigins(): string[] {
  const host = firstConfiguredEnv('LLMHARBOR_DASHBOARD_HOST', 'DASHBOARD_HOST', 'HOST') ?? '127.0.0.1';
  if (host === '0.0.0.0' || host === '::') return [];
  const rawPort = firstConfiguredEnv('LLMHARBOR_DASHBOARD_PORT', 'DASHBOARD_PORT', 'PORT') ?? '3001';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const configured = normalizeWebOrigin(`http://${urlHost}:${port}`);
  const loopbackAliases = isLoopbackAddress(host) || host.toLowerCase() === 'localhost'
    ? [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]
    : [];
  return [configured, ...loopbackAliases].filter((origin): origin is string => origin !== null);
}

function getAllowedCorsOrigins() {
  const configuredOrigins = (process.env.DASHBOARD_ORIGINS ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
    .map(normalizeWebOrigin)
    .filter((origin): origin is string => origin !== null);

  return new Set([
    ...DEFAULT_DASHBOARD_ORIGINS,
    ...configuredOrigins,
    ...configuredDashboardOrigins(),
  ]);
}

function requireSafeControlPlaneAuthority(allowedOrigins: ReadonlySet<string>) {
  const allowedAuthorities = new Set(Array.from(allowedOrigins, origin => new URL(origin).host.toLowerCase()));
  return (req: Request, res: Response, next: NextFunction) => {
    const authority = req.get('host')?.trim().toLowerCase();
    let literalLoopbackAuthority = false;
    if (authority && isLoopbackAddress(req.socket.remoteAddress)) {
      try {
        const hostname = new URL(`http://${authority}`).hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
        literalLoopbackAuthority = hostname === 'localhost' || isLoopbackAddress(hostname);
      } catch {
        literalLoopbackAuthority = false;
      }
    }
    if (authority && (allowedAuthorities.has(authority) || literalLoopbackAuthority)) {
      next();
      return;
    }
    res.status(403).json({
      error: {
        message: 'The dashboard request authority is not configured.',
        type: 'forbidden',
        code: 'dashboard_authority_denied',
        request_id: String(res.locals.requestId ?? 'unknown'),
      },
    });
  };
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

function requireSafeControlPlaneOrigin(allowedOrigins: ReadonlySet<string>) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_HTTP_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    const suppliedOrigin = req.get('origin');
    if (suppliedOrigin !== undefined) {
      const origin = normalizeWebOrigin(suppliedOrigin);
      // Never derive trust from Host or X-Forwarded-Host. Browsers can reach a
      // loopback listener through DNS rebinding with an attacker-controlled
      // Host/Origin pair. Listener and reverse-proxy origins must be configured
      // explicitly (the native listener address is added above).
      if (origin && allowedOrigins.has(origin)) {
        next();
        return;
      }
    } else {
      const fetchSite = req.get('sec-fetch-site')?.trim().toLowerCase();
      // Non-browser clients such as the CLI and curl do not send Fetch
      // Metadata. Browser requests without Origin are accepted only when the
      // browser identifies them as same-origin or explicitly user initiated.
      if (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'none') {
        next();
        return;
      }
    }

    res.status(403).json({
      error: {
        message: 'Cross-origin dashboard mutations are not allowed.',
        type: 'forbidden',
        code: 'dashboard_origin_denied',
        request_id: String(res.locals.requestId ?? 'unknown'),
      },
    });
  };
}

function createBaseApp() {
  const app = express();
  const allowedCorsOrigins = getAllowedCorsOrigins();

  // The dashboard is fully self-hosted. Recharts and a few layout primitives
  // use style attributes, so styles allow inline values; scripts, connections,
  // fonts, images, and frames remain restricted to the serving origin. HSTS is
  // off because the built-in listener is HTTP; terminate HTTPS at a trusted
  // reverse proxy when exposing the public API beyond a private network.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        upgradeInsecureRequests: null,
      },
    },
    hsts: false,
  }));
  app.use(cors({
    origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
      callback(null, !origin || allowedCorsOrigins.has(origin));
    },
  }));
  app.use((req, res, next) => {
    const supplied = req.get('x-request-id');
    const requestId = supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)
      ? supplied
      : crypto.randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  });

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

function mountDashboardPlaygroundProxy(app: express.Express) {
  app.use('/api/playground/v1', (_req, res, next) => {
    res.locals.llmharborDashboardProxy = true;
    next();
  }, proxyRouter);
}

export function createPublicApiApp() {
  const app = createBaseApp();

  app.use(express.json({ limit: process.env.LLMHARBOR_API_BODY_LIMIT ?? DEFAULT_API_BODY_LIMIT }));

  // Public listener: only OpenAI-compatible proxy routes plus /api/ping.
  // No dashboard static files and no mutating /api control-plane routes.
  mountOpenAiProxy(app);
  app.use(errorHandler);
  app.use((_req, res) => {
    const requestId = String(res.locals.requestId ?? 'unknown');
    res.status(404).json({
      error: {
        message: 'Not found on the LLMHarbor public API listener. Use /v1 for OpenAI-compatible routes.',
        type: 'not_found',
        request_id: requestId,
      },
    });
  });

  return app;
}

export function createDashboardApp(options: CreateAppOptions = {}) {
  const app = createBaseApp();
  const controlPlaneAccess = options.controlPlaneAccess ?? controlPlaneAccessFromEnv();
  const allowedDashboardOrigins = getAllowedCorsOrigins();

  // The dashboard/control-plane API exposes local credentials and mutates the
  // router config. By default it is loopback-only. In split mode, bind the
  // dashboard listener to a Tailscale/VPN IP and set trusted-network access so
  // remote devices on that private overlay can use the control plane.
  app.use(
    '/api',
    requireSafeControlPlaneAuthority(allowedDashboardOrigins),
    requireControlPlaneAccess(controlPlaneAccess),
    requireSafeControlPlaneOrigin(allowedDashboardOrigins),
  );

  app.use(
    '/api/settings/backup',
    express.json({ limit: BACKUP_IMPORT_BODY_LIMIT }),
    backupRouter,
  );
  app.use(express.json({ limit: process.env.LLMHARBOR_API_BODY_LIMIT ?? DEFAULT_API_BODY_LIMIT }));

  // The local dashboard can exercise the exact OpenAI-compatible handlers
  // without retrieving a hash-only client secret from storage.
  mountDashboardPlaygroundProxy(app);

  // Dashboard/control-plane API routes.
  app.use('/api/keys', keysRouter);
  app.use('/api/models', modelsRouter);
  app.use('/api/fallback', fallbackRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/settings/free-model-updater', freeModelUpdaterRouter);
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

  // Express' default 404 is HTML. Keep every API namespace machine-readable,
  // including unknown routes on the combined dashboard listener.
  app.use((req, res) => {
    const requestId = String(res.locals.requestId ?? 'unknown');
    res.status(404).json({
      error: {
        message: 'Not found.',
        type: 'not_found',
        request_id: requestId,
      },
    });
  });

  return app;
}

export function createApp(options: CreateAppOptions = {}) {
  return createDashboardApp(options);
}
