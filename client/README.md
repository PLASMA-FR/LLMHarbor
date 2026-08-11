# LLMHarbor dashboard

The React/Vite control plane for LLMHarbor. It is built into `client/dist` and served by the production Express process; the public split listener never mounts these routes.

Use Node.js `^22.12.0` or `^24.0.0`. From the repository root:

```bash
npm run dev -w client
npm run lint -w client
npm run build -w client
```

The development server proxies `/api` and `/v1` to the dashboard listener configured by the root `.env`. It resolves `LLMHARBOR_DASHBOARD_HOST`/`LLMHARBOR_DASHBOARD_PORT` first, then `DASHBOARD_HOST`/`DASHBOARD_PORT`, then `HOST`/`PORT`. The default target is `http://127.0.0.1:3001`.

Keep control-plane requests in `src/lib/api.ts`, reuse the focused UI primitives under `src/components/ui`, and preserve keyboard navigation, explicit labels, loading/error/empty states, and narrow-window table scrolling when changing pages.
