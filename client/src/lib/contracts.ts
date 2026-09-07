import type { Model } from '../../../shared/types'

export interface ClientKey {
  id: number
  label: string
  key?: string
  maskedKey: string
  enabled: boolean
  createdAt: string
  lastUsedAt: string | null
  localEndpointId?: number | null
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null }
}
export interface ProviderSummary {
  id: number | null
  platform: string
  name: string
  baseUrl: string | null
  validateUrl: string | null
  timeoutMs: number
  enabled: boolean
  custom: boolean
  modelCount: number
  keyCount: number
  credentialMode: 'api-key' | 'oauth' | 'optional-api-key'
  configuredKeyCount: number
  enabledKeyCount: number
  availableKeyCount: number
}
export interface CatalogModel extends Model {
  priority: number | null
  fallbackEnabled: boolean
}
export interface PolicySnapshot {
  key: ClientKey
  routes: Array<{
    id: string
    name: string
    path: string
    method: string
    description: string
    enabled: boolean
  }>
  platforms: Array<{ platform: string; name: string; enabled: boolean }>
  models: Array<{
    modelDbId: number
    platform: string
    modelId: string
    displayName: string
    enabled: boolean
    catalogEnabled: boolean
    contextWindow: number | null
  }>
}
export interface ConnectionInfo {
  splitMode: boolean
  dashboard: { host: string; port: number }
  publicApi: { host: string; port: number; basePath: string }
}
export interface RequestRecord {
  id: number
  requestId: string | null
  traceId: string | null
  clientKeyId: number | null
  clientKeyLabel: string | null
  platform: string
  modelId: string
  displayName: string
  attempt: number
  isFinal: boolean
  status: 'success' | 'error' | 'cancelled'
  inputTokens: number
  outputTokens: number
  latencyMs: number
  error: string | null
  createdAt: string | null
}
export interface PageResult<T> {
  data: T[]
  pagination: { limit: number; hasMore: boolean; nextCursor: string | null }
}
