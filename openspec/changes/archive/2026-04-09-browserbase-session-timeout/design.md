## Context

The browserbase capability (`packages/browserbase`) provides browser automation via Browserbase's cloud browser service. Sessions are opened with `browser_open` and closed with `browser_close`, but there is no automatic cleanup if close is never called. Browserbase charges per minute of session time.

The sandbox capability (`packages/sandbox`) solves the same problem using `context.schedules.setTimer()` — DO-alarm-backed timers that survive hibernation. It resets an idle timer on each tool call and auto-de-elevates when it fires.

## Goals / Non-Goals

**Goals:**
- Prevent runaway Browserbase session costs via automatic session closure
- Recover orphaned sessions after DO restarts
- Show countdown in UI so users know when auto-close will happen
- Follow the sandbox capability's timer pattern for consistency

**Non-Goals:**
- Extending Browserbase session duration from the client (BB controls server-side limits)
- Pausing/resuming sessions to save cost during inactivity
- Per-tool-call cost tracking (only emitted on close, matching current behavior)

## Decisions

### 1. Dual timer model (idle + max duration)

Use two independent timers per session. The idle timer resets on every `browser_*` tool call. The max duration timer is set once at open and never resets. Whichever fires first triggers auto-close.

**Rationale**: Idle-only risks long sessions where the agent keeps poking. Max-only risks closing during active work. The combination provides both a cost ceiling and responsive cleanup.

**Alternatives considered**:
- Idle only (sandbox model) — rejected because browser sessions have continuous per-minute cost unlike sandbox which is free while idle
- Max only — rejected because it would waste money on abandoned sessions that could be closed sooner

### 2. Use `context.schedules.setTimer()` for timers

Timer IDs: `browserbase:idle:{sessionId}` and `browserbase:max:{sessionId}`.

**Rationale**: DO alarms survive hibernation. If the DO sleeps and wakes, the timers still fire. This is critical for cost protection — an in-memory `setTimeout` would be lost on hibernation.

### 3. Orphan recovery via KV scan on capability init

The capability's `schedules()` method already runs on init. Add a check: scan `browser:active:*` KV entries. If entries exist but no CDP client is in the in-memory `cdpClients` Map, the DO restarted. Release those sessions via the Browserbase API, emit cost for elapsed duration, and clean up KV.

**Rationale**: Timers handle the normal case, but if the DO crashed hard or the alarm was lost, KV entries are the last line of defense. This is best-effort — we can't recover the exact minute count, so we estimate from `startedAt`.

### 4. Auto-close callback injects a system message

When the timer fires, the callback closes the session and injects a message into the agent context: "Browser session auto-closed after N minutes of inactivity / max duration reached."

**Rationale**: The agent needs to know the browser is gone so it doesn't try to use `browser_snapshot` etc. on a dead session. Matches sandbox's `DEACTIVATION_NOTICE` pattern.

### 5. Broadcast `browser_timeout` for UI countdown

Shape: `{ expiresAt: number, timeoutSeconds: number }` — same as `sandbox_timeout`. Broadcast on open and on each idle timer reset. The UI renders a countdown in the browser panel toolbar.

**Rationale**: Users watching the live view should know when the session will auto-close. Exact same event shape as sandbox for UI consistency.

## Risks / Trade-offs

- **Idle timer resets on any `browser_*` tool call** — even `browser_snapshot` which is read-only. This means a snapshot-polling loop could keep a session alive indefinitely. → Mitigation: the max duration timer provides an absolute ceiling.
- **Orphan recovery is best-effort** — if the Browserbase API is unreachable during recovery, we can't release the session. → Mitigation: log/silent-catch; BB's own server-side timeout is the ultimate fallback.
- **Timer granularity** — DO alarms have ~second precision, which is fine for minute-scale timeouts.
