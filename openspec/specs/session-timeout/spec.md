# session-timeout Specification

## Purpose
TBD - created by archiving change browserbase-session-timeout. Update Purpose after archive.
## Requirements
### Requirement: Idle timeout auto-closes browser session
The system SHALL automatically close a browser session when no `browser_*` tool is called within the configured idle timeout period. The idle timer SHALL reset to its full duration each time any `browser_*` tool is invoked for that session.

#### Scenario: Session auto-closes after idle period
- **WHEN** a browser session is open and no `browser_*` tool is called for `idleTimeout` seconds (default 300)
- **THEN** the system closes the session (saves cookies, releases Browserbase session, emits cost, broadcasts `browser_close`)

#### Scenario: Idle timer resets on tool use
- **WHEN** a browser session is open and `browser_snapshot` is called
- **THEN** the idle timer resets to the full `idleTimeout` duration

#### Scenario: Explicit close cancels idle timer
- **WHEN** the user or agent calls `browser_close`
- **THEN** the idle timer is cancelled and does not fire

### Requirement: Max duration auto-closes browser session
The system SHALL automatically close a browser session when the total session duration exceeds the configured max duration, regardless of activity.

#### Scenario: Session auto-closes at max duration
- **WHEN** a browser session has been open for `maxDuration` seconds (default 1800)
- **THEN** the system closes the session even if the agent is actively using it

#### Scenario: Max timer is set once and never resets
- **WHEN** a browser session is open and `browser_navigate` is called
- **THEN** the max duration timer is NOT reset — it retains its original expiry

#### Scenario: Explicit close cancels max timer
- **WHEN** the user or agent calls `browser_close`
- **THEN** the max duration timer is cancelled

### Requirement: Auto-close emits cost and system message
When a timer fires and auto-closes a session, the system SHALL emit cost for the session duration and inject a system message into the agent context.

#### Scenario: Auto-close on idle timeout
- **WHEN** the idle timer fires and closes the session
- **THEN** cost is emitted for the elapsed minutes AND a system message is injected: "Browser session auto-closed after inactivity"

#### Scenario: Auto-close on max duration
- **WHEN** the max duration timer fires and closes the session
- **THEN** cost is emitted for the elapsed minutes AND a system message is injected: "Browser session auto-closed — max duration reached"

### Requirement: Orphan recovery on capability init
The system SHALL detect and release orphaned Browserbase sessions on capability initialization. An orphaned session is one tracked in KV (`browser:active:*`) but with no live CDP connection in memory.

#### Scenario: DO restarts with active session in KV
- **WHEN** the capability initializes and finds a `browser:active:{sessionId}` KV entry but no corresponding in-memory CDP client
- **THEN** the system calls `releaseSession` on the Browserbase API, emits cost for the elapsed duration since `startedAt`, cleans up the KV entry, and broadcasts `browser_close`

#### Scenario: Browserbase API unreachable during recovery
- **WHEN** orphan recovery attempts to release a session but the API call fails
- **THEN** the system silently catches the error, cleans up the KV entry, and relies on Browserbase's server-side timeout

### Requirement: UI countdown broadcast
The system SHALL broadcast `browser_timeout` events so the UI can display a countdown timer showing when the session will auto-close.

#### Scenario: Broadcast on session open
- **WHEN** `browser_open` completes successfully
- **THEN** the system broadcasts `browser_timeout` with `{ expiresAt, timeoutSeconds }` reflecting the idle timeout

#### Scenario: Broadcast on idle timer reset
- **WHEN** a `browser_*` tool call resets the idle timer
- **THEN** the system broadcasts an updated `browser_timeout` with the new `expiresAt`

### Requirement: Configurable timeout values
The `BrowserbaseOptions` interface SHALL accept optional `idleTimeout` and `maxDuration` fields.

#### Scenario: Custom idle timeout
- **WHEN** `browserbase({ idleTimeout: 120, ... })` is configured
- **THEN** the idle timer uses 120 seconds instead of the default 300

#### Scenario: Custom max duration
- **WHEN** `browserbase({ maxDuration: 3600, ... })` is configured
- **THEN** the max duration timer uses 3600 seconds instead of the default 1800

#### Scenario: Defaults when not specified
- **WHEN** `idleTimeout` and `maxDuration` are omitted from options
- **THEN** the system uses 300 seconds for idle timeout and 1800 seconds for max duration

