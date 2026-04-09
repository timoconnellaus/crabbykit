## Context

CLAW agents run on Cloudflare Workers + Durable Objects. The vibe-coder capability already establishes the pattern of embedding a live canvas in the agent UI via `custom_event` transport messages (`preview_open`/`preview_close`) and an iframe. The agent-browser project (../agent-browser) provides a battle-tested TypeScript implementation of snapshot-based browser automation over CDP, but is designed as a local daemon over Unix sockets with Playwright as the automation layer.

Browserbase provides managed headless Chromium instances via REST API + CDP WebSocket. A DO can hold outbound WebSocket connections, making CDP-from-DO viable.

## Goals / Non-Goals

**Goals:**
- Provide agents with browser automation tools (navigate, click, type, screenshot, snapshot)
- Show a live browser canvas in the agent UI (same pattern as vibe-coder preview)
- Persist browser identity (cookies, localStorage) across browser open/close cycles within an agent
- Support parallel browser sessions across chat sessions with cookie merge
- Track Browserbase costs via `context.emitCost()`
- Work entirely within Workers/DO constraints (no Node.js, no Playwright, no local processes)

**Non-Goals:**
- Full Playwright API parity — we provide a focused tool set for AI agent interaction, not a general automation framework
- Tab management — v1 is single-tab
- Extension support — skip for v1
- Browser recording/tracing/HAR capture — skip for v1
- Input streaming / bidirectional interaction from UI → browser (user watches, agent drives)
- Action policy/confirmation system (agent-browser feature) — not needed since the LLM agent is the sole operator

## Decisions

### 1. CDP client over WebSocket from Durable Object (not REST-only)

Browserbase has no REST API for page interaction — all navigation, clicking, screenshots, and cookie extraction require CDP. We build a thin CDP client (JSON-RPC over WebSocket) that runs inside the DO.

**Alternative considered:** Proxy CDP through a Cloudflare Container running Node.js + Playwright. Rejected because it adds a hop, a dependency on Containers, and Playwright's install size (~400MB) is excessive for what amounts to a WebSocket relay.

**Alternative considered:** Use Browserbase's SDK (`@browserbasehq/sdk`). Rejected because it depends on `node-fetch` and is designed for Node.js. The REST API is simple enough for a custom client.

### 2. Accessibility tree snapshots via CDP `Accessibility.getFullAXTree` (not Playwright's ariaSnapshot)

Agent-browser's snapshot engine uses Playwright's `locator.ariaSnapshot()` which we can't call from Workers. CDP's `Accessibility.getFullAXTree` returns the same underlying data. We build a tree formatter that produces the same ref-annotated output format.

For ref→element resolution, we use `DOM.describeNode` + `DOM.getContentQuads` to map accessibility node IDs back to screen coordinates for click/type actions.

**Alternative considered:** Inject JavaScript that walks the DOM's accessibility API (`element.computedRole`, `element.computedName`). This works but is less reliable than CDP's native AX tree and misses ARIA attributes from shadow DOM.

### 3. Hybrid state management: Browserbase Contexts + self-managed cookie merge

- **Single session (common case):** Use Browserbase's Context API (`browserSettings.context.id` with `persist: true`). BB automatically persists all browser state (cookies, localStorage, IndexedDB) on session close. Also extract cookies ourselves and store in KV as a readable copy.
- **Parallel sessions (detected at open time):** Second+ session creates a BB session WITHOUT context persistence. On close, extracts cookies via CDP `Network.getCookies` and merges into the shared KV cookie jar.
- **State restore:** On `browser_open`, load cookies from KV and inject via `Network.setCookies`. For localStorage, inject via `Runtime.evaluate` per origin.

Cookie merge key: `(domain, path, name)`. Newer expiry wins. New cookies are added. Expired cookies are pruned.

**Why not always use BB Contexts?** Two sessions with the same context and `persist: true` creates a last-writer-wins race. The losing session's state is silently overwritten.

**Why not always self-manage?** BB Contexts capture more than cookies — IndexedDB, ServiceWorker cache, extension state. For single-session use, BB Context is strictly better.

### 4. Agent-scoped shared cookie jar (not session-scoped)

The browser identity belongs to the agent, not to individual chat sessions. Login to GitHub in one chat session is available in all subsequent sessions. This matches user expectation: "the agent knows my credentials."

Storage key: `browser:state` in capability KV storage (shared across all sessions within the agent's DO).

### 5. Live view via Browserbase's `debuggerFullscreenUrl` in an iframe

`GET /v1/sessions/{id}/debug` returns `debuggerFullscreenUrl` — a tokenized URL for their live browser viewer. We embed this directly in an iframe, same pattern as vibe-coder's preview. The token is short-lived but that's fine — we fetch a fresh URL each time we broadcast `browser_open`.

### 6. Ref-based element interaction (not coordinate-based)

Following agent-browser's proven pattern: the snapshot assigns refs (e1, e2, ...) to interactive elements. Tools like `browser_click(ref)` resolve the ref to a DOM node ID, get its bounding box via CDP, and dispatch input events at the center. This is far more reliable than coordinate guessing and gives the LLM structured context about what it can interact with.

### 7. Package structure mirrors existing capabilities

```
packages/browserbase/
  src/
    capability.ts           — Capability factory (browserbase())
    types.ts                — BrowserbaseOptions, BrowserState, CDPTypes
    browserbase-client.ts   — REST client for Browserbase API
    cdp-client.ts           — CDP over WebSocket (Workers-compatible)
    session-manager.ts      — Lifecycle, state save/restore, context arbitration
    snapshot.ts             — AX tree → ref'd text format
    cookie-merge.ts         — Merge logic for parallel sessions
    tools/
      browser-open.ts
      browser-navigate.ts
      browser-snapshot.ts
      browser-screenshot.ts
      browser-click.ts
      browser-type.ts
      browser-close.ts
    index.ts
  test/
  package.json
```

UI additions in `packages/agent-ui`:
- `src/components/browser-panel.tsx` — iframe embed component
- `src/hooks/use-browser.ts` — state management for browser canvas

## Risks / Trade-offs

**DO hibernation kills CDP WebSocket** → Mitigation: DO stays active while a browser session is open (tools are being called). If the DO hibernates with an active session, we detect the dead socket on next tool call and transparently reconnect (or create a new BB session and restore state from KV).

**CDP API surface is large and underspecified** → Mitigation: We only use a small, well-documented subset: `Page.navigate`, `Input.dispatch*`, `Page.captureScreenshot`, `Accessibility.getFullAXTree`, `Network.getCookies/setCookies`, `Runtime.evaluate`, `DOM.describeNode`, `DOM.getContentQuads`. These are stable Chrome APIs unlikely to break.

**Browserbase service dependency** → Mitigation: The capability is optional — agents without `BROWSERBASE_API_KEY` simply don't register it. The CDP client and snapshot engine are generic and could work with any CDP endpoint, making it possible to swap providers later.

**Cookie merge can't detect explicit logouts** → Mitigation: For v1, provide a `browser_clear_state(domain?)` tool for explicit credential removal. Implicit logout detection (cookie removed by server) would require tracking the full cookie set at session start and diffing — deferred to v2.

**Accessibility tree quality varies by site** → Mitigation: Include `browser_screenshot` as a fallback for visual context. Vision-capable models can use screenshots; text-only models rely on the AX tree. The snapshot engine includes cursor-interactive element detection (ported from agent-browser) to catch elements with `cursor:pointer` that lack proper ARIA roles.
