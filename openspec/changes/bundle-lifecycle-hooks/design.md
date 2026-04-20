## Context

Bundle brain reached functional parity with static brain across four axes (tools, prompt sections, alarm/session/client-event lifecycle, mode awareness) in `bundle-runtime-surface`, then added HTTP routes + UI bridge actions in `bundle-http-and-ui-surface`, then config namespaces in `bundle-config-namespaces`, then mode authoring in `bundle-modes`. The remaining capability-author-facing parity gap is **terminal turn observation + connection lifecycle + cleanup**: `Capability.afterTurn`, `Capability.hooks.onConnect`, `Capability.dispose`, plus the AgentDO setup-level `onTurnEnd` / `onAgentEnd`.

`channel-telegram` is the canonical motivating consumer — its "send the assistant's final reply back to the chat" step lives in `afterTurn`. Without bundle-side `afterTurn`, channels cannot ship as bundles. Audit/cost-reporting/Sentry-integration capabilities hit the same wall.

Substrate state at the time of this proposal:
- `BundleMetadata.lifecycleHooks` exists (bundle-runtime-surface phase 2) and gates dispatch by hook flag.
- `composeWorkerLoaderConfig` (`bundle-host/src/loader-config.ts`) is the intended single dispatch envelope helper, but `BundleDispatcher.dispatchClientEvent` (`dispatcher.ts:340-381`) currently hand-rolls the loader config inline. **This proposal lands a prerequisite refactor** of `dispatchClientEvent` to use the helper, then has the five new dispatch sites reuse it.
- Architecture rule: `runtime/agent-runtime` cannot import from `runtime/bundle-host` (CLAUDE.md "Workspace layout"). Existing pattern: `agent-runtime` declares optional callback fields (`bundleClientEventHandler`, `bundleAlarmHandler`, `bundleSessionCreatedHandler` at `agent-runtime.ts:448-472`); the CF shell in `agent-do.ts` populates them with closures that have access to `BundleDispatcher` state and `composeWorkerLoaderConfig` (`agent-do.ts:1886-1917`). This proposal extends that pattern with five new callback fields.
- Static substrate to extend:
  - `dispatchAfterTurn` at `agent-runtime.ts:3064-3117` (already runs inside `runtimeContext.waitUntil` registered at `3046-3048`, with the promise added to `pendingAsyncOps`).
  - `fireOnConnectHooks` at `agent-runtime.ts:2814` invoked at four call sites (1629, 1638, 1817, 1843), each `.catch(...)` non-awaited.
  - `disposeCapabilities` at `agent-runtime.ts:2802-2811` invoked at two call sites (1722 last-WS-close, 2658 agent_end), each non-awaited; static disposes are kicked off with `.catch(...)` attached but NOT awaited.
  - Static `onTurnEnd` / `onAgentEnd` delegate calls at `agent-runtime.ts:2985` / `3001` are kicked off with `.catch(...)` attached but NOT awaited.
- `extractFinalAssistantText` from `agent-runtime-helpers.ts` is the existing helper — bundle dispatch should reuse it.
- `BundleConfig` lives at `packages/runtime/agent-runtime/src/bundle-config.ts` (NOT `bundle-host/src/bundle-config.ts`, which is the dispatcher state file).
- `BudgetCategory` (`bundle-host/src/budget-tracker.ts:51-59`) is a closed string-literal union keyed on operation TYPE (`sql`, `kv`, `broadcast`, `inspection`, `hook_after_tool`, etc.) — NOT caller endpoint. Adding per-endpoint categories would require widening the union, the `SpineBudgetConfig` interface, the `DEFAULT_BUDGET` defaults, and the `getLimit` switch. Plus a phaseTag would have to be plumbed through `__BUNDLE_TOKEN` payload to derive an effective category. **Decision: drop the per-endpoint budget concept** — existing `sql`/`broadcast`/etc. caps already bound runaway lifecycle handlers via the same mechanism that bounds runaway turn-loop handlers.
- `BundleHookContext` (bundle-sdk types.ts:746) extends `BundleContext` and carries `hookBridge` — explicitly excluded from `BundleSpineClientLifecycle` (types.ts:294-296) per Decision 8 of bundle-runtime-surface (turn-loop concept; firing `recordToolExecution` outside a turn would generate phantom events). **Decision: define five fresh context types** rather than reuse `BundleHookContext` and re-introduce the leak.
- `mintToken` (`bundle-host/src/token.ts`) currently requires `sessionId: string`. **Decision: extend payload to `sid: string | null`** plus add `requireSession(caller)` helper at the top of every session-scoped spine method that throws `ERR_SESSION_REQUIRED` (new code in the `SpineErrorCode` union).
- `event.toolResults` (passed to static `onTurnEnd` at `agent-runtime.ts:2985`) is whatever pi-agent-core emits — may contain functions, class instances, stream readers. **Decision: project to `BundleToolResult[]`** host-side via a new `projectToolResultsForBundle` helper before forwarding through the isolate boundary.

This proposal extends those substrates without changing their shape, plus the prerequisite cleanup of `dispatchClientEvent`.

## Goals / Non-Goals

**Goals:**

- Five new lifecycle hook surfaces — three per-capability (`afterTurn`, `hooks.onConnect`, `dispose`) and two setup-level (`onTurnEnd`, `onAgentEnd`) — wired through host→bundle dispatch over the established envelope.
- Dispatch gated on `BundleMetadata.lifecycleHooks` flag — zero overhead for legacy bundles or bundles that didn't declare the hook.
- Per-capability error isolation — one bad handler doesn't block siblings, doesn't propagate, doesn't reverse persistence/broadcast.
- Per-handler timeout (`BundleConfig.lifecycleHookTimeoutMs`, default 5 000 ms) bounds stalls.
- Static walks first inside `dispatchAfterTurn` for `afterTurn`. For `dispose` / `onConnect` / `onTurnEnd` / `onAgentEnd`, static is KICKED OFF first; bundle dispatch runs concurrently. Documented invariant per endpoint.
- `dispose` is connectionless — fires once per capability instance, not per session. Token mint extension supports `sid: null`; spine guards throw `ERR_SESSION_REQUIRED`.
- Reuses `composeWorkerLoaderConfig` (after prerequisite cleanup of `dispatchClientEvent`), the `[BundleDispatch]` telemetry prefix, and the existing per-type spine budget tracker. Five fresh context types replace temptation to leak `BundleHookContext`'s `hookBridge` into non-turn dispatches.
- Layering invariant preserved: `agent-runtime.ts` does NOT import `bundle-host`. Five new optional callback fields on `AgentRuntimeOptions` mirror the existing `bundleClientEventHandler` shape; the CF shell in `agent-do.ts` populates them.

**Non-Goals:**

- Bundle declaring its own `validateAuth`. Auth happens before any dispatch — bundles cannot intercept it without compromising the auth boundary.
- `channel-telegram` (or any specific channel) port to a bundle.
- `beforeToolExecution` / `afterToolExecution` / `beforeInference` parity. Already covered by bundle-runtime-surface.
- `onScheduleFire` parity. Already covered by `setup.onAlarm`.
- Session-scoped `dispose`. Static contract is per-instance; bundle parity matches.
- Streaming or back-pressure on lifecycle dispatches. Each is fire-and-await; failures are logged.
- Retry on dispatch failure. Lifecycle hooks are observation-only.
- Per-endpoint spine budget categories. Existing per-type budgets suffice.
- Mode-filter integration with build-time aggregation. Honest known cost.
- Bundle authors writing the `lifecycleHooks` metadata field directly. The flag set is derived at build time by `defineBundleAgent` — bundle authors only declare the hooks themselves.

## Decisions

### Decision 1: Five separate endpoints, not one `/lifecycle-event` discriminator

Each lifecycle hook gets its own bundle endpoint (`/after-turn`, `/on-connect`, `/dispose`, `/on-turn-end`, `/on-agent-end`) rather than a single `/lifecycle-event` with a `kind` discriminator. Matches the established pattern from bundle-runtime-surface (`/alarm`, `/session-created`, `/client-event`). Per-endpoint dispatch keeps the bundle SDK switch flat and lets the metadata flag check skip the loader fetch entirely without parsing a dispatch envelope.

**Alternative considered:** single `/lifecycle-event` endpoint with `{kind: "after-turn" | ...}`. Rejected — would require eager bundle isolate instantiation for every lifecycle event regardless of declared hook, defeating the per-flag skip optimization.

### Decision 2: Dispatch logic lives in `agent-do.ts` callback wiring, not in `agent-runtime.ts`

`agent-runtime.ts` is platform-agnostic with zero `cloudflare:workers` imports and zero `bundle-host` imports (architecture rule). It declares five new optional callback fields on `AgentRuntimeOptions`:
- `bundleAfterTurnHandler?: (sessionId, finalText, capabilitiesSnapshot) => Promise<void>`
- `bundleOnConnectHandler?: (sessionId) => Promise<void>`
- `bundleDisposeHandler?: () => Promise<void>`
- `bundleOnTurnEndHandler?: (sessionId, messages, toolResults) => Promise<void>`
- `bundleOnAgentEndHandler?: (messages) => Promise<void>`

Each callback is invoked from inside the existing static walks (`dispatchAfterTurn`, `fireOnConnectHooks`, `disposeCapabilities`, `handleAgentEvent`) AFTER the static work is complete or kicked off. The callbacks themselves are populated in `agent-do.ts` (extending the existing `1886-1917` block), where `BundleDispatcher.getActiveLifecycleFlags()`, `composeWorkerLoaderConfig`, and the timeout knob are all in scope.

**Why this matters:** the previous draft incorrectly placed dispatch logic directly in `agent-runtime.ts`, which would have introduced a forbidden `runtime/agent-runtime` → `runtime/bundle-host` value edge. The callback indirection preserves the layering rule. Same pattern as `bundleClientEventHandler` already in production.

### Decision 3: Static-walk-completes-FIRST applies inside `dispatchAfterTurn` only; for other endpoints, static is KICKED OFF first

For `afterTurn`: `dispatchAfterTurn` is `async` and registered with `runtimeContext.waitUntil`. The bundle dispatch can be `await`ed inside the function body AFTER the static `for (const cap of hooks)` loop completes. The existing `waitUntil`-tracked promise covers both static and bundle execution.

For `onConnect`, `dispose`, `onTurnEnd`, `onAgentEnd`: the static walk / delegate is a fire-and-forget invocation at the call site. The bundle dispatch is queued as a SEPARATE `runtimeContext.waitUntil(...)` registration AND added to `pendingAsyncOps`. The "ordering" claim is qualified: static is kicked off first; bundle dispatch is queued second. They run concurrently from the caller's perspective.

For `onConnect` specifically: the bundle `/on-connect` dispatch is queued INSIDE `fireOnConnectHooks` AFTER the per-cap `await hook(ctx)` loop completes. Within the function, ordering holds: static walk completes (per-cap awaits) → bundle dispatch queued. But the function is non-awaited at its four call sites, so callers don't observe either chain completing.

**Trade-off:** matches static behavior — siblings race today. Pre-existing concurrency pattern, not introduced here. Documented honestly so bundle authors don't expect strict post-static ordering on dispose/onTurnEnd/onAgentEnd.

### Decision 4: `dispose` carries no `sessionId`, requires token-shape extension

Static `Capability.dispose` is per-capability-instance, NOT per-session. Bundle parity matches: `/dispose` envelope carries `{agentId}` only.

`mintToken` currently requires `sessionId: string`. **Extend payload** to `sid: string | null`. Add `requireSession(caller: SpineCaller)` helper that throws `ERR_SESSION_REQUIRED` when `caller.sid === null`. Every session-scoped spine method (`spineAppendEntry`, `spineGetEntries`, `spineBuildContext`, `spineBroadcast`, etc.) calls `requireSession(caller)` at method entry as the first line. Non-session-scoped spine methods (none today) bypass the guard.

`ERR_SESSION_REQUIRED` is added to the `SpineErrorCode` union in `bundle-token`. Spine error sanitization in `SpineService.sanitize` propagates the code unchanged.

**Alternative considered:** sentinel `sid: "__DISPOSE__"`. Rejected — sentinel strings hide intent and require every spine method to remember to check the magic value. `null` + a typed guard helper is loud at the type level.

### Decision 5: `dispose` dispatch lifetime via `waitUntil` + `pendingAsyncOps`

Static `disposeCapabilities` is invoked non-awaited from `handleTransportClose` (1722) and `handleAgentEvent` end branch (2658). For the websocket-close path the DO is still alive and may receive new connections. For the agent_end path the DO may be near hibernation.

The bundle `/dispose` dispatch SHALL register its promise with `runtimeContext.waitUntil(...)` AND add it to `pendingAsyncOps`. This mirrors the `dispatchAfterTurn` pattern (`agent-runtime.ts:3046-3048`). The DO does not become eligible for hibernation until the bundle dispatch resolves.

**Trade-off:** increases the DO's outstanding work window by up to `lifecycleHookTimeoutMs` (5 000 ms default). For bundles with `dispose: undefined`, no overhead — the dispatch is skipped at the flag check.

### Decision 6: `afterTurn` runs INSIDE `dispatchAfterTurn`'s existing `waitUntil` registration

`dispatchAfterTurn` is already `async` and registered with `runtimeContext.waitUntil(...)`. Inside its body, after the static `for (const cap of hooks)` loop, await the bundle handler:

```ts
private async dispatchAfterTurn(sessionId: string, messages: AgentMessage[]): Promise<void> {
  const capabilities = this.capabilitiesCache ?? this.getCachedCapabilities();
  const hooks = capabilities.filter((c) => typeof c.afterTurn === "function");
  const finalText = extractFinalAssistantText(messages);
  for (const cap of hooks) {
    // ... existing static walk ...
  }
  // NEW:
  if (this.bundleAfterTurnHandler) {
    try {
      await this.bundleAfterTurnHandler(sessionId, finalText, capabilities);
    } catch (err) {
      // log + onError, never rethrow
    }
  }
}
```

The existing `dispatchPromise` registered with `waitUntil` covers both. No new `waitUntil` registration needed.

### Decision 7: Reserved-id concerns — none

These hooks don't introduce identifiers — they extend behavior on existing capability declarations. `lifecycleHooks` field shape is internal metadata bundle authors don't write directly. No collision validators required.

The `BundleMetadata.lifecycleHooks` flag set is derived at build time by `defineBundleAgent` from `setup.capabilities(probeEnv)` and `setup.{onTurnEnd,onAgentEnd}` field presence. Bundle authors who try to write it directly are silently overwritten by the build-time aggregator.

### Decision 8: New context types, NOT extensions of `BundleHookContext`

`BundleHookContext` carries `hookBridge` — a turn-loop concept that would generate phantom `recordToolExecution` events if invoked outside a turn. Reusing it for `/after-turn` / `/on-connect` / `/dispose` / `/on-turn-end` / `/on-agent-end` would re-introduce exactly the leak `BundleSpineClientLifecycle` was created to close (Decision 8 of bundle-runtime-surface).

Five new types defined in `bundle-sdk/src/types.ts`:
- `BundleAfterTurnContext { agentId, sessionId, capabilityId, kvStore, channel, spine: BundleSpineClientLifecycle, publicUrl, emitCost, agentConfig? }`
- `BundleOnConnectContext { agentId, sessionId, capabilityId, kvStore, channel, spine, publicUrl, emitCost, agentConfig? }`
- `BundleDisposeContext { agentId, capabilityId, kvStore, spine, publicUrl }` — NO sessionId, NO channel, NO emitCost (no session to attribute to), NO agentConfig (per-instance not per-snapshot)
- `BundleTurnEndContext { agentId, sessionId, spine, publicUrl }`
- `BundleAgentEndContext { agentId, spine, publicUrl }` — NO sessionId

None extend `BundleHookContext`. None carry `hookBridge`.

**Documented v1 parity gaps:** static `AgentContext` carries `schedules`, `rateLimit`, `requestFromClient`, `broadcastToAll`, `notifyBundlePointerChanged`. The new bundle-side contexts do NOT expose these. Mirrors the `BundleHttpContext` / `BundleActionContext` precedent of being honest about cross-isolate parity gaps.

### Decision 9: Drop per-endpoint spine budget categories

Initial draft proposed `lifecycle_after_turn` / `lifecycle_on_connect` / etc. as new `BudgetCategory` values. Implementing this requires widening the closed string-literal union, extending `SpineBudgetConfig`, extending `DEFAULT_BUDGET`, extending `getLimit` switch, AND plumbing a `phaseTag` through `__BUNDLE_TOKEN` payload (since spine methods choose category by operation type, not caller endpoint).

**Decision: drop the per-endpoint budget concept entirely.** A bundle's `afterTurn` calling `spine.appendEntry` flows through the existing `sql` budget; calling `channel.broadcast` flows through `broadcast`. The existing per-turn caps already bound runaway lifecycle handlers via the same mechanism that bounds runaway turn-loop handlers. No new mechanism required.

**Trade-off:** if a bundle's `dispose` legitimately needs to make many `kv.put` calls to flush state, it shares the same `kv` budget as the turn loop. Acceptable — `dispose` should be near-instant, and the failure mode (budget exceeded) is loud (`ERR_BUDGET_EXCEEDED` thrown to the bundle handler).

### Decision 10: Per-handler timeout via `BundleConfig.lifecycleHookTimeoutMs` (5 000 ms default)

Each lifecycle dispatch is wrapped in `Promise.race([fetchBundle, timeout])`. Timeout default 5 000 ms — same as `configHookTimeoutMs`.

Lives in `packages/runtime/agent-runtime/src/bundle-config.ts` (where `BundleConfig` is defined; the file `bundle-host/src/bundle-config.ts` is the dispatcher state file with `consecutiveFailures` and is unrelated).

Timeout-on-expire is logged with `outcome: "timeout"` and the host event proceeds. Worker Loader fetch is not cancelled (Workers runtime constraint).

### Decision 11: Failures don't increment `consecutiveFailures`

Bundle dispatch failures normally count toward `consecutiveFailures`, triggering auto-revert at `maxLoadFailures` (default 3). Lifecycle hook failures are EXEMPT — they're observation-only paths. A bundle whose `afterTurn` throws on every turn would auto-disable on turn 3, hiding the underlying handler bug behind a bundle-disabled state.

**Trade-off:** a malicious bundle could throw from `dispose` to leak resources without being auto-disabled. Acceptable — `dispose` failures are logged with `outcome: "error"` and the host's resource cleanup proceeds independently (host always tears down storage / WebSocket state regardless of bundle handler success).

### Decision 12: Build-time flag detection via `setup.capabilities(probeEnv)`

`defineBundleAgent` already walks `setup.capabilities(probeEnv)` once at build time to populate `surfaces.httpRoutes` and `surfaces.actionCapabilityIds`. Extended to also detect per-capability `afterTurn`, `hooks.onConnect`, `dispose` declarations and aggregate them into `lifecycleHooks.{afterTurn, onConnect, dispose}` boolean flags.

`lifecycleHooks.onTurnEnd` / `onAgentEnd` come from a simpler check — `typeof setup.onTurnEnd === "function"` / `typeof setup.onAgentEnd === "function"`.

**Mode-filter caveat:** the build-time walk does NOT account for the dispatch-time mode filter (Decision 14 of bundle-runtime-surface — bundle-side filtering happens INSIDE the isolate). A bundle whose only `afterTurn`-bearing capability is filtered out by the active mode still incurs the dispatch cost; the bundle SDK iterates and finds nothing to invoke. Documented honest cost. The "zero overhead" claim applies to bundles that didn't declare the hook AT BUILD TIME.

### Decision 13: `composeWorkerLoaderConfig` becomes the single source of truth (prerequisite refactor)

`BundleDispatcher.dispatchClientEvent` (`bundle-host/src/dispatcher.ts:340-381`) currently hand-rolls the loader config inline (compatibilityDate, compatibilityFlags, mainModule, etc.). **This proposal lands a prerequisite cleanup** refactoring `dispatchClientEvent` to call `composeWorkerLoaderConfig` instead. After the cleanup, the helper is the single source of truth for all loader configs (turn, alarm, session-created, client-event, http, action, after-turn, on-connect, dispose, on-turn-end, on-agent-end, config-change, agent-config-change, config-namespace-get, config-namespace-set).

A code-comment in `loader-config.ts` lists every dispatch endpoint so future contributors see the full set.

### Decision 14: `event.toolResults` projected to `BundleToolResult[]` host-side before forwarding

Static `onTurnEnd(messages, toolResults)` receives `event.toolResults` from `handleAgentEvent`. The shape is whatever pi-agent-core emits and may contain functions, class instances, or stream readers — none of which survive the structured-clone boundary into the bundle isolate.

**Decision: project host-side via a new `projectToolResultsForBundle(toolResults: unknown[]): BundleToolResult[]` helper** in `bundle-host/src/serialization.ts`. Each entry is reduced to `{toolName: string, args: unknown, content: string, isError: boolean}` based on the existing `agent-core` event shape. Non-projectable entries are logged with `[BundleDispatch] kind: "lifecycle_on_turn_end" outcome: "tool_result_projection_failed"` and replaced with a sentinel `{toolName: "unknown", args: null, content: "<projection failed>", isError: true}` rather than silently dropped wholesale (which would mask shape drift).

Bundle SDK exports `BundleToolResult` type so authors can type their `setup.onTurnEnd(messages, toolResults: BundleToolResult[])`.

## Risks / Trade-offs

- **[Risk]** Bundle `afterTurn` calls `channel.broadcast` and clients see two "final" messages → Mitigation: documented in the bundle authoring guide that `afterTurn` runs AFTER `agent_end` broadcast; bundle authors needing pre-broadcast modification should use `beforeInference` or interpose at the static turn loop.
- **[Risk]** Bundle `dispose` is slow and times out → Mitigation: 5 000 ms timeout caps the wait; `outcome: "timeout"` log surfaces the issue; host cleanup proceeds independently.
- **[Risk]** A bundle-authored `onConnect` always throws, producing high error log volume → Mitigation: structured `[BundleDispatch] kind: "lifecycle_on_connect" outcome: "error"` log includes `bundleVersionId`; non-counting toward `consecutiveFailures` keeps the bundle live for non-affected paths.
- **[Risk]** Bundle author confused that `dispose` carries no `sessionId` → Mitigation: TypeScript signature reflects `BundleDisposeContext` without `sessionId`; inline JSDoc explains the per-instance vs per-session distinction; the type is fresh (not extending `BundleHookContext`) so it can't leak the wrong context shape.
- **[Risk]** Bundle author tries to call session-scoped spine method from `dispose` → Mitigation: `requireSession(caller)` guard at every session-scoped spine method throws `ERR_SESSION_REQUIRED` immediately; the error code is added to `SpineErrorCode` union and surfaces as a typed error to the bundle handler.
- **[Risk]** Static `dispatchAfterTurn` extension adds cross-isolate fetch cost to every `agent_end` → Mitigation: dispatch-time flag check skips the loader fetch when the bundle didn't declare `afterTurn`. Cost is paid only when the bundle opted in. Measured target: <50ms p95 dispatch latency for empty per-cap chains.
- **[Risk]** Mode filter rules out the only `afterTurn`-declaring capability but flag stays true → wasted dispatch → Mitigation: documented as known cost. Future optimization could thread active mode into build-time aggregation, but the dispatch is cheap enough to defer.
- **[Risk]** `event.toolResults` shape drifts in pi-agent-core, bundle `setup.onTurnEnd` receives sentinel-projected entries → Mitigation: per-entry projection failure logs `outcome: "tool_result_projection_failed"` so the drift is visible; sentinel entries don't silently drop; bundle authors get a typed `BundleToolResult` to code against.
- **[Trade-off]** Static and bundle `afterTurn` chains run independently — a static cap throwing doesn't block bundle, vice versa. Matches the per-cap error isolation contract within each chain.
- **[Trade-off]** No `consecutiveFailures` counting means a broken `afterTurn` runs forever instead of triggering auto-revert. Acceptable because lifecycle hooks are observation-only; broken `afterTurn` doesn't affect turn correctness or users.
- **[Trade-off]** `dispose` is queued via `waitUntil`+`pendingAsyncOps`, extending the DO's outstanding-work window by up to `lifecycleHookTimeoutMs`. Acceptable because zero overhead when bundle doesn't declare `dispose`.
- **[Trade-off]** `mintToken` payload extension to `sid: string | null` is a structural change to a security-critical primitive. Mitigated by: typed `requireSession` helper (loud at the type level), explicit `null` (not a sentinel string), every session-scoped spine method calls the guard at method entry as the first line.
- **[Trade-off]** `composeWorkerLoaderConfig` refactor of `dispatchClientEvent` is in-scope of this proposal but increases blast radius. Mitigated by: existing tests for `dispatchClientEvent` should pass unchanged; shared helper improves correctness over time. Standalone follow-up cleanup would defer the helper-as-single-source-of-truth claim, leaving the proposal less honest about its enforcement story.

## Migration Plan

Greenfield — no migration required for bundle authors. Bundles published before this change have `lifecycleHooks` set without the new flags (or `lifecycleHooks: undefined` entirely); the host treats absent flags as `false` and skips dispatch.

`mintToken` payload extension is an internal-only change. No external consumers mint tokens. The verify path in `bundle-token` accepts both shapes (`sessionId` legacy + `sid` new) for one release cycle to avoid forcing simultaneous deploy of host + bundle SDK; subsequent cleanup removes the legacy field.

`SpineErrorCode` extension is additive — existing consumers don't break.

`projectToolResultsForBundle` is host-side only; no bundle-side migration.

No spec deltas. Pure ADDED capability spec.

## Open Questions

- Should `BundleConfig.lifecycleHookTimeoutMs` be replaced by a finer-grained per-endpoint config (`lifecycleAfterTurnTimeoutMs`, etc.)? Initial answer: NO — single knob matches the `configHookTimeoutMs` precedent and keeps the surface small. Re-visit if we find e.g. `dispose` legitimately needs longer than `afterTurn`.
- Should `dispose` dispatch be triggered on the websocket-close path AT ALL? Static `disposeCapabilities` fires there for parity with agent_end, but a bundle whose `dispose` re-initializes external connections may misbehave when a single client disconnect triggers dispose. Initial answer: YES — match static behavior; bundle authors writing `dispose` are responsible for understanding when it fires (documented in CLAUDE.md).
