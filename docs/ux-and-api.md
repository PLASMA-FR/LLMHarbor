# Dashboard and API experience

This pass treats LLMHarbor as two related products: a local control dashboard and an OpenAI-compatible inference API. It retains the existing network/access-policy boundary and all prior API paths.

## Dashboard information architecture

| Area | Responsibility |
|---|---|
| Overview | Gateway health, a three-step setup checklist, recent activity and route readiness. |
| Providers | Upstream credentials and custom connections. Creation, import and credential replacement use focused dialogs. |
| Models | Search across the catalog, register and probe models, edit settings and enable a route directly. |
| Routing | Preview and save an ordered draft. Navigation warns about unsaved work; ETags detect concurrent edits. |
| OAuth accounts | Connect and manage browser-account capacity. |
| Client access | App keys, one-time secrets, rotation, quotas and paged access policies. |
| Analytics | Aggregate metrics or paginated request history with a fallback inspector. |
| API & SDKs | Reachable base URLs, runnable integration examples, error guidance and downloadable OpenAPI. |
| Settings | Separate model-discovery and backup workflows. |

`/keys` redirects to `/providers`. Old links such as `/settings?key=123#access-policies` lead to Client access. Backup and discovery hash links remain usable. Existing legacy endpoint-bound client keys retain their assigned API paths and inherited provider restrictions.

## Interaction and design-system rules

- Keep one primary page action. Put creation/rotation/destructive decisions in the shared Modal or ConfirmationDialog; use the confirmation context for imperative file flows.
- Keep provider credentials separate from client keys. Secrets are shown once after client-key creation/rotation, never in list responses or browser storage.
- Use the shared SearchField, Pagination, SectionTabs, ErrorNotice and CodeBlock components. Tables support keyboard scrolling; controls use explicit names and visible focus states.
- Use Geist Sans for interface copy and Geist Mono for IDs, code and numerical data. Neutral surfaces and one teal accent define the interface; semantic error/warning colors remain distinct.
- Respect existing light/dark preferences and reduced motion. Touch inputs use 16px text; buttons and form controls provide larger touch targets.
- Initial dialogs focus their content controls. Escape dismisses safe dialogs; Cancel is the initial action in destructive confirmations. The page finder supports Ctrl/Cmd+K, arrows, Enter and Escape.
- Changes to access policies and individual model routes save immediately. Routing order is explicitly a draft until saved. Destructive confirmations state which resource is affected.
- The dashboard contacts its local/private server even when the browser reports no Internet connection. Failed writes surface an error instead of silently waiting in an offline queue.
- Render completed assistant Markdown lazily; keep live streaming text inexpensive. HTML is skipped, images do not fetch remote URLs, and Plain text preserves the original response. Conversations remain memory-only until exported.

## Canonical control API and compatibility

| Canonical path | Compatible older path |
|---|---|
| `/api/providers` | `/api/endpoints` |
| `/api/provider-keys` | `/api/keys` |
| `/api/client-keys` | `/api/settings/api-keys` |
| `/api/routing` | `/api/fallback` |
| `/api/discovery` | `/api/settings/free-model-updater` |
| `/api/backups` | `/api/settings/backup` |

The aliases use the same handlers. Bare key-list requests still return arrays. Pagination is opt-in on client/provider key lists; request history always returns a page:

```http
GET /api/client-keys?limit=25
GET /api/client-keys?limit=25&cursor=<pagination.nextCursor>
GET /api/requests?limit=25&status=error&clientKeyId=2&q=<request-id>
GET /api/requests/123
```

Pages use descending record IDs and return `{ data, pagination: { limit, hasMore, nextCursor } }`. A cursor remains useful when newer records arrive or older records are removed. Provider and model selectors continue to use their stable platform/model IDs.

All JSON API errors include `error.message`, `error.type`, `error.code` and `error.request_id`. Validation adds a primary `error.param` and a bounded `error.details` list of `{ path, code, message }`. Submitted values, keys and entire request bodies are not included in validation diagnostics. HTTP 401 includes a Bearer challenge, wrong methods on the inference routes return 405 with `Allow`, and non-JSON request bodies receive 415 where JSON is required. Binary backup uploads retain their own content type.

### Common operations

```http
POST /api/client-keys/{id}/rotate
PATCH /api/provider-keys/{id}             # label, enabled, or replacement key
PATCH /api/providers/{platform}/models/{id}
PATCH /api/routing/models/{id}            # {"enabled": true}
GET /api/routing/presets/intelligence     # preview only
PUT /api/routing                         # optional If-Match from GET /api/routing
POST /api/discovery/refresh              # 202; poll /api/discovery/status
POST /api/discovery/cancel
GET /api/backups/status
```

Rotating a client key preserves its ID, enabled state, quotas and policy. The prior secret stops authenticating immediately. An explicit empty `apiKey` when creating a custom provider selects anonymous upstream access; omitting `apiKey` preserves the older behavior of creating only the endpoint. Gateway client authentication is still required. Provider-key replacement resets health without allowing an older in-flight check to invalidate the replacement.

PATCH keeps omitted fields and uses explicit `null` to clear nullable quotas. An explicit catalog pause is retained across automatic rediscovery. A routing save with a stale `If-Match` receives 409 `routing_conflict` without overwriting the current configuration.

New routed requests have an internal trace ID separate from caller-supplied correlation IDs, plus client-key attribution. Reusing an `X-Request-Id` does not combine different requests in the fallback inspector. Older history remains readable, with a notice when detailed trace data is unavailable. Prompts and response bodies are not stored in request history.

## Inference contract

`GET /v1` describes the supported inference surface. `GET /v1/openapi.json` contains only inference operations; `/api/openapi.json` includes control-plane operations behind the dashboard boundary. Runtime Zod schemas supply the request structures in the OpenAPI document.

The text-chat interface accepts `developer` messages and either `max_tokens` or `max_completion_tokens`. API-key OpenAI routes preserve native developer/token-limit fields; other adapters translate them to their instruction/output-limit equivalents. Nullable token/temperature/top-p defaults are treated as omitted values. Existing unknown fields remain ignored for compatibility and are named in `X-LLMHarbor-Ignored-Parameters`.

Unsupported `n > 1` and structured-output `response_format` requests now fail validation instead of silently returning a different output contract. Text, streaming, tools and existing fallback behavior remain supported. See the official [Chat Completions reference](https://developers.openai.com/api/reference/typescript/resources/chat/subresources/completions/methods/create) for the upstream SDK; LLMHarbor's downloaded schema is authoritative for this gateway's supported subset.

## Audit and validation

The baseline Settings screen exposed 391 controls across 3,532px with one client key in the local catalog fixture. The default Settings view in that same fixture now exposes 15 controls across 1,162px. Client access, discovery and backup are separate flows, and policies render 15 rows per page. The page finder and mobile drawer make destinations discoverable without a scrolling navigation strip.

Validation covers the official OpenAI SDK against a loopback provider, OpenAPI schema validation, resource aliases, one-time key behavior, replacement races, nullable defaults, pagination, concurrent routing edits, trace isolation, recovery scheduling, desktop/mobile flows, keyboard focus, offline errors and WCAG-tagged axe checks in light/dark themes. Upstream providers are simulated; these checks do not establish real-account billing or OAuth eligibility.

The applied skill guidance covers shadcn/Base UI composition, Geist typography, React performance, browser automation and full-flow verification, plus official OpenAI documentation. The implementation keeps the existing Vite/React/Express stack and its local security boundary.
