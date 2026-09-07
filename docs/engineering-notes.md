# Architecture and audit notes

## Runtime boundaries

The Express dashboard listener hosts the local control plane and the authenticated `/v1` API. Optional split mode creates a separate public listener with only `/v1`, legacy `/e/:slug/v1`, and liveness routes. Dashboard authority/origin checks remain independent of client-key authentication. The dashboard can select a client key's policy through its protected Playground proxy without recovering a stored secret.

SQLite owns configuration, migration history, credential ciphertext, client-key digests, request history and persisted quotas. In-flight capacity reservations and routing preferences are process-local. A file-backed installation uses `.env` encryption material or a separate private key sidecar; database backups deliberately exclude the encryption key.

Credential eligibility is shared by model visibility, route selection and model probes. OAuth preparation refreshes tokens and passes the account identity and metadata to the matching adapter. Probes can exercise an unlisted model without enabling it in automatic routing.

The OpenAI-compatible adapters for generic endpoints, Cohere and Cloudflare share one stream parser. It supports UTF-8, CR/LF, multiline data fields and compatible terminal events, and cancels/releases readers on completion. The framing rules follow the [HTML SSE specification](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream), with an intentional compatibility allowance for a final event without its trailing blank line. Events/lines are bounded to 1,048,576 characters; pre-completion metadata is bounded to 64 frames or 256 KiB of characters. Reasoning deltas are output, not metadata.

The gateway's three-minute fallback deadline covers route preparation and the wait for substantive output. After streaming begins, provider body-idle timeouts and downstream cancellation remain active. Token estimates accumulate characters across chunks before rounding, so network fragmentation does not affect accounting. Reported usage takes precedence, including explicit zero completion tokens; all-zero legacy usage placeholders fall back to estimates.

## September 2026 improvement pass

The audit covered application boot/shutdown, all route/service/provider modules, schema and catalog migrations, dashboard pages and shared components, CLI/installers, the static site, CI, tests and documentation. The implementation prioritized observable correctness and workflow gaps over a wholesale rewrite.

| Area | Implemented change |
|---|---|
| Model management | Provider-scoped deletion preflight; validated PATCH for display metadata, context windows and quotas; inline model editor and compact mobile provider picker. |
| OAuth probes | Use eligible account credentials, refresh them and supply adapter metadata. |
| Streaming | Shared OpenAI parser, bounded buffering, stable envelopes, multiline/CR framing and preserved reasoning/refusal/tool output. |
| Accounting | Fragmentation-independent estimates, reported zero usage, Google streaming usage and no duplicate quota events after maintenance failures. |
| API behavior | Structured API-root 404s, no-store control-plane responses, immutable hashed assets and clearer client errors for proxy/HTML responses. |
| Quotas | Partial client-quota patches preserve unrelated limits; positive safe-integer validation. |
| Model discovery | Resume persisted scheduling after restart; new models remain disabled until verified. |
| Dashboard | In-memory Playground drafts, copy/export/retry controls, request IDs, bounded conversation scrolling, working sticky navigation and complete model-policy browsing. |
| Consistency | Shared invalidation of related configuration queries; URL-driven policy selection. |
| Performance | Indexable time-range analytics predicates and an index for usage maintenance. |
| Tooling | Strict client TypeScript, server unused-code checking, supported Node selectors, explicit typecheck command, local browser fixtures and CI browser checks. |

## Validation limits

Tests use mocked or loopback providers. They verify contracts, cancellation, quotas, migrations, control-plane boundaries and browser workflows without spending upstream credits. They cannot establish the current availability, billing, model capabilities or OAuth eligibility of a real provider account. Native macOS/Windows CLI behavior is covered by the existing CI jobs; Linux syntax checks alone do not replace those jobs.

The product remains a text-chat gateway. Vision/audio inputs, embeddings, multi-tenant dashboard login and automatic rollback of a failed CLI update are outside the implemented feature set. Existing explicit-model retry/fallback behavior and legacy routes are preserved.
