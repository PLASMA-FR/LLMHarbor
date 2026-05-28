# Gemini CLI master prompt: redesign and humanize LLMHarbor

Paste this into Gemini CLI from the repo root:

```text
You are redesigning an existing production app. Work in this repository only.

Project: LLMHarbor
Path: /home/ahmad/Documents/LLMHarbor
Stack: Node/Express server, React 19, Vite 8, Tailwind v4, TanStack Query, shadcn/base-ui style components, TypeScript workspaces.
Product: self-hosted OpenAI-compatible LLM router and local control plane. It manages provider keys, custom OpenAI-compatible endpoints, model registry, probes, fallback routing, analytics, and a playground.
Brand: LLMHarbor. Use the anchor/harbor identity. Keep it grounded, tactile, local, trustworthy. It should feel like a serious command center for people routing real model traffic, not a generic AI SaaS dashboard.

Primary goal
Fully redesign and humanize the frontend into a polished, production-grade command center while preserving all existing functionality, routes, API contracts, and tests.

Important user taste constraints
- Avoid AI-looking UI.
- Prefer flat solid surfaces, subtle borders, softer palettes, tactile details, strong visual hierarchy.
- Avoid glassy/neon/corporate tropes.
- Avoid purple/blue AI gradients.
- No gradient text.
- No generic three-card grids.
- No decorative side-stripe borders.
- No fake dashboards made of meaningless divs.
- No no-gradient dogma either. Use restrained texture, grain, radial depth, and OKLCH tokens where it helps, but keep the result mature.
- Use natural product copy. Avoid "seamless", "elevate", "unleash", "next-gen", "revolutionary", "powerful", "robust" unless truly specific.
- No em dashes in visible copy. Use periods, commas, colons, semicolons, or normal hyphens.

Use these design skills as binding guidance

1. Impeccable product UI standard
- This is product UI, not a landing page. Design serves the work.
- Start by auditing current screens before editing.
- Choose a physical scene: a developer/operator checking model routing on a desktop monitor, likely in a focused workspace, needing confidence and speed.
- Pick a theme intentionally. Do not default to dark just because it is a developer tool. If dual-mode remains, both modes must feel first-class.
- Use OKLCH or semantic CSS variables for color tokens. Never pure #000 or #fff.
- Use a restrained color strategy: tinted neutrals plus one harbor accent, with semantic status colors only where they carry state.
- Vary spacing for rhythm. Avoid same padding everywhere.
- Use cards only when containment matters. Prefer panels, rows, tables, grouped surfaces, dividers, and whitespace where better.
- Motion must communicate state, hierarchy, or feedback. Use transform and opacity only. Honor reduced motion.
- Every interactive control needs hover, active, disabled, and focus-visible states.
- Empty, loading, and error states must be designed, not afterthoughts.

2. Taste skill anti-slop rules
- Declare a design read and dials in your notes before implementing:
  Reading this as: self-hosted developer control plane for technical users, with a tactile harbor command-center language, leaning toward Tailwind v4 + existing component primitives + restrained motion.
  DESIGN_VARIANCE: 5
  MOTION_INTENSITY: 4
  VISUAL_DENSITY: 6
- Product UI exception: this is a dashboard/control plane, so do not force marketing-page rules like huge hero imagery. Apply the anti-slop rules to app shell, IA, forms, tables, empty states, and copy.
- Navigation must stay one line on desktop and usable on mobile.
- Keep one accent system. Do not introduce random colors per page.
- Maintain one radius system with clear rules, for example: app shell 24px, panels 20px, inputs/buttons 14-16px, tiny badges 8-10px.
- Use tabular numbers for metrics, latency, model counts, and timestamps.
- Avoid excessive uppercase micro-labels. If you use eyebrows, use them sparingly.
- Do not add decorative dots unless they represent real status.
- Do not add fake precision. Use real counts from data or clear labels.
- No scroll cues, no version labels, no fake build strings, no poetic locale/time/weather strips.

3. Redesign existing project protocol
- Scan first. Identify framework, style system, pages, component primitives, tokens, and current IA.
- Diagnose current weak points before editing. Write a short audit in your working notes.
- Fix targeted areas. Do not rewrite the whole app from scratch.
- Preserve existing routes:
  /playground
  /keys
  /models
  /fallback
  /analytics
- Preserve backend API behavior. Do not change request or response shapes unless a test requires it and you update tests deliberately.
- Do not push to git or modify remotes.
- Keep changes reviewable.

4. Humanizer copy rules
- Rewrite visible UI copy so it sounds like a real tool made by real people.
- Prefer plain, specific sentences.
- Remove AI phrases, marketing filler, and over-explaining.
- Good examples:
  "Paste a provider key. LLMHarbor stores it locally."
  "Probe before routing traffic."
  "No models registered for this endpoint yet."
  "This key has not been checked."
  "The provider rejected the request. Check the key or try another model."
- Bad examples:
  "Elevate your AI workflows with seamless model orchestration."
  "Unlock next-generation routing capabilities."
  "Harness the power of intelligent fallback chains."
- Every page title, description, button, empty state, error, helper text, and tooltip should pass a human read-aloud test.

Current app surfaces to redesign

1. App shell and navigation
- Make LLMHarbor feel like a cohesive command center.
- Keep anchor logo and wordmark, but refine spacing and active nav treatment if needed.
- Navbar pages: Playground, Keys, Models, Fallback, Analytics.
- Make active state clear without loud decoration.
- Header should feel stable and useful, not generic SaaS.

2. Playground page
- Make it feel like a safe request bench for trying OpenAI-compatible calls.
- Improve prompt/model controls, response display, latency/status metadata, error states, and fallback-attempt visibility.
- Keep functionality intact.

3. Keys page
- Focus this page on credentials and custom providers.
- Unified API key should be clear and safe.
- Custom provider section must persist on Keys page.
- Provider key form should be easy to scan.
- Configured providers list needs clear health, enabled state, key labels, and actions.

4. Models page
- This is now a separate navbar page.
- It should manage endpoint model registries and model probes.
- Do not add a context input. When adding models, omit contextWindow so providers use their defaults.
- Make the endpoint list and selected endpoint details easier to scan.
- Model rows should show display name, model ID, route state, and probe/remove actions.
- Probe result should read clearly with latency/sample/error.

5. Fallback page
- Make routing order obvious.
- Drag/reorder affordances should feel tactile.
- Enabled/disabled state and priority should be unmistakable.
- Preserve dnd behavior.

6. Analytics page
- Make metrics credible and calm.
- Use tabular numerals, clear grouping, and restrained data visuals.
- Avoid fake drama and overdesigned chart chrome.

7. Shared components and tokens
- Improve PageHeader, buttons, selects, switches, panels, status labels, form groups, empty states, and focus rings where needed.
- Keep existing component API unless changes are small and propagated safely.
- Prefer semantic classes and CSS variables in client/src/index.css.
- Use existing dependencies unless package.json shows a dependency is already available. Before adding any new dependency, justify it and verify it is necessary.

Implementation rules
- First inspect these files:
  package.json
  client/package.json
  client/src/App.tsx
  client/src/index.css
  client/src/components/page-header.tsx
  client/src/components/harbor-logo.tsx
  client/src/components/ui/button.tsx
  client/src/components/ui/select.tsx
  client/src/components/ui/switch.tsx
  client/src/pages/PlaygroundPage.tsx
  client/src/pages/KeysPage.tsx
  client/src/pages/ModelsPage.tsx
  client/src/pages/FallbackPage.tsx
  client/src/pages/AnalyticsPage.tsx
- Then produce a short implementation plan in your own notes.
- Edit files directly.
- Do not remove working features.
- Do not invent new APIs if current APIs already support the UI.
- Do not commit unless explicitly asked.
- Do not push.

Accessibility and quality gates
- Keyboard navigation must remain usable.
- Every interactive element must have visible focus.
- Button text must pass contrast in both themes.
- Form labels must not rely on placeholders.
- Meaningful images/icons need accessible names or should be hidden when decorative.
- Respect prefers-reduced-motion.
- Responsive layouts must work at mobile, tablet, and desktop widths.
- No horizontal overflow.

Verification commands
Run these before finishing:

npm test
npm run build

Then run the app and visually sanity-check in browser if possible:

npm run dev

Check at least:
- /playground
- /keys
- /models
- /fallback
- /analytics

Use browser devtools or console if available. Fix any runtime errors.

Final response format
Return a concise summary with:
1. What changed by area.
2. Files changed.
3. Verification results.
4. Any known limitations or follow-up suggestions.

Final pre-flight checklist before you stop
- No visible em dashes.
- No AI-purple gradient aesthetic.
- No gradient text.
- No generic SaaS copy.
- No decorative status dots without semantic meaning.
- No context input on Models page.
- Custom providers remain on Keys page.
- Models page remains separate in navbar.
- Existing functionality still works.
- npm test passes.
- npm run build passes.
```

Optional Gemini CLI command pattern:

```bash
gemini -p "$(cat GEMINI_REDESIGN_MASTER_PROMPT.md)"
```

If your Gemini CLI expects interactive mode instead, run `gemini` from `/home/ahmad/Documents/LLMHarbor`, then paste the fenced master prompt above.
