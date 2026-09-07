import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import { chatCompletionSchema } from '../schemas/chat.js';
import {
  createClientKeySchema,
  updateClientKeySchema,
  accessPolicyPatchSchema,
} from '../routes/clientKeys.js';
import { addKeySchema, importKeysSchema, updateProviderKeySchema } from '../routes/keys.js';
import {
  endpointSchema,
  endpointPatchSchema,
  modelSchema,
  modelPatchSchema,
  probeSchema,
} from '../routes/endpoints.js';

type Schema = Record<string, unknown>;
const string = { type: 'string' };
const integer = { type: 'integer' };
const boolean = { type: 'boolean' };
const nullableString = { type: 'string', nullable: true };
const nullableInteger = { type: 'integer', nullable: true };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const array = (items: Schema) => ({ type: 'array', items });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});
const fromZod = (schema: ZodTypeAny): Schema =>
  zodToJsonSchema(schema, {
    target: 'openApi3',
    $refStrategy: 'none',
    removeAdditionalStrategy: 'strict',
  }) as Schema;
const response = (schema: Schema, description = 'Success') => ({
  description,
  content: { 'application/json': { schema } },
});
const error = response(
  ref('Error'),
  'Structured error; use error.code, error.param, error.details and X-Request-Id for diagnostics.',
);
const id = { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } };
const platform = {
  name: 'platform',
  in: 'path',
  required: true,
  schema: string,
  description: 'Stable platform ID from GET /api/providers.',
};
const paging = [
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
  {
    name: 'cursor',
    in: 'query',
    schema: string,
    description: 'Pass pagination.nextCursor from the preceding page.',
  },
];

export const publicApiDescription = {
  name: 'LLMHarbor',
  version: 'v1',
  authentication:
    'Create a client key in the dashboard under Client access. Send Authorization: Bearer <client-key>.',
  links: { models: '/v1/models', chatCompletions: '/v1/chat/completions', openapi: '/v1/openapi.json' },
  capabilities: {
    text: true,
    streaming: true,
    functionTools: true,
    vision: false,
    audio: false,
    structuredOutputs: false,
    multipleChoices: false,
  },
};

export const controlApiDescription = {
  name: 'LLMHarbor control API',
  authentication:
    'Dashboard APIs require the configured local/private network boundary. Client Bearer keys only authenticate /v1.',
  links: {
    providers: '/api/providers',
    providerKeys: '/api/provider-keys',
    clientKeys: '/api/client-keys',
    routing: '/api/routing',
    requests: '/api/requests',
    discovery: '/api/discovery/status',
    backups: '/api/backups/status',
    openapi: '/api/openapi.json',
  },
};

export function buildOpenApi(includeControlPlane = false) {
  const schemas: Record<string, Schema> = {
    Error: object({
      error: object(
        {
          message: string,
          type: string,
          code: string,
          param: nullableString,
          request_id: string,
          details: array(object({ path: string, code: string, message: string })),
        },
        ['message', 'type', 'code', 'request_id'],
      ),
    }),
    ChatRequest: fromZod(chatCompletionSchema),
    Usage: object({ prompt_tokens: integer, completion_tokens: integer, total_tokens: integer }),
    ChatResponse: object({
      id: string,
      object: { type: 'string', enum: ['chat.completion'] },
      created: integer,
      model: string,
      choices: array(
        object({
          index: integer,
          message: object(
            {
              role: { type: 'string', enum: ['assistant'] },
              content: nullableString,
              tool_calls: array({ type: 'object' }),
              refusal: string,
            },
            ['role', 'content'],
          ),
          finish_reason: nullableString,
        }),
      ),
      usage: ref('Usage'),
    }),
    Models: object({
      object: { type: 'string', enum: ['list'] },
      data: array(
        object({
          id: string,
          object: { type: 'string', enum: ['model'] },
          created: integer,
          owned_by: string,
          name: string,
          context_window: nullableInteger,
        }),
      ),
    }),
    Pagination: object({ limit: integer, hasMore: boolean, nextCursor: nullableString }),
  };
  const paths: Record<string, unknown> = {
    '/v1': {
      get: {
        summary: 'Discover the inference API',
        security: [],
        responses: { 200: response({ type: 'object' }) },
      },
    },
    '/v1/models': {
      get: {
        summary: 'List models allowed for this client key',
        operationId: 'listAvailableModels',
        responses: { 200: response(ref('Models')), 401: error, 403: error },
      },
    },
    '/v1/chat/completions': {
      post: {
        summary: 'Create a text chat completion',
        operationId: 'createChatCompletion',
        description:
          'Omit model or use auto for automatic routing. A provider/model ID is preferred first; retryable failures can fall back. Unknown legacy fields are ignored and named in X-LLMHarbor-Ignored-Parameters. n must be 1. JSON-schema output, images and audio are unsupported.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: ref('ChatRequest'),
              example: { model: 'auto', messages: [{ role: 'user', content: 'Hello' }], stream: false },
            },
          },
        },
        responses: {
          200: {
            description:
              'JSON completion, or SSE for stream=true. SSE ends with data: [DONE]; mid-stream errors are error frames.',
            headers: {
              'X-Routed-Via': { schema: string },
              'X-Request-Id': { schema: string },
              'X-Fallback-Attempts': { schema: integer },
              'X-LLMHarbor-Ignored-Parameters': { schema: string },
            },
            content: {
              'application/json': { schema: ref('ChatResponse') },
              'text/event-stream': { schema: string },
            },
          },
          400: error,
          401: error,
          403: error,
          429: error,
          502: error,
          503: error,
          504: error,
        },
      },
    },
    '/v1/openapi.json': {
      get: {
        summary: 'Download the inference OpenAPI contract',
        security: [],
        responses: { 200: response({ type: 'object' }) },
      },
    },
  };
  if (includeControlPlane) {
    Object.assign(schemas, {
      CreateClientKey: fromZod(createClientKeySchema),
      UpdateClientKey: fromZod(updateClientKeySchema),
      AccessPolicyPatch: fromZod(accessPolicyPatchSchema),
      CreateProviderKey: fromZod(addKeySchema),
      UpdateProviderKey: fromZod(updateProviderKeySchema),
      ImportKeys: fromZod(importKeysSchema),
      CreateProvider: fromZod(endpointSchema),
      UpdateProvider: fromZod(endpointPatchSchema),
      CreateModel: fromZod(modelSchema),
      UpdateModel: fromZod(modelPatchSchema),
      ProbeModel: fromZod(probeSchema),
      ClientKey: object(
        {
          id: integer,
          label: string,
          maskedKey: string,
          enabled: boolean,
          createdAt: string,
          lastUsedAt: nullableString,
          key: { type: 'string', description: 'Returned once on creation/rotation only.' },
          limits: object({
            rpm: nullableInteger,
            rpd: nullableInteger,
            tpm: nullableInteger,
            tpd: nullableInteger,
          }),
        },
        ['id', 'label', 'maskedKey', 'enabled', 'limits'],
      ),
      ProviderKey: object(
        {
          id: integer,
          platform: string,
          label: string,
          maskedKey: string,
          enabled: boolean,
          status: string,
          source: { type: 'string', enum: ['manual', 'oauth', 'anonymous'] },
        },
        ['id', 'platform', 'label', 'maskedKey', 'enabled', 'status'],
      ),
      Provider: object({
        platform: string,
        name: string,
        baseUrl: nullableString,
        timeoutMs: integer,
        custom: boolean,
        enabled: boolean,
        credentialMode: string,
        modelCount: integer,
        configuredKeyCount: integer,
        enabledKeyCount: integer,
        availableKeyCount: integer,
      }),
      Model: object(
        {
          id: integer,
          platform: string,
          modelId: string,
          displayName: string,
          enabled: boolean,
          fallbackEnabled: boolean,
          priority: nullableInteger,
          contextWindow: nullableInteger,
          rpmLimit: nullableInteger,
          rpdLimit: nullableInteger,
          tpmLimit: nullableInteger,
          tpdLimit: nullableInteger,
        },
        ['id', 'platform', 'modelId', 'displayName', 'enabled'],
      ),
      Routing: array(
        object({
          modelDbId: integer,
          priority: integer,
          enabled: boolean,
          platform: string,
          modelId: string,
          displayName: string,
          modelEnabled: boolean,
          eligible: boolean,
          skipReason: nullableString,
        }),
      ),
      RoutingUpdate: array(object({ modelDbId: integer, priority: integer, enabled: boolean })),
      Request: object({
        id: integer,
        requestId: nullableString,
        traceId: nullableString,
        clientKeyId: nullableInteger,
        clientKeyLabel: nullableString,
        platform: string,
        modelId: string,
        displayName: string,
        status: { type: 'string', enum: ['success', 'error', 'cancelled'] },
        attempt: integer,
        isFinal: boolean,
        inputTokens: integer,
        outputTokens: integer,
        latencyMs: integer,
        error: nullableString,
        createdAt: nullableString,
      }),
    });
    const paged = (name: string) => object({ data: array(ref(name)), pagination: ref('Pagination') });
    const collection = (name: string) => ({ oneOf: [array(ref(name)), paged(name)] });
    function operation(
      summary: string,
      output: Schema,
      input?: string,
      parameters: unknown[] = [],
      status = 200,
    ) {
      return {
        summary,
        security: [],
        description: 'Control-plane operation: local/private dashboard access required.',
        parameters,
        ...(input
          ? { requestBody: { required: true, content: { 'application/json': { schema: ref(input) } } } }
          : {}),
        responses: { [status]: response(output), 400: error, 403: error, 404: error, 409: error },
      };
    }
    const ok = object({ success: boolean });
    Object.assign(paths, {
      '/api': { get: operation('Discover control-plane resources', { type: 'object' }) },
      '/api/providers': {
        get: operation('List built-in and custom providers', array(ref('Provider'))),
        post: operation(
          'Create a custom endpoint with an optional initial credential',
          ref('Provider'),
          'CreateProvider',
          [],
          201,
        ),
      },
      '/api/providers/{platform}': {
        get: operation('Read a provider connection', ref('Provider'), undefined, [platform]),
        patch: operation('Update custom endpoint settings', { type: 'object' }, 'UpdateProvider', [platform]),
        delete: operation('Remove a custom endpoint and its models/keys', ok, undefined, [platform]),
      },
      '/api/providers/{platform}/models': {
        get: operation('List provider models', array(ref('Model')), undefined, [platform]),
        post: operation(
          'Register a model; its route starts disabled',
          ref('Model'),
          'CreateModel',
          [platform],
          201,
        ),
      },
      '/api/providers/{platform}/models/{id}': {
        get: operation('Read a registered model', ref('Model'), undefined, [platform, id]),
        patch: operation('Edit model metadata and quotas', ref('Model'), 'UpdateModel', [platform, id]),
        delete: operation('Remove a registered model', ok, undefined, [platform, id]),
      },
      '/api/providers/{platform}/models/probe': {
        post: operation('Test a model with a usable credential', { type: 'object' }, 'ProbeModel', [
          platform,
        ]),
      },
      '/api/provider-keys': {
        get: {
          ...operation('List masked provider credentials', collection('ProviderKey'), undefined, paging),
          description:
            'Bare array by default. Supplying limit/cursor returns a data + pagination envelope ordered by descending ID.',
        },
        post: operation('Add a provider credential', ref('ProviderKey'), 'CreateProviderKey', [], 201),
      },
      '/api/provider-keys/{id}': {
        get: operation('Read a masked provider credential', ref('ProviderKey'), undefined, [id]),
        patch: operation('Update a manual credential or pause a key', ok, 'UpdateProviderKey', [id]),
        delete: operation('Delete a provider credential', ok, undefined, [id]),
      },
      '/api/provider-keys/import': {
        post: operation('Import and deduplicate provider keys', { type: 'object' }, 'ImportKeys', [], 201),
      },
      '/api/client-keys': {
        get: {
          ...operation('List client keys without secrets', collection('ClientKey'), undefined, paging),
          description: 'Bare array by default; limit/cursor opt into pagination.',
        },
        post: operation(
          'Create a client key and reveal its secret once',
          ref('ClientKey'),
          'CreateClientKey',
          [],
          201,
        ),
      },
      '/api/client-keys/{id}': {
        get: operation('Read a client key', ref('ClientKey'), undefined, [id]),
        patch: operation('Update name, quotas or enabled state', ref('ClientKey'), 'UpdateClientKey', [id]),
        delete: operation('Delete a client key', ok, undefined, [id]),
      },
      '/api/client-keys/{id}/rotate': {
        post: operation('Rotate a key while preserving its policy and quotas', ref('ClientKey'), undefined, [
          id,
        ]),
      },
      '/api/client-keys/{id}/access-policy': {
        get: operation('Read effective policy configuration', { type: 'object' }, undefined, [id]),
        patch: operation(
          'Patch route, provider and model permissions',
          { type: 'object' },
          'AccessPolicyPatch',
          [id],
        ),
      },
      '/api/routing': {
        get: {
          ...operation('Read routing entries and ETag', ref('Routing')),
          responses: { 200: { ...response(ref('Routing')), headers: { ETag: { schema: string } } } },
        },
        put: operation('Save routing priorities; use If-Match to detect conflicts', ok, 'RoutingUpdate', [
          { name: 'If-Match', in: 'header', schema: string },
        ]),
      },
      '/api/routing/models/{id}': {
        patch: {
          ...operation('Enable or disable one route', { type: 'object' }, undefined, [id]),
          requestBody: {
            required: true,
            content: { 'application/json': { schema: object({ enabled: boolean }) } },
          },
        },
      },
      '/api/requests': {
        get: operation('List routed requests with stable cursor pagination', paged('Request'), undefined, [
          ...paging,
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['success', 'error', 'cancelled'] },
          },
          { name: 'platform', in: 'query', schema: string },
          {
            name: 'q',
            in: 'query',
            schema: string,
            description: 'Search request IDs, trace IDs and model IDs.',
          },
          { name: 'clientKeyId', in: 'query', schema: { type: 'integer', minimum: 1 } },
        ]),
      },
      '/api/requests/{id}': {
        get: operation(
          'Inspect a request and its fallback trace',
          object({ request: ref('Request'), attempts: array(ref('Request')), completeTrace: boolean }),
          undefined,
          [id],
        ),
      },
      '/api/discovery/providers': {
        get: operation('List available discovery providers and their selection', { type: 'object' }),
        put: {
          ...operation('Select discovery providers', { type: 'object' }),
          requestBody: {
            required: true,
            content: { 'application/json': { schema: object({ selectedProviders: array(string) }) } },
          },
        },
      },
      '/api/discovery/enable': {
        post: {
          ...operation('Enable scheduled discovery', { type: 'object' }),
          requestBody: {
            content: {
              'application/json': {
                schema: object({ refreshIntervalHours: { type: 'integer', minimum: 1, maximum: 24 } }, []),
              },
            },
          },
        },
      },
      '/api/discovery/disable': {
        post: operation('Disable scheduling and stop current discovery', { type: 'object' }),
      },
      '/api/discovery/detected-models': {
        get: operation('Read cached discovery results', array({ type: 'object' })),
      },
      '/api/routing/presets/{preset}': {
        get: operation(
          'Preview a routing preset without saving it',
          object({ preset: string, order: array(integer) }),
          undefined,
          [
            {
              name: 'preset',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: ['intelligence', 'speed', 'budget'] },
            },
          ],
        ),
      },
      '/api/discovery/status': {
        get: operation('Read discovery progress and scheduling', { type: 'object' }),
      },
      '/api/discovery/refresh': {
        post: operation(
          'Start discovery without waiting for completion',
          object({ status: string, statusUrl: string }),
          undefined,
          [],
          202,
        ),
      },
      '/api/discovery/cancel': {
        post: operation('Cancel the current refresh and retain scheduling', { type: 'object' }),
      },
      '/api/backups/status': {
        get: operation(
          'Inspect database size and a staged restore',
          object({
            databaseBytes: integer,
            pendingRestore: boolean,
            stagedAt: nullableString,
            maxBackupBytes: integer,
          }),
        ),
      },
      '/api/backups/export/database': {
        get: {
          summary: 'Download a SQLite backup; encryption key excluded',
          security: [],
          responses: {
            200: {
              description: 'SQLite file',
              content: { 'application/vnd.sqlite3': { schema: { type: 'string', format: 'binary' } } },
            },
            413: error,
          },
        },
      },
      '/api/backups/import/database': {
        post: {
          summary: 'Verify and stage a restore for the next restart',
          security: [],
          parameters: [
            {
              name: 'X-LLMHarbor-Restore-Confirmation',
              in: 'header',
              required: true,
              schema: { type: 'string', enum: ['RESTORE_LLMHARBOR_BACKUP'] },
            },
          ],
          requestBody: {
            required: true,
            content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
          },
          responses: { 202: response({ type: 'object' }), 400: error, 413: error },
        },
      },
    });
  }
  return {
    openapi: '3.0.3',
    info: {
      title: includeControlPlane ? 'LLMHarbor dashboard & inference APIs' : 'LLMHarbor inference API',
      version: '1.0.0',
      description:
        'Text-chat gateway. Existing /api/keys, /api/endpoints, /api/settings/api-keys and /api/fallback aliases remain supported. PATCH preserves omitted fields; null clears nullable quotas.',
    },
    servers: [{ url: '../../', description: 'This LLMHarbor listener' }],
    security: [{ ClientKey: [] }],
    components: {
      securitySchemes: {
        ClientKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'Use a client key created in Client access.',
        },
      },
      schemas,
    },
    paths,
  };
}
