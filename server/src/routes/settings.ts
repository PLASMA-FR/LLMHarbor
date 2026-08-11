import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { parsePositiveResourceId } from '../lib/resourceId.js';
import { toUtcTimestamp } from '../lib/time.js';
import {
  getClientApiKeyPolicySnapshot,
  isKnownClientPolicyPlatform,
  isKnownLocalApiRoute,
  updateClientApiKeyPolicy,
  type ClientAccessPolicyPatch,
} from '../services/accessPolicy.js';
import {
  clientApiKeyLimitsFromRow,
  createNamedClientApiKey,
  deleteClientApiKey,
  listClientApiKeys,
  regenerateUnifiedKey,
  updateClientApiKey,
} from '../db/index.js';

export const settingsRouter = Router();

function firstConfiguredEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function configuredPort(names: string[], fallback: number): number {
  const raw = firstConfiguredEnv(...names);
  const value = raw === undefined ? fallback : Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : fallback;
}

settingsRouter.get('/connection', (_req: Request, res: Response) => {
  const dashboardHost = firstConfiguredEnv('LLMHARBOR_DASHBOARD_HOST', 'DASHBOARD_HOST', 'HOST') ?? '127.0.0.1';
  const dashboardPort = configuredPort(['LLMHARBOR_DASHBOARD_PORT', 'DASHBOARD_PORT', 'PORT'], 3001);
  const publicPortRaw = firstConfiguredEnv('LLMHARBOR_PUBLIC_API_PORT', 'PUBLIC_API_PORT', 'API_PORT');
  const splitMode = publicPortRaw !== undefined;
  res.json({
    splitMode,
    dashboard: { host: dashboardHost, port: dashboardPort },
    publicApi: {
      host: splitMode
        ? (firstConfiguredEnv('LLMHARBOR_PUBLIC_API_HOST', 'PUBLIC_API_HOST', 'API_HOST') ?? '0.0.0.0')
        : dashboardHost,
      port: splitMode
        ? configuredPort(['LLMHARBOR_PUBLIC_API_PORT', 'PUBLIC_API_PORT', 'API_PORT'], 3001)
        : dashboardPort,
      basePath: '/v1',
    },
  });
});

const limitValueSchema = z.union([z.number().int().positive(), z.null()]).optional();

const clientKeyLimitsSchema = z.object({
  rpm: limitValueSchema,
  rpd: limitValueSchema,
  tpm: limitValueSchema,
  tpd: limitValueSchema,
}).strict().optional();

const createClientKeySchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  limits: clientKeyLimitsSchema,
}).strict();

const updateClientKeySchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  limits: clientKeyLimitsSchema,
}).strict().refine(body => body.label !== undefined || body.enabled !== undefined || body.limits !== undefined, {
  message: 'Provide label, enabled, or limits',
});

const accessPolicyPatchSchema = z.object({
  routes: z.array(z.object({
    route: z.string().min(1).max(80).refine(isKnownLocalApiRoute, 'Unknown local API route'),
    enabled: z.boolean(),
  })).max(32).optional(),
  platforms: z.array(z.object({
    platform: z.string().trim().min(1).max(80).refine(isKnownClientPolicyPlatform, 'Unknown provider platform'),
    enabled: z.boolean(),
  })).max(512).optional(),
  models: z.array(z.object({
    modelDbId: z.number().int().positive(),
    enabled: z.boolean(),
  })).max(10_000).optional(),
}).strict().refine(body => body.routes !== undefined || body.platforms !== undefined || body.models !== undefined, {
  message: 'Provide routes, platforms, or models',
});

// Client API keys are hash-only at rest and are revealed once on creation or
// rotation. The dashboard Playground has its own loopback/control-plane route
// and never needs to recover a stored secret.
settingsRouter.get('/api-key', (_req: Request, res: Response) => {
  res.status(410).json({
    error: {
      message: 'Stored client API keys cannot be revealed. Create a new key or regenerate the primary key to receive its secret once.',
      type: 'gone',
      code: 'client_key_not_revealable',
    },
  });
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

settingsRouter.get('/api-keys/:id/access-policy', (req: Request, res: Response) => {
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

settingsRouter.patch('/api-keys/:id/access-policy', (req: Request, res: Response) => {
  const id = parsePositiveResourceId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const parsed = accessPolicyPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  if (parsed.data.models?.length) {
    const modelExists = db.prepare('SELECT id FROM models WHERE id = ?');
    const missing = parsed.data.models.find(item => !modelExists.get(item.modelDbId));
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

settingsRouter.post('/api-keys', (req: Request, res: Response) => {
  const parsed = createClientKeySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const key = createNamedClientApiKey(parsed.data.label ?? 'Personal key', null, parsed.data.limits);
  res.status(201).json(key);
});

settingsRouter.patch('/api-keys/:id', (req: Request, res: Response) => {
  const id = parsePositiveResourceId(req.params.id);
  if (id === null) {
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
  const count = (getDb().prepare('SELECT COUNT(*) AS count FROM client_api_keys').get() as { count: number }).count;
  if (count <= 1) {
    res.status(409).json({ error: { message: 'Create another client API key before deleting the final key.', type: 'conflict', code: 'last_client_key' } });
    return;
  }

  const deleted = deleteClientApiKey(id);
  if (!deleted) {
    res.status(404).json({ error: { message: 'Client key not found' } });
    return;
  }

  res.json({ success: true });
});


const createLocalEndpointSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/, 'Use a lowercase slug like openai-only'),
  providerScopes: z.array(z.string().min(1).max(80)).default([]),
  domains: z.array(z.string().min(1).max(160)).default([]),
});

const updateLocalEndpointSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  providerScopes: z.array(z.string().min(1).max(80)).optional(),
}).refine(body => body.name !== undefined || body.enabled !== undefined || body.providerScopes !== undefined, {
  message: 'Provide name, enabled, or providerScopes',
});

const domainSchema = z.object({
  domain: z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9.-]*(:[0-9]{1,5})?$/i, 'Use a host like api.example.com or app.localhost:3001'),
});

const createEndpointKeySchema = z.object({
  label: z.string().min(1).max(80).optional(),
  limits: clientKeyLimitsSchema,
});

function ensureDefaultLocalEndpointRow() {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO local_endpoints (id, name, slug, enabled)
    VALUES (1, 'Default endpoint', 'default', 1)
  `).run();
  db.prepare(`
    INSERT OR IGNORE INTO local_endpoint_domains (local_endpoint_id, domain)
    VALUES (1, '127.0.0.1:3001')
  `).run();
}

function endpointRowToJson(row: any) {
  const db = getDb();
  const providerScopes = db.prepare('SELECT platform FROM local_endpoint_provider_scopes WHERE local_endpoint_id = ? ORDER BY platform').all(row.id).map((r: any) => r.platform);
  const domains = db.prepare('SELECT domain FROM local_endpoint_domains WHERE local_endpoint_id = ? ORDER BY domain').all(row.id).map((r: any) => r.domain);
  const keys = db.prepare('SELECT * FROM client_api_keys WHERE local_endpoint_id = ? ORDER BY created_at DESC, id DESC').all(row.id).map((key: any) => ({
    id: key.id,
    label: key.label,
    maskedKey: key.key_hint || 'llmharbor-••••••••',
    enabled: key.enabled === 1,
    localEndpointId: key.local_endpoint_id,
    limits: clientApiKeyLimitsFromRow(key),
    createdAt: toUtcTimestamp(key.created_at),
    lastUsedAt: toUtcTimestamp(key.last_used_at),
  }));
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    enabled: row.enabled === 1,
    providerScopes,
    domains,
    keys,
    basePath: row.slug === 'default' ? '/v1' : `/e/${row.slug}/v1`,
    createdAt: toUtcTimestamp(row.created_at),
  };
}

settingsRouter.get('/local-endpoints', (_req: Request, res: Response) => {
  ensureDefaultLocalEndpointRow();
  const rows = getDb().prepare('SELECT * FROM local_endpoints ORDER BY id ASC').all() as any[];
  res.json({ endpoints: rows.map(endpointRowToJson) });
});

settingsRouter.post('/local-endpoints', (_req: Request, res: Response) => {
  res.status(410).json({
    error: {
      message: 'Custom local endpoint creation has moved to per-key access policies. Use /api/settings/api-keys/:id/access-policy to limit routes, providers, and models.',
      code: 'local_endpoint_creation_removed',
    },
  });
});

settingsRouter.patch('/local-endpoints/:id', (req: Request, res: Response) => {
  const id = parsePositiveResourceId(req.params.id);
  const parsed = updateLocalEndpointSchema.safeParse(req.body ?? {});
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid endpoint ID' } });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const db = getDb();
  const row = db.prepare('SELECT * FROM local_endpoints WHERE id = ?').get(id) as any;
  if (!row) {
    res.status(404).json({ error: { message: 'Local endpoint not found' } });
    return;
  }
  db.transaction(() => {
    if (parsed.data.name !== undefined) db.prepare('UPDATE local_endpoints SET name = ? WHERE id = ?').run(parsed.data.name.trim(), id);
    if (parsed.data.enabled !== undefined) db.prepare('UPDATE local_endpoints SET enabled = ? WHERE id = ?').run(parsed.data.enabled ? 1 : 0, id);
    if (parsed.data.providerScopes !== undefined) {
      db.prepare('DELETE FROM local_endpoint_provider_scopes WHERE local_endpoint_id = ?').run(id);
      const stmt = db.prepare('INSERT OR IGNORE INTO local_endpoint_provider_scopes (local_endpoint_id, platform) VALUES (?, ?)');
      for (const platform of parsed.data.providerScopes) stmt.run(id, platform.trim());
    }
  })();
  const updated = db.prepare('SELECT * FROM local_endpoints WHERE id = ?').get(id) as any;
  res.json(endpointRowToJson(updated));
});

settingsRouter.post('/local-endpoints/:id/domains', (req: Request, res: Response) => {
  const id = parsePositiveResourceId(req.params.id);
  const parsed = domainSchema.safeParse(req.body ?? {});
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid endpoint ID' } });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const db = getDb();
  const endpoint = db.prepare('SELECT * FROM local_endpoints WHERE id = ?').get(id) as any;
  if (!endpoint) {
    res.status(404).json({ error: { message: 'Local endpoint not found' } });
    return;
  }
  const domain = parsed.data.domain.trim().toLowerCase();
  try {
    db.prepare('INSERT INTO local_endpoint_domains (local_endpoint_id, domain) VALUES (?, ?)').run(id, domain);
  } catch {
    res.status(409).json({ error: { message: `${domain} is already assigned to an endpoint` } });
    return;
  }
  const updated = db.prepare('SELECT * FROM local_endpoints WHERE id = ?').get(id) as any;
  res.status(201).json(endpointRowToJson(updated));
});

settingsRouter.delete('/local-endpoints/:id/domains/:domain', (req: Request, res: Response) => {
  const id = parsePositiveResourceId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid endpoint ID' } });
    return;
  }
  const domain = decodeURIComponent(String(req.params.domain)).toLowerCase();
  const result = getDb().prepare('DELETE FROM local_endpoint_domains WHERE local_endpoint_id = ? AND domain = ?').run(id, domain);
  if (result.changes === 0) res.status(404).json({ error: { message: 'Domain not found on endpoint' } });
  else res.json({ success: true });
});

settingsRouter.delete('/local-endpoints/:id', (req: Request, res: Response) => {
  const id = parsePositiveResourceId(req.params.id);
  if (id === null || id === 1) {
    res.status(400).json({ error: { message: id === 1 ? 'Default endpoint cannot be deleted' : 'Invalid endpoint ID' } });
    return;
  }
  const result = getDb().prepare('DELETE FROM local_endpoints WHERE id = ?').run(id);
  if (result.changes === 0) res.status(404).json({ error: { message: 'Local endpoint not found' } });
  else res.json({ success: true });
});

settingsRouter.post('/local-endpoints/:id/keys', (req: Request, res: Response) => {
  const id = parsePositiveResourceId(req.params.id);
  const parsed = createEndpointKeySchema.safeParse(req.body ?? {});
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid endpoint ID' } });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const endpoint = getDb().prepare('SELECT * FROM local_endpoints WHERE id = ?').get(id) as any;
  if (!endpoint) {
    res.status(404).json({ error: { message: 'Local endpoint not found' } });
    return;
  }
  const key = createNamedClientApiKey(parsed.data.label ?? `${endpoint.name} key`, id, parsed.data.limits);
  res.status(201).json(key);
});
