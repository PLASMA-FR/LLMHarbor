# LLMHarbor dashboard

The React/Vite control plane for LLMHarbor. It is built into `client/dist` and served by the production Express process; the public split listener never mounts these routes.

Use Node.js `^22.12.0` or `^24.0.0`. From the repository root:

```bash
npm run dev -w client
npm run lint -w client
npm run typecheck -w client
npm run build -w client
npx playwright install chromium
npm run test:e2e
```

The development server proxies `/api` and `/v1` to the dashboard listener configured by the root `.env`. It resolves `LLMHARBOR_DASHBOARD_HOST`/`LLMHARBOR_DASHBOARD_PORT` first, then `DASHBOARD_HOST`/`DASHBOARD_PORT`, then `HOST`/`PORT`. The default target is `http://127.0.0.1:3001`.

Keep control-plane requests in `src/lib/api.ts`, reuse the focused UI primitives under `src/components/ui`, and preserve keyboard navigation, explicit labels, loading/error/empty states, and narrow-window table scrolling when changing pages.

Use `invalidateRoutingQueries` after mutations that affect route availability. Playground drafts are kept in the application context so navigation does not discard a conversation; reload intentionally clears this memory. Browser tests require a current production build and start an in-memory server with a simulated local provider on port 4179. See [the contributing guide](../CONTRIBUTING.md).

The shell uses a data router for unsaved-change protection, a page finder, and a mobile drawer. Client access is separate from provider configuration. Use the shared collection controls, modal/confirmation primitives, ErrorNotice and CodeBlock components; the full interaction and API conventions are in [the UX guide](../docs/ux-and-api.md).
