## Why

CLAW agents need browser access for web research, data extraction, form filling, and visual verification. The vibe-coder capability already proves the pattern of embedding a live canvas in the agent UI. Browserbase provides managed headless Chromium instances via API, which maps cleanly to the edge-first Workers architecture (no local processes needed). The agent-browser project provides a battle-tested TypeScript implementation of snapshot-based browser automation that we can port.

## What Changes

- New `packages/browserbase` capability package providing browser automation tools
- Thin CDP (Chrome DevTools Protocol) client that works over WebSocket from a Durable Object — no Playwright dependency
- Accessibility tree snapshot engine (ported from agent-browser) with ref-based element selection for deterministic agent interaction
- Hybrid session state management: Browserbase Contexts for single-session use, self-managed cookie merge for parallel sessions
- Agent-scoped shared cookie jar so logins persist across browser open/close cycles and across chat sessions
- New `BrowserPanel` UI component in agent-ui (mirrors AppPreview pattern) embedding Browserbase's live debug viewer in an iframe
- Cost tracking per browser session based on duration

## Capabilities

### New Capabilities

- `browserbase`: Browser automation capability. Creates/manages Browserbase sessions, provides tools for navigation, snapshot-based interaction, screenshots, and state persistence. Includes CDP client, session manager with cookie merge, and accessibility tree snapshot engine.
- `browser-panel`: UI component for displaying the live browser view. Embeds Browserbase's debug fullscreen URL in an iframe, triggered by `browser_open`/`browser_close` custom events via the existing transport protocol.

### Modified Capabilities

_(none — this is additive)_

## Impact

- **New package**: `packages/browserbase` — runtime capability with tools, CDP client, snapshot engine, session/state management
- **agent-ui changes**: New `BrowserPanel` component + `useBrowser` hook, new custom event handlers in `useAgentChat`
- **Transport**: New custom events `browser_open` and `browser_close` (uses existing `custom_event` mechanism, no protocol changes)
- **Dependencies**: No new npm dependencies in the runtime package (Browserbase API is plain HTTP + WebSocket). Agent-ui gains no new deps (iframe embed).
- **Env bindings**: Consumers must provide `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` environment variables
- **Cost**: Browserbase charges ~$0.002/min. Emitted via `context.emitCost()` on session close.
