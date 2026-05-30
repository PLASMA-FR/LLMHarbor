<div align="center">
  <img src="docs/logo.svg" alt="LLMHarbor anchor logo" width="110" height="110" />

  # LLMHarbor

  **Drop one anchor. Route every model.**

  A self-hosted personal API platform for free-tier and local LLM endpoints. Add your provider keys once, mint separate local client keys for every app or agent, and let LLMHarbor route requests across the models that are healthy and allowed.

  <p>
    <a href="https://github.com/PLASMA-FR/LLMHarbor/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/PLASMA-FR/LLMHarbor/ci.yml?branch=main&label=tests&style=for-the-badge"></a>
    <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-204b46?style=for-the-badge"></a>
    <img alt="Node 20+" src="https://img.shields.io/badge/node-20%2B-2f6f68?style=for-the-badge">
    <img alt="OpenAI compatible" src="https://img.shields.io/badge/OpenAI-compatible-163c38?style=for-the-badge">
  </p>

  <p>
    <a href="#quick-start">Quick start</a> ·
    <a href="#screenshots">Screenshots</a> ·
    <a href="#using-the-api">API</a> ·
    <a href="#supported-providers">Providers</a> ·
    <a href="#bulk-import-provider-keys">Bulk import</a> ·
    <a href="#settings--access-policy">Access policy</a> ·
    <a href="#terms-of-use">Terms of Use</a> ·
    <a href="https://plasma-fr.github.io/LLMHarbor/">Website</a> ·
    <a href="#contributing">Contributing</a>
  </p>
</div>

<p align="center">
  <img src="docs/logo.svg" alt="LLMHarbor project logo: an anchor-shaped routing mark" width="144" height="144" />
</p>

<p align="center">
  <img src="repo-assets/playground.png" alt="LLMHarbor playground dashboard" width="920" />
</p>

## What is LLMHarbor?

LLMHarbor is a local personal API platform for routing chat completions across many upstream LLM providers. It exposes the OpenAI API shape your apps already know, then handles the messy parts behind it: multiple client API keys with route/provider/model access policies, encrypted provider keys, browser OAuth accounts, fallback order, health checks, per-key traffic tracking, custom provider endpoints, model probes, streaming responses, tool calls, and request analytics.

Use it when you want one stable local endpoint for experiments, coding agents, small tools, and personal workflows without wiring every provider into every app.

```txt
Your app / OpenAI SDK
        |
        |  Bearer llmharbor-...
        v
LLMHarbor local proxy
        |
        |  chooses a healthy model under quota
        v
Google · Groq · Cerebras · Mistral · OpenRouter · Cloudflare · Ollama · Custom endpoints
```

## Why it exists

Free tiers are useful, but they are scattered. Each provider has its own key, model list, rate limit, streaming quirks, error format, and tool-call behavior. One provider fails with a 429. Another times out. A third changes the model ID you were using.

LLMHarbor puts a harbor in front of that traffic.

- One local OpenAI-compatible base URL.
- Multiple personal client API keys for apps, agents, laptops, and experiments.
- Per-key route, provider, and model gates before any upstream quota is spent.
- One llmharbor key per app, agent, laptop, or experiment with isolated access policy.
- API-key providers and browser OAuth accounts behind it.
- A fallback chain you can inspect and reorder.
- A dashboard that shows what happened after each request.

It is not meant to sell free tiers as production infrastructure. It is meant to make personal routing sane.

## Highlights

| Area | What LLMHarbor does |
|---|---|
| OpenAI compatibility | `POST /v1/chat/completions` and `GET /v1/models` work with OpenAI-style SDKs and clients. |
| Auto routing | Use `model: "auto"` and let the router choose the highest-priority healthy model under quota. |
| Fallbacks | On 429, 5xx, timeout, or provider failure, LLMHarbor cools that key down and tries the next enabled route. |
| Streaming | Server-Sent Events are supported for `stream: true`. |
| Tool calls | OpenAI-style `tools`, `tool_choice`, assistant `tool_calls`, and tool follow-up messages round trip through the proxy. |
| Client keys | Mint multiple OpenAI-compatible client keys, label them by app or device, and set per-key route/provider/model access policies. |
| Browser OAuth | Connect supported browser accounts such as OpenAI/ChatGPT and Antigravity through loopback OAuth with encrypted refresh storage and live model discovery. |
| Key storage | Provider keys and OAuth tokens are encrypted with AES-256-GCM before they are written to SQLite. |
| Rate tracking | RPM, RPD, TPM, and TPD counters are tracked for upstream providers, models, and routing health. |
| Sticky sessions | Multi-turn conversations can stay on the same model for a short window to avoid mid-thread model jumps. |
| Custom providers | Add any OpenAI-compatible endpoint from the dashboard. Local vLLM, Ollama-compatible gateways, OpenCode Zen, and private gateways fit here. |
| Model probes | Test whether a model works before putting traffic on it. |
| Analytics | Track request count, success rate, latency, token use, provider split, model split, and recent failures. |

## Screenshots

### Playground

Send a request through the router, inspect the routed provider, and see latency without leaving the dashboard.

<p align="center">
  <img src="repo-assets/playground.png" alt="LLMHarbor playground page" width="920" />
</p>

### Keys

Store provider credentials, create personal client keys, check health, connect browser OAuth accounts, and manage custom OpenAI-compatible endpoints.

<p align="center">
  <img src="repo-assets/keys.png" alt="LLMHarbor keys page" width="920" />
</p>

### Models

Register built-in and custom endpoint models, probe live credentials, and keep model context defaults with the provider.

<p align="center">
  <img src="repo-assets/models.png" alt="LLMHarbor models page" width="920" />
</p>

### Fallback chain

Reorder the route list, toggle models on or off, and choose presets for quality, speed, or remaining budget.

<p align="center">
  <img src="repo-assets/fallback.png" alt="LLMHarbor fallback chain page" width="920" />
</p>

### Analytics

See traffic, latency, tokens, estimated savings, model breakdowns, and provider errors.

<p align="center">
  <img src="repo-assets/analytics.png" alt="LLMHarbor analytics page" width="920" />
</p>

### Settings / access policy

Scope each `llmharbor-*` key by route, provider, and model catalog while every app keeps using the same local `/v1` base URL.

<p align="center">
  <img src="repo-assets/settings.png" alt="LLMHarbor settings page showing local API access controls" width="920" />
</p>

## Supported providers

LLMHarbor ships with adapters and catalog entries for the common free-tier and OpenAI-compatible routes. Some providers require account setup or have stricter terms than others.

| Provider | Typical models or routes | Notes |
|---|---|---|
| Google API keys | Gemini Flash and Pro family | Native adapter with OpenAI shape translation. |
| OpenAI / ChatGPT OAuth | Account-discovered GPT and Codex routes | Browser OAuth account flow with loopback callback and live inventory. |
| Antigravity OAuth | Google Code Assist / Gemini routes | Browser OAuth account flow with Code Assist inventory and reconnect handling. |
| Groq | Llama, GPT-OSS, Qwen | Fast OpenAI-compatible route. |
| Cerebras | Qwen and Llama routes | Fast inference, quota-dependent. |
| SambaNova | DeepSeek, Llama, Gemma | OpenAI-compatible route. |
| Mistral | Mistral Large, Codestral, Devstral | OpenAI-compatible route. |
| OpenRouter | Free and paid OpenRouter models | Works well as an extra model pool. |
| GitHub Models | GPT-4.1, GPT-4o family | Useful for prototyping. |
| Cloudflare Workers AI | Kimi, GLM, GPT-OSS, Granite | Account and route configuration required. |
| Cohere | Command family | Supported, but review terms before personal use. |
| HuggingFace Router | Provider-routed open models | OpenAI-compatible route. |
| Zhipu / Z.ai | GLM family | Terms differ by entity and endpoint. |
| Ollama Cloud | Cloud model access | Good for local-first workflows. |
| Custom OpenAI-compatible | vLLM, LiteLLM, OpenCode Zen, private gateways | Add from the Keys page, then register models on Models. |

## Quick start

### Prerequisites

- Node.js 20+
- npm
- A provider API key, or a local OpenAI-compatible endpoint to add later

### One-line install

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/PLASMA-FR/LLMHarbor/main/install.sh | bash
llmharbor start
llmharbor open
```

macOS-specific installer with Homebrew/Xcode hints:

```bash
curl -fsSL https://raw.githubusercontent.com/PLASMA-FR/LLMHarbor/main/install-macos.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/PLASMA-FR/LLMHarbor/main/install.ps1 | iex
llmharbor start
llmharbor open
```

The installers clone the repo, create a local `.env` with a fresh encryption key, install dependencies, build the production app, and place a `llmharbor` command on your PATH. Defaults:

| OS | App directory | Command directory |
|---|---|---|
| Linux/macOS | `~/.llmharbor/app` | `~/.local/bin` or `/usr/local/bin` on macOS when writable |
| Windows | `%USERPROFILE%\.llmharbor\app` | `%LOCALAPPDATA%\LLMHarbor\bin` |

Override with `LLMHARBOR_HOME`, `LLMHARBOR_BIN_DIR`, or `LLMHARBOR_REPO` when needed.

### Manual install

```bash
git clone https://github.com/PLASMA-FR/LLMHarbor.git
cd LLMHarbor
npm install
```

Create an environment file:

```bash
cp .env.example .env
node -e 'console.log("ENCRYPTION_KEY=" + require("crypto").randomBytes(32).toString("hex"))' >> .env
```

Start the server and dashboard together:

```bash
npm run dev
```

Or use the bundled command line:

```bash
./bin/llmharbor install
./bin/llmharbor start
./bin/llmharbor open
```

Open the dev dashboard:

```txt
http://localhost:5173
```

Production runs on:

```txt
http://localhost:3001
```

Then:

1. Go to **Keys** and add provider keys or a custom endpoint.
   - For one key, paste it into **Add a provider key**.
   - For many keys, use **Bulk import provider keys** with a `.txt` file: one key per line. The provider id follows the visible list, so Google is `1`, Groq is `2`, and custom providers continue after built-ins.
2. Go to **Models** and probe the models you want to use.
3. Optional: go to **OAuth** and connect a supported browser account such as OpenAI/ChatGPT or Antigravity.
4. Go to **Fallback** and order the route list.
5. Create or copy a client API key from **Keys**.
6. Open **Settings** and restrict that key to specific local routes, provider endpoints, or model rows.
7. Point your OpenAI-compatible client at `http://localhost:3001/v1`.

### Production build

```bash
npm run build
node server/dist/index.js
```

The production server serves the API and built dashboard on port `3001`.

## Using the API

LLMHarbor accepts OpenAI-style chat requests. Change the base URL and API key, then keep using the client you already use.

### Python

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key=os.environ["LLMHARBOR_API_KEY"],
)

response = client.chat.completions.create(
    model="auto",
    messages=[
        {"role": "user", "content": "Explain SQLite WAL mode in two sentences."}
    ],
)

print(response.choices[0].message.content)
```

### curl

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer YOUR_LLMHARBOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "hi"}]
  }'
```


### Client key access policies

Local `llmharbor-*` keys can be scoped without touching upstream provider credentials. Create one key per app, then decide which local routes, provider endpoints, and model rows that key may use.

```bash
curl http://127.0.0.1:3001/api/settings/api-keys \
  -H "Content-Type: application/json" \
  -d '{
    "label": "editor agent"
  }'
```

Access policies are stored per local key. They can block an OpenAI-compatible route such as `/v1/models`, deny a whole provider endpoint, or hide and reject a specific model before any upstream provider call is made.

```bash
# Inspect routes, provider endpoints, and model rows available to one key
curl http://127.0.0.1:3001/api/settings/api-keys/1/access-policy

# Block model catalog listing and one provider for that key
curl -X PATCH http://127.0.0.1:3001/api/settings/api-keys/1/access-policy \
  -H "Content-Type: application/json" \
  -d '{
    "routes": [{"route":"v1.models","enabled":false}],
    "platforms": [{"platform":"google","enabled":false}]
  }'
```

Custom local endpoint creation is intentionally retired: `POST /api/settings/local-endpoints` returns `410`. Keep using `/v1` and segment apps with key-specific policy instead.

### Browser OAuth accounts

The OAuth page connects supported browser accounts through loopback callbacks and encrypted token storage. Discovery refreshes provider-reported model inventory and usage windows so `/v1/models` only exposes models that are actually routeable. Antigravity uses Google Code Assist's native desktop client by default, so the Connect button is available on a fresh local install; set `LLMHARBOR_ANTIGRAVITY_OAUTH_CLIENT_SECRET` only if Google rotates that public client credential and you need to override it.

Qwen OAuth was removed because the device-code path no longer provides a usable free approval flow and can require a paid Qwen account before approval. Use Qwen-family models through supported free-tier providers such as OpenRouter, Groq, or Cerebras when available.

```bash
# Start browser-account login flows from the local dashboard/API
POST /api/oauth/connect/openai/start
POST /api/oauth/connect/antigravity/start

# Refresh discovered account models and limits
GET /api/oauth/accounts/:id/models
```

### Bulk import provider keys

If you have a batch of provider credentials, create a plain text file with one key per line:

```txt
key-one
key-two
# comments and blank lines are ignored
key-three
```

Open **Keys → Bulk import provider keys**, choose the provider id, upload the file, and import. Provider ids are based on the visible provider order: Google is `1`, Groq is `2`, and custom endpoints continue after the built-ins. Cloudflare lines should use the same stored shape as the single-key form: `account_id:api_token`.

The same flow is available through the local control-plane API:

```bash
curl http://127.0.0.1:3001/api/keys/import \
  -H "Content-Type: application/json" \
  -d '{"providerId":1,"contents":"key-one\nkey-two","labelPrefix":"Google batch"}'
```

### Streaming

```python
stream = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Stream a short haiku about SQLite."}],
    stream=True,
)

for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

### Tool calling

```python
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]

first = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "What's the weather in Karachi?"}],
    tools=tools,
    tool_choice="required",
)

call = first.choices[0].message.tool_calls[0]

final = client.chat.completions.create(
    model="auto",
    messages=[
        {"role": "user", "content": "What's the weather in Karachi?"},
        first.choices[0].message,
        {"role": "tool", "tool_call_id": call.id, "content": '{"temp_c": 32, "cond": "sunny"}'},
    ],
    tools=tools,
)

print(final.choices[0].message.content)
```

Every successful response includes routing headers when available:

| Header | Meaning |
|---|---|
| `X-Routed-Via` | Provider and model that served the request. |
| `X-Fallback-Attempts` | Number of providers tried before success. |

## Dashboard map

| Page | Use it for |
|---|---|
| Playground | Send a test request and inspect the route result. |
| Keys | Manage local client keys, provider keys, key health, and custom providers. |
| OAuth | Connect browser accounts, refresh discovered models, inspect account limits, and handle reconnects. |
| Models | Register endpoint models and run probes. |
| Fallback | Reorder the chain and switch models on or off. |
| Analytics | Watch volume, latency, tokens, savings, errors, and model usage. |
| Settings | Tune local API access policies for each `llmharbor-*` key. |

## How routing works

```mermaid
flowchart LR
  A[OpenAI SDK, curl, agents] -->|Bearer llmharbor key| B[Express API]
  B --> P{Route allowed by key policy?}
  P -->|no| Z[403 access denied]
  P -->|yes| C{Model requested?}
  C -->|auto| D[Router picks highest priority healthy model]
  C -->|specific model| E[Router finds matching enabled model]
  D --> Q{Provider/model allowed?}
  E --> Q
  Q -->|no| Z
  Q -->|yes| F[Decrypt provider key in memory]
  F --> G[Call provider adapter]
  G -->|success| H[Return OpenAI-shaped response]
  G -->|429, timeout, 5xx| I[Cooldown key and try next fallback]
  I --> D
  H --> J[Write analytics, provider usage, and client-key usage]
```

Main pieces:

| Component | Path | Responsibility |
|---|---|---|
| API app | `server/src/app.ts` | Express routes, CORS, OpenAI-compatible surface. |
| Router | `server/src/services/router.ts` | Model choice, fallback attempts, sticky sessions. |
| Rate limiter | `server/src/services/ratelimit.ts` | Provider-side RPM, RPD, TPM, TPD accounting and cooldowns. |
| Providers | `server/src/providers/*.ts` | Provider-specific request and streaming adapters. |
| Keys routes | `server/src/routes/keys.ts` | Provider credential management and bulk import. |
| Settings routes | `server/src/routes/settings.ts` | Local client API keys, route/provider/model access policies, and legacy endpoint compatibility. |
| OAuth routes | `server/src/routes/oauth.ts` | Browser-account OAuth flows, encrypted account storage, and discovered inventory. |
| Access policy service | `server/src/services/accessPolicy.ts` | Per-client-key policy snapshots, persistence, and enforcement helpers. |
| Endpoint routes | `server/src/routes/endpoints.ts` | Custom providers and model registry. |
| Database | `server/src/db/index.ts` | SQLite schema, seed catalog, encrypted key storage. |
| Dashboard | `client/src` | React control plane. |
| Shared types | `shared/types.ts` | Request, model, provider, and analytics types. |

## Security model

LLMHarbor is local-first and single-user by design.

- Provider keys are encrypted at rest with AES-256-GCM.
- The encryption key comes from `ENCRYPTION_KEY` in `.env` for real use.
- The development fallback key is only for local experimentation. Do not use it with real provider credentials.
- Clients call LLMHarbor with one `llmharbor-...` token.
- Each local client token can have independent route, provider, and model policy.
- Upstream provider keys and OAuth refresh tokens never leave the server process.
- The server binds to `127.0.0.1` by default. Set `HOST=0.0.0.0` only behind your own firewall, VPN, or authenticated reverse proxy.
- The dashboard/control-plane API stays loopback-only by default even when the authenticated `/v1` proxy is remotely bound. Set `LLMHARBOR_ALLOW_REMOTE_CONTROL_PLANE=1` only behind your own network controls.
- Do not expose your LLMHarbor instance directly to the public internet.

## What is not supported yet

LLMHarbor focuses on OpenAI-compatible chat completions. These endpoint families are out of scope:

- Images: `/v1/images/generations`
- Audio speech: `/v1/audio/speech`
- Embeddings: `/v1/embeddings`
- Moderation: `/v1/moderations`
- Legacy completions: `/v1/completions`
- `n > 1` multi-completion requests
- Multi-tenant auth, billing, orgs, or team management

## Verification status

This rebrand was verified locally with automated scans and live app dogfooding:

- `npm run build` for server TypeScript and the production Vite dashboard.
- Server Vitest coverage for routing, rate limits, OAuth discovery, proxy behavior, and client-key access policies.
- Client ESLint and dependency audit with zero reported vulnerabilities.
- Secret-pattern scan across tracked and untracked non-generated files.
- In-process API smoke against a mock OpenAI-compatible provider covering provider keys, custom endpoints, model registration, health checks, per-key access policies, `/v1/models`, non-streaming chat, streaming chat, fallback ordering, analytics, OAuth surfaces, and cleanup paths.
- Headless Chromium responsive sweep across Playground, Keys, OAuth, Models, Fallback, Analytics, and Settings at desktop, tablet, mobile, and 320px narrow widths. The sweep checks page titles, headings, root/body overflow, offscreen content outside scroll containers, and console/runtime errors.

## Development

```bash
npm install
npm run dev       # server on :3001, dashboard on :5173
npm test          # server Vitest suite, plus client tests if present
npm run build     # TypeScript + Vite production build
```

Useful workspace commands:

```bash
npm run build -w server
npm run build -w client
npm run test -w server
```

CLI commands:

```bash
./bin/llmharbor doctor   # check git, node, npm, curl, .env, and build output
./bin/llmharbor install  # install dependencies, create .env, and build
./bin/llmharbor start    # run production server in the background
./bin/llmharbor status   # show process and health-check status
./bin/llmharbor logs     # follow server logs
./bin/llmharbor stop     # stop the background server
./bin/llmharbor update   # git pull, rebuild, and restart if running
```

Before opening a PR:

```bash
npm test
npm run build
```

## Project structure

```txt
LLMHarbor/
  client/               React + Vite dashboard
    src/components/     Shared UI primitives and app shell pieces
    src/pages/          Playground, Keys, OAuth, Models, Fallback, Analytics, Settings
  server/               Express API and provider routing
    src/db/             SQLite schema and model catalog
    src/providers/      Provider adapters
    src/routes/         API routes
    src/services/       Router, health checks, rate limiter
  shared/               Shared TypeScript types
  bin/                  LLMHarbor command line
  website/              Static GitHub Pages site
  docs/                 Logo, Open Graph assets, generated docs assets
  repo-assets/          README screenshots
  install.sh            Curl-friendly installer script
```

## Environment

Common `.env` values:

```bash
ENCRYPTION_KEY=replace-with-64-hex-characters
PORT=3001
DEV_MODE=false
DATABASE_PATH=server/data/llmharbor.db
```

Provider keys are normally added in the dashboard. Keep `.env` and SQLite data out of commits.

## Limitations and honest notes

- Free-tier quotas move. Providers can change limits or remove models without warning.
- The best model in your chain may run out early in the day. After that, routing falls to the next enabled model.
- Latency varies by provider. Groq and Cerebras are often fast. Others may not be.
- Some provider terms limit production, resale, personal use, or traffic relay patterns. Read the terms for each account you connect.
- There is no SLA. If the request matters, use a paid provider directly or put LLMHarbor behind your own reliability layer.

## Contributing

Good contributions are practical and testable.

- Add a provider adapter.
- Add an endpoint family such as embeddings or images.
- Improve fallback scoring.
- Improve analytics and charts.
- Add deployment recipes.
- Tighten copy, accessibility, keyboard behavior, or empty states.
- Add tests for provider quirks and rate-limit edge cases.

A provider PR usually touches:

```txt
server/src/providers/<provider>.ts
server/src/providers/index.ts
server/src/db/index.ts
server/src/__tests__/providers/<provider>.test.ts
```

Please keep PRs focused and include tests for routing behavior when possible.

## Terms of Use

LLMHarbor is a self-hosted routing tool. It does not bypass provider terms, quota systems, paid access requirements, or account policies. You are responsible for how every upstream API key and browser account is used.

### Antigravity account warning

**Paid Antigravity accounts may be banned for using this tool.** Antigravity uses Google OAuth and Google Code Assist account surfaces that can flag automated routing, shared OAuth-client behavior, repeated refreshes, or non-standard access patterns.

Use a free Google account for Antigravity OAuth instead of your primary, paid, work, school, or Google Workspace account. Do not connect an account you cannot afford to lose.

### Safe defaults

- Use one disposable or low-risk account per provider.
- Do not resell access or expose a public shared endpoint.
- Do not depend on trial-only APIs for production.
- Do not use traffic volume that looks like a commercial relay.
- Read the terms for every provider you connect.

This is not legal advice. LLMHarbor contributors are not responsible for provider bans, quota changes, account suspensions, or service interruptions.

## Star history

[![Star History Chart](https://api.star-history.com/chart?repos=PLASMA-FR/LLMHarbor&type=date&legend=top-left)](https://www.star-history.com/#PLASMA-FR/LLMHarbor&date)

## License

MIT. See [LICENSE](./LICENSE).
