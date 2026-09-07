# Contributing to LLMHarbor

Use Node 22.12+ or Node 24 LTS and npm 10+. The `.nvmrc` and `.node-version` files select Node 24. Run commands from the repository root.

```bash
npm ci
npm run dev
```

The dashboard runs on port 5173 and proxies API calls to the server configured in `.env` (port 3001 by default). Production serves the built dashboard and API from the server. Keep `.env`, `server/data/`, provider credentials and backups out of commits.

## Validation

```bash
npm run typecheck       # Both workspaces; no output emitted
npm run check           # ESLint, unit/integration tests, production builds
npx playwright install chromium
npm run test:e2e        # Browser workflows against the production dashboard build
npm audit
bash -n bin/llmharbor install.sh install-macos.sh
```

Run `npm run build` before `test:e2e` whenever dashboard code changes. On Linux, `npx playwright install --with-deps chromium` also installs browser OS dependencies. CI runs browser checks on Node 24 and the server tests/builds on both supported Node lines.

Browser tests start their own listener on `127.0.0.1:4179`, use SQLite in memory and a simulated loopback provider, and do not read the production database or call real model providers. The port must be available. Failure traces are written to `client/test-results/`; inspect one with `npx playwright show-trace <trace.zip>`.

For focused checks:

```bash
npm run test -w server -- src/__tests__/routes/model-settings.test.ts
npm run test -w client -- src/lib/api.test.ts
npm run test:e2e -w client -- --grep Playground
```

## Working on the server

- Keep client authorization and quota checks before upstream work. Use `services/credentials.ts` for credential eligibility and OAuth preparation.
- Use `providers/openai-stream.ts` for OpenAI-compatible SSE. It normalizes envelopes, preserves tool/refusal/reasoning deltas, bounds preambles and validates completion termination. `lib/sse.ts` handles framing and reader cleanup.
- Keep retries before substantive output. Once streaming starts, retain downstream cancellation and provider body-idle timeouts; do not replay a partial completion.
- Provider error responses and analytics must not contain raw upstream bodies or secrets. Use the existing safe error helpers.
- Keep related database mutations in one transaction and resolve the provider/model pair before deleting anything. A partial PATCH must preserve omitted fields; explicit null clears a limit.
- Preserve migration history. Add idempotent migrations and regression coverage for existing databases rather than rewriting catalog history.

## Working on the dashboard

- Use `apiFetch` for JSON APIs and pass React Query's cancellation signal. Use `invalidateRoutingQueries` after configuration changes that affect several views.
- Keep loading, empty and error states distinct. Label controls, preserve keyboard operation and check narrow layouts.
- Playground state lives in memory above the page routes. It survives navigation but is intentionally cleared on reload; do not persist conversation text or credentials to browser storage by default.
- Add browser coverage for changes to complete user workflows. Unit tests should cover parsing and state invariants, not duplicate component markup.

See [architecture and audit notes](docs/engineering-notes.md) for the implementation boundaries and validation scope.
