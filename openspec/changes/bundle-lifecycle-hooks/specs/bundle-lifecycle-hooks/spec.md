## ADDED Requirements

### Requirement: Bundle capabilities SHALL declare per-capability `afterTurn` matching static `Capability.afterTurn`

`BundleCapability` SHALL accept an optional top-level `afterTurn?: (ctx: BundleAfterTurnContext, sessionId: string, finalText: string) => Promise<void>`. The signature SHALL match the static `Capability.afterTurn` parameter order and the `finalText` semantics (concatenated final assistant message text via the existing `extractFinalAssistantText` helper, empty string when the turn terminated without assistant text).

The host SHALL extend `dispatchAfterTurn` (`agent-runtime.ts:3064-3117`) to invoke the optional callback `bundleAfterTurnHandler(sessionId, finalText, capabilitiesSnapshot)` AFTER the static `for (const cap of hooks)` loop completes. Both static and bundle execution SHALL be tracked by the existing `dispatchPromise` registered with `runtimeContext.waitUntil` and added to `pendingAsyncOps`.

The bundle SDK SHALL iterate `setup.capabilities(env)` in registration order and invoke each declared `afterTurn` sequentially. Per-capability errors SHALL be caught and logged with `[BundleDispatch] kind: "lifecycle_after_turn" outcome: "error"`; one failing handler SHALL NOT block sibling handlers.

#### Scenario: Bundle declares afterTurn → host dispatches after static loop

- **WHEN** a bundle's capability declares `afterTurn` and the agent completes a turn
- **THEN** the static per-cap `afterTurn` walk inside `dispatchAfterTurn` completes first
- **AND** the host invokes `bundleAfterTurnHandler(sessionId, finalText, capabilities)`
- **AND** the handler dispatches `POST /after-turn` to the bundle isolate with `{agentId, sessionId, finalText}`
- **AND** the bundle SDK invokes each declaring capability's `afterTurn(ctx, sessionId, finalText)` exactly once
- **AND** the existing `pendingAsyncOps` registration covers both static and bundle execution

#### Scenario: Bundle does NOT declare afterTurn → callback skips dispatch entirely

- **WHEN** a bundle's `lifecycleHooks.afterTurn` flag is `false` or absent
- **THEN** the `bundleAfterTurnHandler` callback in `agent-do.ts` reads `BundleDispatcher.getActiveLifecycleFlags()`
- **AND** sees `afterTurn: false` (or undefined)
- **AND** does NOT call `composeWorkerLoaderConfig`
- **AND** no Worker Loader fetch is issued for that turn's after-turn dispatch

#### Scenario: One bundle capability's afterTurn throws → siblings still fire

- **WHEN** capability A's `afterTurn` throws and capability B's `afterTurn` is also declared
- **THEN** the bundle SDK catches A's error
- **AND** logs `[BundleDispatch] kind: "lifecycle_after_turn" outcome: "error"` with `capabilityId: "A"`
- **AND** capability B's `afterTurn` runs to completion

### Requirement: Bundle capabilities SHALL declare `hooks.onConnect` matching static `Capability.hooks.onConnect`

`BundleCapabilityHooks` SHALL accept an optional `onConnect?: (ctx: BundleOnConnectContext) => Promise<void>`. The host SHALL extend `fireOnConnectHooks` (`agent-runtime.ts:2814`) to invoke the optional `bundleOnConnectHandler(sessionId)` callback AFTER the per-cap `await hook(ctx)` loop completes within the same function. The bundle dispatch promise SHALL be queued via `runtimeContext.waitUntil(...)` AND added to `pendingAsyncOps`.

`fireOnConnectHooks` is invoked at four call sites: initial connect (`agent-runtime.ts:1629`), hibernation-restore (`1638`), session-switch (`1817`), new-session (`1843`). Each call site already invokes `fireOnConnectHooks(...).catch(...)` non-awaited; the bundle dispatch inherits this fire-and-forget shape from each call site.

The bundle SDK SHALL iterate `setup.capabilities(env)` in registration order and invoke each declared `hooks.onConnect` handler sequentially. Per-capability errors SHALL be caught and logged; one failing handler SHALL NOT block sibling handlers OR block the WebSocket connection.

#### Scenario: Client connects → bundle onConnect dispatched after static walk

- **WHEN** a WebSocket client connects to a session and a bundle capability declares `hooks.onConnect`
- **THEN** the static `fireOnConnectHooks` per-cap walk completes (each `await hook(ctx)` returns)
- **AND** the host invokes `bundleOnConnectHandler(sessionId)`
- **AND** the handler dispatches `POST /on-connect` to the bundle isolate with `{agentId, sessionId}`
- **AND** the bundle SDK invokes each declaring capability's `hooks.onConnect(ctx)` exactly once

#### Scenario: Hibernation restore triggers onConnect dispatch

- **WHEN** a hibernated DO is restored and a WebSocket connection is re-attached at `agent-runtime.ts:1638`
- **THEN** the static `fireOnConnectHooks(connection.getSessionId())` runs
- **AND** the bundle `/on-connect` dispatch is queued for the restored session

#### Scenario: Bundle does NOT declare onConnect → callback skips dispatch

- **WHEN** a bundle's `lifecycleHooks.onConnect` flag is `false` or absent
- **THEN** the `bundleOnConnectHandler` callback short-circuits before calling `composeWorkerLoaderConfig`

### Requirement: Bundle capabilities SHALL declare `dispose` matching static `Capability.dispose`

`BundleCapability` SHALL accept an optional top-level `dispose?: () => Promise<void>`. The host SHALL extend `disposeCapabilities` (`agent-runtime.ts:2802-2811`) to invoke the optional `bundleDisposeHandler()` callback AFTER the static `for (const { capabilityId, dispose } of this.capabilityDisposers)` loop kicks off. The bundle dispatch promise SHALL be queued via `runtimeContext.waitUntil(...)` AND added to `pendingAsyncOps`.

The dispatch envelope SHALL carry `{agentId}` only — NO `sessionId`. `disposeCapabilities` is per-DO not per-session. Static disposes are kicked off non-awaited (each call has `.catch(...)` attached); the bundle dispatch runs concurrently with in-flight static disposes.

The bundle SDK SHALL iterate `setup.capabilities(env)` in registration order and invoke each declared `dispose()` sequentially. Per-capability errors SHALL be caught and logged; one failing handler SHALL NOT block sibling handlers. Errors SHALL NOT propagate to the host's cleanup loop.

#### Scenario: Agent ends → bundle dispose fires once per declaring capability

- **WHEN** the host invokes `disposeCapabilities` and a bundle has two capabilities declaring `dispose`
- **THEN** the static `dispose()` calls are kicked off (non-awaited, each with `.catch(...)`)
- **AND** the host queues `bundleDisposeHandler()` via `runtimeContext.waitUntil(...)`
- **AND** the host adds the resulting promise to `pendingAsyncOps`
- **AND** the dispatcher posts `/dispose` to the bundle isolate with `{agentId}` (no `sessionId`)
- **AND** the bundle SDK invokes both capabilities' `dispose()` handlers sequentially in registration order

#### Scenario: Bundle dispose handler throws → host cleanup proceeds

- **WHEN** a bundle's `dispose` handler throws an error
- **THEN** the bundle SDK catches the error and logs `[BundleDispatch] kind: "lifecycle_dispose" outcome: "error"` with the capability id
- **AND** subsequent capability `dispose` handlers still run
- **AND** the host's outer cleanup loop is unaffected (it already returned)

#### Scenario: Bundle does NOT declare dispose → callback skips dispatch

- **WHEN** a bundle's `lifecycleHooks.dispose` flag is `false` or absent
- **THEN** the `bundleDisposeHandler` callback short-circuits before calling `composeWorkerLoaderConfig`

### Requirement: Bundles SHALL declare setup-level `onTurnEnd` matching static `AgentDelegate.onTurnEnd`

`BundleAgentSetup` SHALL accept an optional `onTurnEnd?: (messages: AgentMessage[], toolResults: BundleToolResult[]) => void | Promise<void>`. The host SHALL extend `handleAgentEvent` (`agent-runtime.ts:2983-2998`) to invoke `bundleOnTurnEndHandler(sessionId, [event.message], event.toolResults)` AFTER kicking off the static `onTurnEnd?(...)` delegate call. Static and bundle handlers run concurrently from the call site's perspective; both promises SHALL be queued via `runtimeContext.waitUntil(...)`.

`event.toolResults` SHALL be projected via `projectToolResultsForBundle(toolResults)` host-side BEFORE forwarding through the isolate boundary. Each entry is reduced to `{toolName, args, content, isError}`. Non-projectable entries SHALL be replaced with the sentinel `{toolName: "unknown", args: null, content: "<projection failed>", isError: true}` and an `outcome: "tool_result_projection_failed"` log entry SHALL be emitted per entry.

#### Scenario: Both static and bundle onTurnEnd defined → both fire concurrently

- **WHEN** the agent completes a turn and both static `onTurnEnd` and bundle `setup.onTurnEnd` are declared
- **THEN** the static `onTurnEnd?([event.message], event.toolResults)` is kicked off (non-awaited, with `.catch(...)`)
- **AND** the host projects `event.toolResults` via `projectToolResultsForBundle`
- **AND** queues `bundleOnTurnEndHandler(sessionId, [event.message], projectedToolResults)` via `runtimeContext.waitUntil(...)`
- **AND** the bundle SDK invokes `setup.onTurnEnd(messages, toolResults)` exactly once

#### Scenario: Bundle onTurnEnd throws → host turn loop continues

- **WHEN** a bundle's `setup.onTurnEnd` throws an error
- **THEN** the bundle SDK catches the error and logs `[BundleDispatch] kind: "lifecycle_on_turn_end" outcome: "error"`
- **AND** the host turn loop proceeds to the next turn or to `agent_end`

#### Scenario: toolResults entry is non-projectable → sentinel substituted

- **WHEN** an entry in `event.toolResults` contains a function or stream reader
- **THEN** `projectToolResultsForBundle` replaces it with `{toolName: "unknown", args: null, content: "<projection failed>", isError: true}`
- **AND** the host logs `[BundleDispatch] kind: "lifecycle_on_turn_end" outcome: "tool_result_projection_failed"` with the entry index

### Requirement: Bundles SHALL declare setup-level `onAgentEnd` matching static `AgentDelegate.onAgentEnd`

`BundleAgentSetup` SHALL accept an optional `onAgentEnd?: (messages: AgentMessage[]) => void | Promise<void>`. The host SHALL extend `handleAgentEvent` (`agent-runtime.ts:2999-3013`) to invoke `bundleOnAgentEndHandler(event.messages)` AFTER kicking off the static `onAgentEnd?(...)` delegate call. The bundle dispatch promise SHALL be queued via `runtimeContext.waitUntil(...)`. Envelope carries `{agentId, messages}` — NO sessionId (agent_end is DO-wide).

#### Scenario: Bundle onAgentEnd fires after static delegate kickoff

- **WHEN** the agent reaches `agent_end` and `setup.onAgentEnd` is declared
- **THEN** the static `onAgentEnd?(event.messages)` is kicked off (non-awaited)
- **AND** the host queues `bundleOnAgentEndHandler(event.messages)` via `runtimeContext.waitUntil(...)`
- **AND** the bundle SDK invokes `setup.onAgentEnd(messages)` exactly once
- **AND** the dispatch envelope omits `sessionId`

#### Scenario: Bundle onAgentEnd throws → cleanup proceeds

- **WHEN** a bundle's `setup.onAgentEnd` throws
- **THEN** the bundle SDK catches and logs `[BundleDispatch] kind: "lifecycle_on_agent_end" outcome: "error"`
- **AND** the DO's outstanding work (other `pendingAsyncOps`) completes

### Requirement: BundleMetadata SHALL declare lifecycle hook flags so the host can skip dispatch for unused hooks

`BundleMetadata.lifecycleHooks` SHALL be extended with five boolean fields: `afterTurn?: boolean`, `onConnect?: boolean`, `dispose?: boolean`, `onTurnEnd?: boolean`, `onAgentEnd?: boolean`. `defineBundleAgent` SHALL populate each flag at build time:

- `afterTurn` SHALL be `true` if ANY capability returned by `setup.capabilities(probeEnv)` declares a top-level `afterTurn` function.
- `onConnect` SHALL be `true` if ANY capability declares `hooks.onConnect`.
- `dispose` SHALL be `true` if ANY capability declares a top-level `dispose` function.
- `onTurnEnd` SHALL be `true` if `typeof setup.onTurnEnd === "function"`.
- `onAgentEnd` SHALL be `true` if `typeof setup.onAgentEnd === "function"`.

`BundleDispatcher` SHALL expose `getActiveLifecycleFlags(): BundleMetadata["lifecycleHooks"] | null` returning the active bundle's flag snapshot (or `null` when no bundle is active). The five callback wirings in `agent-do.ts` SHALL consult this getter BEFORE invoking `composeWorkerLoaderConfig`. When the corresponding flag is `false` or absent, the callback SHALL short-circuit and NOT issue a Worker Loader fetch.

The build-time aggregation does NOT account for the dispatch-time mode filter. A bundle whose only declaring capability is filtered out by the active mode still incurs the dispatch cost (documented honest cost, not a bug).

#### Scenario: Bundle author adds afterTurn → metadata flag is set at build time

- **WHEN** `defineBundleAgent` evaluates a setup whose capability factory returns `[{ id: "x", name: "X", description: "x", afterTurn: async () => {} }]`
- **THEN** the resulting `BundleMetadata.lifecycleHooks.afterTurn === true`

#### Scenario: Legacy bundle without lifecycleHooks fields → callbacks short-circuit

- **WHEN** a bundle published before this change is loaded (no `lifecycleHooks.afterTurn`/`onConnect`/`dispose`/`onTurnEnd`/`onAgentEnd`)
- **THEN** `getActiveLifecycleFlags()` returns the existing object (or `undefined` for absent fields)
- **AND** every callback wiring treats the absent flag as `false`
- **AND** dispatches `/after-turn`, `/on-connect`, `/dispose`, `/on-turn-end`, `/on-agent-end` are all skipped

### Requirement: Each lifecycle dispatch SHALL be bounded by `BundleConfig.lifecycleHookTimeoutMs` (default 5 000 ms)

The callback wirings in `agent-do.ts` SHALL race each dispatch against a timeout sourced from `BundleConfig.lifecycleHookTimeoutMs` (defined in `packages/runtime/agent-runtime/src/bundle-config.ts`). Default SHALL be 5 000 ms. On timeout, the host SHALL log `[BundleDispatch] kind: "<endpoint>" outcome: "timeout"` and the callback SHALL resolve to undefined. The Worker Loader fetch SHALL NOT be cancelled (Workers runtime constraint).

The 30 000 ms `BundleConfig.httpDispatchTimeoutMs` (which bounds `/http` dispatches) SHALL NOT apply.

#### Scenario: Bundle afterTurn handler runs longer than timeout

- **WHEN** a bundle's `afterTurn` takes 7 000 ms to complete and `lifecycleHookTimeoutMs` is the default 5 000 ms
- **THEN** the host abandons the dispatch result after 5 000 ms
- **AND** logs `outcome: "timeout"` with the endpoint and bundle version id
- **AND** subsequent turn handling proceeds without waiting

### Requirement: Lifecycle hook dispatch failures SHALL NOT count toward `consecutiveFailures`

`BundleDispatcher.consecutiveFailures` SHALL NOT increment for any of the five lifecycle hook dispatches (timeout, error, or 5xx response from bundle isolate). `BundleDispatcher.maxLoadFailures` (default 3) SHALL only apply to turn dispatches and other paths whose failure indicates the bundle is unloadable.

This SHALL prevent a buggy lifecycle hook from auto-disabling the bundle.

#### Scenario: Bundle afterTurn throws on every turn → bundle stays active

- **WHEN** a bundle's `afterTurn` throws on each of 10 consecutive turns
- **THEN** `consecutiveFailures` remains at its prior value
- **AND** the bundle pointer is NOT cleared
- **AND** subsequent turn dispatches continue to invoke the bundle brain

### Requirement: New context types SHALL NOT extend `BundleHookContext` and SHALL NOT carry `hookBridge`

Five new context types SHALL be defined in `bundle-sdk/src/types.ts`:

- `BundleAfterTurnContext { agentId, sessionId, capabilityId, kvStore, channel: BundleSessionChannel, spine: BundleSpineClientLifecycle, publicUrl?, emitCost, agentConfig? }`
- `BundleOnConnectContext { agentId, sessionId, capabilityId, kvStore, channel, spine, publicUrl?, emitCost, agentConfig? }`
- `BundleDisposeContext { agentId, capabilityId, kvStore, spine, publicUrl? }` — NO sessionId, NO channel, NO emitCost, NO agentConfig
- `BundleTurnEndContext { agentId, sessionId, spine, publicUrl? }`
- `BundleAgentEndContext { agentId, spine, publicUrl? }` — NO sessionId

None SHALL extend `BundleHookContext`. None SHALL carry `hookBridge`. This SHALL prevent the leak of turn-loop concepts into non-turn dispatches (bundle-runtime-surface Decision 8).

Documented v1 parity gaps relative to static `AgentContext` / `CapabilityHookContext`: the new contexts do NOT expose `schedules`, `rateLimit`, `requestFromClient`, `broadcastToAll`, `notifyBundlePointerChanged`. Bundle authors needing them MUST use alternative paths (documented in CLAUDE.md and the bundle authoring guide).

#### Scenario: Bundle afterTurn writes to capability-scoped KV via ctx.kvStore

- **WHEN** a bundle's `afterTurn` calls `ctx.kvStore.put(capabilityId, "lastTurnText", finalText)`
- **THEN** the value persists under the capability's KV namespace
- **AND** subsequent `kvStore.get(capabilityId, "lastTurnText")` returns the same value

#### Scenario: Bundle dispose attempts to access channel → type error at compile time

- **WHEN** a bundle's `dispose` handler attempts `ctx.channel.broadcast(...)`
- **THEN** TypeScript SHALL reject the call (`channel` is not present on `BundleDisposeContext`)

### Requirement: Token mint SHALL accept `sid: string | null` for session-less dispatch

`mintToken` (`bundle-host/src/token.ts`) SHALL accept a payload with `sid: string | null`. When `sid === null`, the resulting token SHALL be acceptable to `verifyToken` and yield a `SpineCaller` with `caller.sid === null`.

A new `requireSession(caller: SpineCaller): asserts caller is SpineCaller & {sid: string}` helper SHALL throw `ERR_SESSION_REQUIRED` (added to the `SpineErrorCode` union in `bundle-token`) when `caller.sid === null`. Every session-scoped spine method (`spineAppendEntry`, `spineGetEntries`, `spineBuildContext`, `spineBroadcast`, `spineRecordToolExecution`, `spineProcessBeforeInference`, `spineProcessBeforeToolExecution`, `spineRecordBundlePromptSections`, `spineGetBundlePromptSections`, etc.) SHALL call `requireSession(caller)` at method entry as the first line.

Verify-side compatibility: the verify-only token shape (`bundle-token/src/`) SHALL accept the extended payload. For one release cycle the legacy `sessionId: string` field SHALL remain accepted alongside `sid: string | null` to allow non-simultaneous deploy of host + bundle SDK; subsequent cleanup removes the legacy field.

#### Scenario: dispose dispatch mints token with sid: null

- **WHEN** the `bundleDisposeHandler` callback in `agent-do.ts` mints a token for the `/dispose` dispatch
- **THEN** `mintToken({ aid, sid: null, scope: ["spine", ...catalogIds] })` returns a valid token
- **AND** `verifyToken(token)` returns a `SpineCaller` with `sid === null`

#### Scenario: Bundle dispose calls session-scoped spine method → ERR_SESSION_REQUIRED

- **WHEN** a bundle's `dispose` calls `ctx.spine.appendEntry(...)` (which routes through `spineAppendEntry`)
- **THEN** `requireSession(caller)` at the top of `spineAppendEntry` throws `ERR_SESSION_REQUIRED`
- **AND** the bundle SDK surfaces the typed error to the bundle handler

### Requirement: `composeWorkerLoaderConfig` SHALL be the single dispatch envelope helper after prerequisite refactor

`BundleDispatcher.dispatchClientEvent` (`bundle-host/src/dispatcher.ts:340-381`) currently hand-rolls the loader config inline. THIS PROPOSAL SHALL refactor `dispatchClientEvent` to call `composeWorkerLoaderConfig` BEFORE adding the five new dispatch sites. After the refactor, `composeWorkerLoaderConfig` SHALL be the single source of truth for all loader configs across every dispatch path (turn, alarm, session-created, client-event, http, action, after-turn, on-connect, dispose, on-turn-end, on-agent-end, config-change, agent-config-change, config-namespace-get, config-namespace-set).

A code-comment in `bundle-host/src/loader-config.ts` SHALL list every dispatch endpoint so future contributors see the full set in one place.

#### Scenario: Existing client-event dispatch still works after refactor

- **WHEN** the host receives a client_event message and `dispatchClientEvent` is invoked
- **THEN** the loader config built via `composeWorkerLoaderConfig` matches the previously hand-rolled shape
- **AND** the bundle isolate receives the same envelope

#### Scenario: Future addition of lifecycle hook reuses helper

- **WHEN** a future change adds a new lifecycle endpoint
- **THEN** the dispatch site SHALL call `composeWorkerLoaderConfig({path, body, token, ...})` exactly as the existing five do

### Requirement: Dispatch telemetry SHALL use `[BundleDispatch]` prefix with structured `kind` discriminator

Every lifecycle dispatch attempt, success, timeout, and failure SHALL emit a structured log under the `[BundleDispatch]` prefix. The `kind` field SHALL be one of: `lifecycle_after_turn`, `lifecycle_on_connect`, `lifecycle_dispose`, `lifecycle_on_turn_end`, `lifecycle_on_agent_end`. Each entry SHALL carry `agentId`, `sessionId?` (omitted for `dispose` and `on-agent-end`), `bundleVersionId`, and `outcome: "ok" | "timeout" | "error" | "tool_result_projection_failed"`.

#### Scenario: afterTurn dispatch succeeds → structured log emitted

- **WHEN** a bundle's `/after-turn` dispatch returns 204 in 100 ms
- **THEN** the host logs `[BundleDispatch]` with `kind: "lifecycle_after_turn"`, `outcome: "ok"`, `agentId`, `sessionId`, `bundleVersionId`

#### Scenario: dispose dispatch errors → structured log includes error message

- **WHEN** a bundle's `/dispose` dispatch returns 500 with `{error: "boom"}`
- **THEN** the host logs `[BundleDispatch]` with `kind: "lifecycle_dispose"`, `outcome: "error"`, `agentId`, `bundleVersionId`, `error: "boom"`
- **AND** the log entry does NOT include `sessionId`

### Requirement: `event.toolResults` SHALL be projected to `BundleToolResult[]` host-side before crossing the isolate boundary

A new `projectToolResultsForBundle(toolResults: unknown[]): BundleToolResult[]` helper SHALL live in `bundle-host/src/serialization.ts`. Each entry SHALL be reduced to `{toolName: string, args: unknown, content: string, isError: boolean}`. Non-projectable entries (containing functions, class instances, stream readers, or other non-clonable values) SHALL be replaced with `{toolName: "unknown", args: null, content: "<projection failed>", isError: true}` and an `outcome: "tool_result_projection_failed"` log entry SHALL be emitted per entry (with the entry index for debugging).

`BundleToolResult` SHALL be exported from `bundle-sdk/src/types.ts` so authors can type their `setup.onTurnEnd(messages, toolResults: BundleToolResult[])`.

#### Scenario: Two clean tool results → both projected fully

- **WHEN** `event.toolResults` contains `[{toolName: "search", args: {...}, content: "...", isError: false}, {toolName: "fetch", args: {...}, content: "...", isError: false}]`
- **THEN** `projectToolResultsForBundle` returns the same two entries unchanged
- **AND** the bundle's `setup.onTurnEnd` receives a `toolResults` array of length 2 with matching content

#### Scenario: One tool result contains a function reference → sentinel substituted

- **WHEN** `event.toolResults[1]` contains `{toolName: "x", content: () => "lazy"}`
- **THEN** `projectToolResultsForBundle` returns `[entry0, {toolName: "unknown", args: null, content: "<projection failed>", isError: true}]`
- **AND** the host logs `outcome: "tool_result_projection_failed"` with `entryIndex: 1`
