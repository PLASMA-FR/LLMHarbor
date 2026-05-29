import { clientApiKeyLimitsFromRow, getDb } from '../db/index.js';
import { getBuiltInProviderSummaries } from '../providers/index.js';

export type LocalApiRouteId = 'v1.chat.completions' | 'v1.models';

export const LOCAL_API_ROUTES: Array<{ id: LocalApiRouteId; method: string; path: string; name: string; description: string }> = [
  {
    id: 'v1.chat.completions',
    method: 'POST',
    path: '/v1/chat/completions',
    name: 'Chat completions',
    description: 'Allow this key to send OpenAI-compatible chat completion requests through the router.',
  },
  {
    id: 'v1.models',
    method: 'GET',
    path: '/v1/models',
    name: 'Model catalog',
    description: 'Allow this key to list the OpenAI-compatible model catalog after policy filtering.',
  },
];

export interface ClientAccessPolicyPatch {
  routes?: Array<{ route: string; enabled: boolean }>;
  platforms?: Array<{ platform: string; enabled: boolean }>;
  models?: Array<{ modelDbId: number; enabled: boolean }>;
}

export interface ClientAccessDenial {
  status: number;
  code: 'local_api_route_denied' | 'provider_endpoint_access_denied' | 'model_access_denied';
  message: string;
}

function boolFromRow(row: { enabled: number } | undefined): boolean {
  return row ? row.enabled !== 0 : true;
}

function maskClientApiKey(key: string): string {
  return key.length <= 18 ? `${key.slice(0, 8)}••••` : `${key.slice(0, 13)}${'•'.repeat(26)}${key.slice(-6)}`;
}

function keyToJson(row: any) {
  return {
    id: row.id,
    label: row.label,
    maskedKey: maskClientApiKey(row.key),
    enabled: row.enabled === 1,
    localEndpointId: row.local_endpoint_id ?? null,
    limits: clientApiKeyLimitsFromRow(row),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function isKnownLocalApiRoute(route: string): route is LocalApiRouteId {
  return LOCAL_API_ROUTES.some(item => item.id === route);
}

export function isKnownClientPolicyPlatform(platform: string): boolean {
  const normalized = platform.trim();
  if (!normalized) return false;
  if (getBuiltInProviderSummaries().some(provider => provider.platform === normalized)) return true;
  const row = getDb().prepare(`
    SELECT 1 AS found FROM custom_endpoints WHERE platform = ?
    UNION
    SELECT 1 AS found FROM models WHERE platform = ?
    LIMIT 1
  `).get(normalized, normalized) as { found: number } | undefined;
  return Boolean(row);
}

export function getClientApiKeyPolicySnapshot(clientApiKeyId: number) {
  const db = getDb();
  const key = db.prepare('SELECT * FROM client_api_keys WHERE id = ?').get(clientApiKeyId) as any | undefined;
  if (!key) return null;

  const routeRows = db.prepare('SELECT route, enabled FROM client_api_key_route_policies WHERE client_api_key_id = ?').all(clientApiKeyId) as Array<{ route: string; enabled: number }>;
  const routeMap = new Map(routeRows.map(row => [row.route, row.enabled !== 0]));

  const platformRows = db.prepare('SELECT platform, enabled FROM client_api_key_platform_policies WHERE client_api_key_id = ?').all(clientApiKeyId) as Array<{ platform: string; enabled: number }>;
  const platformMap = new Map(platformRows.map(row => [row.platform, row.enabled !== 0]));

  const modelRows = db.prepare('SELECT model_db_id, enabled FROM client_api_key_model_policies WHERE client_api_key_id = ?').all(clientApiKeyId) as Array<{ model_db_id: number; enabled: number }>;
  const modelMap = new Map(modelRows.map(row => [row.model_db_id, row.enabled !== 0]));

  const providerByPlatform = new Map<string, { platform: string; name: string; baseUrl: string | null; timeoutMs: number | null; source: 'built-in' | 'custom' | 'catalog' }>();
  for (const provider of getBuiltInProviderSummaries()) {
    providerByPlatform.set(provider.platform, { ...provider, source: 'built-in' });
  }

  const customRows = db.prepare('SELECT platform, name, base_url, timeout_ms FROM custom_endpoints ORDER BY name COLLATE NOCASE').all() as Array<{ platform: string; name: string; base_url: string; timeout_ms: number | null }>;
  for (const row of customRows) {
    providerByPlatform.set(row.platform, {
      platform: row.platform,
      name: row.name,
      baseUrl: row.base_url,
      timeoutMs: row.timeout_ms,
      source: 'custom',
    });
  }

  const catalogPlatforms = db.prepare('SELECT DISTINCT platform FROM models ORDER BY platform').all() as Array<{ platform: string }>;
  for (const row of catalogPlatforms) {
    if (!providerByPlatform.has(row.platform)) {
      providerByPlatform.set(row.platform, {
        platform: row.platform,
        name: row.platform,
        baseUrl: null,
        timeoutMs: null,
        source: 'catalog',
      });
    }
  }

  const platforms = Array.from(providerByPlatform.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(provider => ({
      ...provider,
      enabled: platformMap.get(provider.platform) ?? true,
    }));

  const models = (db.prepare(`
    SELECT id, platform, model_id, display_name, context_window, enabled
      FROM models
     ORDER BY platform COLLATE NOCASE, intelligence_rank ASC, model_id COLLATE NOCASE
  `).all() as any[]).map(row => ({
    modelDbId: row.id,
    platform: row.platform,
    modelId: row.model_id,
    displayName: row.display_name,
    contextWindow: row.context_window,
    catalogEnabled: row.enabled === 1,
    enabled: modelMap.get(row.id) ?? true,
  }));

  return {
    key: keyToJson(key),
    routes: LOCAL_API_ROUTES.map(route => ({
      ...route,
      enabled: routeMap.get(route.id) ?? true,
    })),
    platforms,
    models,
  };
}

export function updateClientApiKeyPolicy(clientApiKeyId: number, patch: ClientAccessPolicyPatch) {
  const db = getDb();
  const exists = db.prepare('SELECT id FROM client_api_keys WHERE id = ?').get(clientApiKeyId) as { id: number } | undefined;
  if (!exists) return null;

  db.transaction(() => {
    if (patch.routes) {
      const stmt = db.prepare(`
        INSERT INTO client_api_key_route_policies (client_api_key_id, route, enabled)
        VALUES (?, ?, ?)
        ON CONFLICT(client_api_key_id, route) DO UPDATE SET enabled = excluded.enabled
      `);
      for (const item of patch.routes) stmt.run(clientApiKeyId, item.route, item.enabled ? 1 : 0);
    }

    if (patch.platforms) {
      const stmt = db.prepare(`
        INSERT INTO client_api_key_platform_policies (client_api_key_id, platform, enabled)
        VALUES (?, ?, ?)
        ON CONFLICT(client_api_key_id, platform) DO UPDATE SET enabled = excluded.enabled
      `);
      for (const item of patch.platforms) stmt.run(clientApiKeyId, item.platform.trim(), item.enabled ? 1 : 0);
    }

    if (patch.models) {
      const stmt = db.prepare(`
        INSERT INTO client_api_key_model_policies (client_api_key_id, model_db_id, enabled)
        VALUES (?, ?, ?)
        ON CONFLICT(client_api_key_id, model_db_id) DO UPDATE SET enabled = excluded.enabled
      `);
      for (const item of patch.models) stmt.run(clientApiKeyId, item.modelDbId, item.enabled ? 1 : 0);
    }
  })();

  return getClientApiKeyPolicySnapshot(clientApiKeyId);
}

export function isClientRouteAllowed(clientApiKeyId: number, route: LocalApiRouteId): boolean {
  const row = getDb().prepare('SELECT enabled FROM client_api_key_route_policies WHERE client_api_key_id = ? AND route = ?')
    .get(clientApiKeyId, route) as { enabled: number } | undefined;
  return boolFromRow(row);
}

export function isClientPlatformAllowed(clientApiKeyId: number, platform: string): boolean {
  const row = getDb().prepare('SELECT enabled FROM client_api_key_platform_policies WHERE client_api_key_id = ? AND platform = ?')
    .get(clientApiKeyId, platform) as { enabled: number } | undefined;
  return boolFromRow(row);
}

export function isClientModelAllowed(clientApiKeyId: number, modelDbId: number): boolean {
  const row = getDb().prepare('SELECT enabled FROM client_api_key_model_policies WHERE client_api_key_id = ? AND model_db_id = ?')
    .get(clientApiKeyId, modelDbId) as { enabled: number } | undefined;
  return boolFromRow(row);
}

export function getClientModelAccessDenial(clientApiKeyId: number, model: { id: number; platform: string; modelId?: string; displayName?: string }): ClientAccessDenial | null {
  if (!isClientPlatformAllowed(clientApiKeyId, model.platform)) {
    return {
      status: 403,
      code: 'provider_endpoint_access_denied',
      message: `This local API key is not allowed to use the ${model.platform} provider endpoint.`,
    };
  }
  if (!isClientModelAllowed(clientApiKeyId, model.id)) {
    return {
      status: 403,
      code: 'model_access_denied',
      message: `This local API key is not allowed to use model '${model.modelId ?? model.displayName ?? model.id}'.`,
    };
  }
  return null;
}

export function localApiRouteDenied(route: LocalApiRouteId): ClientAccessDenial {
  const meta = LOCAL_API_ROUTES.find(item => item.id === route);
  return {
    status: 403,
    code: 'local_api_route_denied',
    message: `This local API key is not allowed to call ${meta?.path ?? route}.`,
  };
}
