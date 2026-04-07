## 1. Config & Types

- [x] 1.1 Add `idleTimeout` and `maxDuration` optional fields to `BrowserbaseOptions` in `types.ts` with JSDoc defaults (300s and 1800s)
- [x] 1.2 Add default constants `DEFAULT_IDLE_TIMEOUT = 300` and `DEFAULT_MAX_DURATION = 1800` in capability.ts
- [x] 1.3 Thread resolved config values through capability → SessionManager constructor

## 2. Timer Management

- [x] 2.1 Create `timer.ts` with `resetIdleTimer(sessionId, context, timeoutSeconds)`, `setMaxTimer(sessionId, context, timeoutSeconds)`, `cancelTimers(sessionId, context)` using `context.schedules.setTimer()` / `cancelTimer()`
- [x] 2.2 Wire timer callbacks via runtime `setTimer()` calls (per-session dynamic IDs don't fit static `schedules()` declarations; orphan recovery handles hibernation gap)
- [x] 2.3 Timer callbacks call auto-close logic: `sessionManager.close()`, `context.emitCost()`, `context.broadcast("browser_close")`, broadcast `browser_timeout` with reason

## 3. Tool Integration

- [x] 3.1 In `browser_open` tool: call `setMaxTimer()` and `resetIdleTimer()` after successful open via `onOpen` callback
- [x] 3.2 In `browser_close` tool: call `cancelTimers()` to stop both timers via `onClose` callback
- [x] 3.3 In all other `browser_*` tools (`navigate`, `snapshot`, `screenshot`, `click`, `type`): call `resetIdleTimer()` via `onActivity` callback

## 4. Orphan Recovery

- [x] 4.1 Add `recoverOrphans()` method to SessionManager — scans `browser:active:*` KV, checks in-memory CDP map, releases orphaned sessions via Browserbase API
- [x] 4.2 Call `recoverOrphans()` from capability init (fire-and-forget in `tools()`)
- [x] 4.3 Orphan recovery emits cost for elapsed duration since `startedAt`, cleans up KV

## 5. UI

- [x] 5.1 Handle `browser_timeout` event in `use-browser.ts` — store `expiresAt` and `timeoutReason` in `BrowserState`
- [x] 5.2 Render timeout overlay in `browser-panel.tsx` and countdown in `BrowserBadge` (status bar)

## 6. Tests

- [x] 6.1 Unit tests for `timer.ts` — reset, set, cancel behavior
- [x] 6.2 Tests for auto-close callback — onOpen/onClose callbacks verified in tools.test.ts
- [x] 6.3 Tests for idle timer reset on tool calls — onActivity callbacks for navigate, snapshot, screenshot
- [x] 6.4 Tests for orphan recovery — KV entry without CDP client triggers release, API failure handled gracefully
- [x] 6.5 Tests for UI — browser_timeout event updates state (expiresAt, timeoutReason), panel renders timeout overlay
