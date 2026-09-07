import type { QueryClient } from '@tanstack/react-query'

/** Configuration changes affect several views of the same routing state. */
export function invalidateRoutingQueries(client: QueryClient) {
  return Promise.all([
    'keys', 'health', 'fallback', 'routing-editor', 'models', 'custom-endpoints', 'custom-endpoint-models',
    'key-import-providers', 'client-api-keys', 'client-api-key-access-policy',
    'oauth-accounts', 'oauth-models', 'free-model-updater-providers',
  ].map(key => client.invalidateQueries({ queryKey: [key] })))
}
