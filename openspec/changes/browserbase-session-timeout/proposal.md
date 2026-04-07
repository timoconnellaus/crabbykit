## Why

Browserbase sessions cost money per minute ($0.12/hr default). The browserbase capability has no timeout mechanism — if the agent forgets to call `browser_close`, the user navigates away, or the DO restarts, the Browserbase session runs until their server-side limit kicks in. There's no cost ceiling and no cleanup of orphaned sessions.

## What Changes

- Add dual-timer idle timeout (reset on each `browser_*` tool call) and max duration (set once at open) to the browserbase capability
- Auto-close the browser session when either timer fires: save cookies, release BB session, emit cost, broadcast `browser_close`, inject system message
- Add orphan recovery on capability init — detect `browser:active:*` KV entries without a live CDP connection and release those sessions
- Broadcast `browser_timeout` events to the UI so the toolbar can show a countdown timer
- Add `idleTimeout` and `maxDuration` config options to `BrowserbaseOptions`

## Capabilities

### New Capabilities

- `session-timeout`: Idle + max-duration timer management, auto-close logic, orphan recovery, and UI timeout broadcast for browserbase sessions

### Modified Capabilities

_None — the existing browserbase capability surface (tools, config) is extended, not changed at the spec level._

## Impact

- **`packages/browserbase`**: `session-manager.ts` (timer reset/cancel), `capability.ts` (schedules, orphan recovery, config plumbing), `types.ts` (new options), `tools/browser-open.ts` (set timers), all `browser_*` tools (reset idle timer)
- **`packages/agent-ui`**: `browser-panel.tsx` (countdown display), `use-browser.ts` (handle `browser_timeout` event)
- **No breaking changes** — new config options are optional with sensible defaults
