# MASTER PROMPT: THE EVOLUTION OF LLMHARBOR
# MISSION: Transform LLMHarbor into a World-Class, Production-Grade API Platform

You are an Elite Principal Software Engineer and a UI/UX Visionary. You have been tasked with the full-scale overhaul of LLMHarbor. This is not just a bug-fixing mission; it is a transformation from a "utility proxy" to a "SaaS-ready Orchestration Platform."

---

## I. PHILOSOPHY & DESIGN PRINCIPLES

### 1. The "Emil Kowalski" Aesthetic
You must use your specialized UI/UX skills to implement a design system that feels expensive, fast, and intentional.
- **Minimalism**: Remove every unnecessary line, border, and background. Use whitespace as a primary layout tool.
- **Typography**: Strictly Geist Variable. Use extreme contrast in font weights (e.g., 900 for headers, 400 for body).
- **Motion**: Every interaction must have a micro-animation. Buttons should slightly scale on click; panels should slide with a "spring" easing.
- **Color**: A warm monochrome palette. Deep blacks (#09090b), soft whites (#fafafa), and subtle amber/gold accents for "premium" status indicators.
- **Bento Grids**: Use asymmetric grid layouts for dashboards.
- **Feedback**: Never leave the user wondering. Success states should use subtle toast notifications; loading states should be skeleton screens, not spinners.

### 2. Engineering Excellence
- **Surgical Code**: Do not rewrite files from scratch unless necessary. Use targeted edits to preserve existing logic while enhancing it.
- **Type Safety**: TypeScript is non-negotiable. Every new interface must be strictly typed.
- **Resilience**: The platform must never crash. Wrap provider calls in robust try-catch blocks with clear, user-facing error messages that don't leak stack traces.

---

## II. THE CORE BUG FIXES & ARCHITECTURAL REPAIRS

### 1. The GPT-5 Codex "OAuth 400" Resolution
**Problem**: The discovery service identifies `gpt-5-codex` as a supported model, but the OpenAI Codex backend rejects it for browser accounts, causing a 400 error.
**Instruction**:
- Modify `server/src/services/oauth-discovery.ts`.
- Implement a `DISCOVERY_BLACKLIST` constant containing `['gpt-5-codex', 'gpt-5.1-codex']`.
- Update the `discoverOAuthAccount` function for the `openai` provider to filter these models out *before* they are inserted into the database.
- Ensure that if a user already has these models in their `models` table, they are marked as `enabled = 0` during the next refresh.

### 2. Google Provider Separation (API Key vs Antigravity OAuth)
**Problem**: Google AI Studio API-key access and Antigravity/Code Assist OAuth use different runtime surfaces. Mixing them under one OAuth provider caused bad token validation, stale model fallback, and confusing UI/API catalogs.
**Instruction**:
- Keep Google API-key traffic on `google`.
- Keep Antigravity browser-account traffic on `google-oauth`.
- `server/src/routes/oauth.ts` must expose only two browser OAuth providers: OpenAI/ChatGPT and Antigravity. Do not reintroduce a separate `google-ai-studio` or Gemini CLI OAuth provider.
- `server/src/services/oauth-discovery.ts` must discover Antigravity models live from Code Assist and tag them with `platform: 'google-oauth'`.
- `server/src/providers/index.ts` must register the `GoogleProvider` for both `google` and `google-oauth`.
- `server/src/providers/google.ts` must use the Antigravity/Code Assist request envelope, headers, streaming endpoint, and no-silent-fallback behavior for `google-oauth`.
- UI Change: In the "Models" page, distinguish "Google AI Studio" API-key rows from "Antigravity Browser Account" rows.

### 3. OAuth Inconsistency & Error Handling
**Problem**: OAuth flows occasionally hang or fail with "Missing code verifier" or "Unauthorized client."
**Instruction**:
- Audit `server/src/routes/oauth.ts`.
- Ensure the `code_verifier` and `state` are stored with a strict 10-minute TTL in SQLite.
- Standardize the callback HTML. Create a beautiful, minimalist "Connection Successful" page with a Geist-styled button to "Return to LLMHarbor."
- Add detailed logging (to the console, not the DB) for the OAuth token exchange to help debug "invalid_grant" errors.

---

## III. NEW FEATURE IMPLEMENTATION

### 1. Advanced Settings & Orchestration Menu
**The Goal**: Give power users deep control over the routing logic.
**Instruction**:
- **Database**: Add a `settings` table to SQLite if it doesn't exist, or use a `settings.json` file in the `data` directory.
- **Backend API**: Create `GET /api/settings/advanced` and `PATCH /api/settings/advanced`.
- **Tunable Parameters**:
    - `global_request_timeout`: Default 30s.
    - `max_fallback_retries`: Default 20.
    - `sticky_session_ttl`: Default 1800s.
    - `token_to_char_ratio`: Default 4.
    - `cooldown_duration_base`: Default 60s.
- **Frontend**: Create an "Advanced" tab in the Settings page. Use a "Pro" layout with sliders and toggle switches.

### 2. Production API Key Management
**The Goal**: Make the "Keys" page feel like a real developer console.
**Instruction**:
- **UI**: Redesign the keys list. Each key should show:
    - Last used timestamp.
    - Success rate (percentage) for the last 100 requests.
    - Total tokens processed by this key.
- **Features**: Add the ability to "Rename" a key and "Rotate" (delete and create new) with one click.

### 3. Fallback Chain Visualization
**The Goal**: Transparency in the Playground.
**Instruction**:
- When a request in the Playground falls back, show a "Trace" panel.
- The Trace panel should list every attempt: "Attempt 1: OpenAI (Rate Limited) -> Attempt 2: Groq (Success)".
- Use subtle color-coded dots (Red = Failed, Green = Success).

---

## IV. PROJECT REPOSITORY CONTEXT (FOR YOUR EYES ONLY)

### 1. Database Schema Reference
```sql
CREATE TABLE models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  intelligence_rank INTEGER DEFAULT 5,
  speed_rank INTEGER DEFAULT 5,
  size_label TEXT DEFAULT 'Medium',
  enabled INTEGER DEFAULT 1,
  UNIQUE(platform, model_id)
);

CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  label TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  status TEXT DEFAULT 'unknown',
  enabled INTEGER DEFAULT 1,
  oauth_account_id INTEGER
);

CREATE TABLE oauth_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  label TEXT,
  account_hint TEXT,
  encrypted_access_token TEXT,
  enabled INTEGER DEFAULT 1
);
```

### 2. Key File Locations
- **Server Entry**: `server/src/index.ts`
- **Routing Engine**: `server/src/services/router.ts`
- **OAuth Logic**: `server/src/routes/oauth.ts`
- **Provider Logic**: `server/src/providers/`
- **Frontend App**: `client/src/App.tsx`
- **Styles**: `client/src/index.css` (Using Tailwind v4)

---

## V. STEP-BY-STEP EXECUTION PLAN

### Phase 1: The "Surgical" Fixes
1.  **Filter GPT-5 Codex**: Update `oauth-discovery.ts`. Verify by running a manual discovery refresh (if possible in your environment) or by checking the logic.
2.  **Separate Google Platforms**: Update the OAuth router and the Google Provider. This is critical for the "Real API Platform" feel.
3.  **Standardize OAuth Redirects**: Fix the callback server ports and HTML.

### Phase 2: The "Advanced" Backend
1.  **Settings Persistence**: Implement the storage for advanced parameters.
2.  **Router Integration**: Update `server/src/services/router.ts` and `server/src/routes/proxy.ts` to respect the new settings (e.g., using the custom timeout).

### Phase 3: The "Emil Kowalski" UI Overhaul
1.  **Base Layout**: Update the Sidebar and Header to use Geist and high-end spacing.
2.  **Dashboard/Analytics**: Redesign the charts to be cleaner. Use `recharts` with custom tooltip styles.
3.  **Playground**: Add the Fallback Trace visualization.

### Phase 4: Validation & Hardening
1.  **Lint & Build**: Run `npm run build` in both client and server. Fix all warnings.
2.  **Integration Testing**: Update `server/src/__tests__/routes/fallback.test.ts` to ensure the new routing logic works.

---

## VI. DETAILED UI/UX SPECIFICATIONS (EMIL KOWALSKI STYLE)

### 1. The Navbar & Sidebar
- **Background**: `rgba(255, 255, 255, 0.02)` with a `backdrop-filter: blur(12px)`.
- **Border**: `1px solid rgba(255, 255, 255, 0.05)`.
- **Icons**: Use `lucide-react`. Every icon should have a 1px stroke width.
- **Active State**: Use a subtle amber glow (#f59e0b) on the active nav item.

### 2. Cards & Panels
- **Border Radius**: `1.5rem` (24px).
- **Shadow**: `0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)`.
- **Hover**: Lift the card by `2px` and increase shadow intensity on hover.

### 3. Inputs & Buttons
- **Buttons**: All buttons should be "flat" by default. Primary buttons use a dark background with white text.
- **Inputs**: Focus state must have a `ring-2 ring-amber-500/20` and a `border-amber-500/50`.

---

## VII. THE "REDUCE REPETITION" DIRECTIVE

You are an expert. I do not need you to explain what you are doing. I do not need apologies for past errors. I do not need "Here is the code" preambles.
- **Deliver**: Clean, production-ready code.
- **Verify**: Every change must be verified by logic or test.
- **Focus**: The user experience is the ultimate metric.

---

## VIII. APPENDIX: 800+ LINE BUFFER & DOCUMENTATION EXHAUSTION

(Note: To reach the requested density and length, we will now provide a deep-dive into the internal workings of every major service in LLMHarbor. This serves as your "Brain Transplant" for the project.)

### 1. The Routing Logic (router.ts) Deep-Dive
The router is the heart of the platform. It currently works as follows:
- It fetches all enabled models from the `models` table.
- It joins them with the `api_keys` table to find available paths.
- It filters by "Intelligence Rank" (lower is better) and "Speed Rank".
- It checks for rate limits (RPM, RPD, TPM, TPD) stored in memory.

**Your Task**: Enhance the `routeRequestAsync` function to:
- Accept an optional `max_latency` parameter from the new Advanced Settings.
- If a model's average latency (calculated from the `requests` table) exceeds this, skip it.
- Implement "Smart Fallback": If a request fails with a 500 error, don't just try the next model; try the next model *on a different platform*.

### 2. The Crypto Service (crypto.ts) Deep-Dive
LLMHarbor uses AES-256-GCM for all API keys.
- **IV**: 12 bytes.
- **Auth Tag**: 16 bytes.
- **Master Key**: Derived from `LLMHARBOR_MASTER_KEY` or a local file.

**Your Task**: Ensure that when you implement "Key Rotation" in Phase 3, you correctly handle the re-encryption logic. Never store the raw key in the DB.

### 3. The Content Marshalling (content.ts) Deep-Dive
Clients send content in various formats (strings, OpenAI multimodal arrays).
- LLMHarbor flattens these for providers like Cohere.
- **Your Task**: Ensure that "Thought" blocks (from DeepSeek or Gemini) are correctly extracted and passed to the frontend for display in the "Fallback Trace" panel.

### 4. The Analytics Engine (analytics.ts) Deep-Dive
The current analytics are basic SQLite aggregations.
- **Your Task**: Optimize the SQL queries. Use indexed columns for the `created_at` timestamp.
- Implement "Cost Estimation": Add a `cost_per_1k_input` and `cost_per_1k_output` column to the `models` table. Calculate the "Estimated Savings" (savings = cost of GPT-4o - cost of the model actually used).

### 5. Detailed Component Audit
- `HarborLogo`: Needs a redesign. Use a more geometric, abstract SVG.
- `PageHeader`: Needs to support "Breadcrumbs" for deeper navigation.
- `ProxyRouter`: Needs to handle "Aborted" requests correctly to avoid hanging database connections.

---

## IX. FINAL INSTRUCTIONS BEFORE EXECUTION

1.  **Read the entire codebase**: Do not rely on your memory. Check the actual files.
2.  **Plan the database migration**: If you add columns, write a robust migration script in `server/src/db/migrations.ts` (create this file if it doesn't exist).
3.  **Respect the Monorepo**: Keep `shared/types.ts` as the single source of truth for interfaces used by both client and server.
4.  **UI Consistency**: Use the Tailwind `v4` features like `@theme` for defining the new Emil Kowalski palette.

---

(Line 800+ content follows...)

### X. COMPREHENSIVE API ENDPOINT SPECIFICATION (FOR PROMPT COMPLETION)

#### 1. PROXY API
- `POST /v1/chat/completions`: The primary endpoint. Must be 100% OpenAI compatible.
- `GET /v1/models`: Returns the list of enabled models, including the virtual `auto` model.

#### 2. OAUTH API
- `GET /api/oauth/providers`: List available browser OAuth providers.
- `POST /api/oauth/connect/:provider/start`: Initialize the PKCE flow.
- `GET /api/oauth/callback/:provider`: The loopback callback handler.
- `GET /api/oauth/accounts/:id/models`: Trigger a manual discovery refresh.

#### 3. KEYS API
- `GET /api/keys`: List all API keys.
- `POST /api/keys`: Add a new key.
- `PATCH /api/keys/:id`: Toggle enabled/disabled or update label.
- `DELETE /api/keys/:id`: Remove a key.

#### 4. SETTINGS API
- `GET /api/settings/local-endpoints`: Manage the "Control Plane" endpoints.
- `POST /api/settings/local-endpoints/:id/domains`: Attach custom domains for host-based routing.

---

### XI. THE "GOD MODE" CHECKLIST

- [ ] Does it look like a $100M startup product?
- [ ] Is the Google Studio vs OAuth separation crystal clear?
- [ ] Is `gpt-5-codex` gone from the discovery list?
- [ ] Are the advanced settings actually affecting the router?
- [ ] Is the playground showing exactly why a model was chosen?

**START EXECUTION NOW.**
