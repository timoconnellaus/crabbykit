## 1. Bundle SDK type extensions

- [x] 1.1 Extend `BundleCapability` in `packages/runtime/bundle-sdk/src/types.ts` with optional top-level `afterTurn?: (ctx: BundleAfterTurnContext, sessionId: string, finalText: string) => Promise<void>`. Add JSDoc explaining static-runs-first inside `dispatchAfterTurn` and per-cap error isolation.
- [x] 1.2 Extend `BundleCapability` with optional top-level `dispose?: () => Promise<void>`. Add JSDoc explaining session-less semantics, per-DO not per-session firing, and per-cap error isolation.
- [x] 1.3 Extend `BundleCapabilityHooks` with optional `onConnect?: (ctx: BundleOnConnectContext) => Promise<void>`. Add JSDoc cross-referencing the four host call sites (initial connect, hibernation-restore, session-switch, new-session).
- [x] 1.4 Extend `BundleAgentSetup` with optional `onTurnEnd?: (messages: AgentMessage[], toolResults: BundleToolResult[]) => void | Promise<void>` and `onAgentEnd?: (messages: AgentMessage[]) => void | Promise<void>`. Re-export `AgentMessage` from `@crabbykit/agent-core` via the SDK barrel if not already exported.
- [x] 1.5 Extend `BundleMetadata.lifecycleHooks` with `afterTurn?: boolean`, `onConnect?: boolean`, `dispose?: boolean`, `onTurnEnd?: boolean`, `onAgentEnd?: boolean` flags. Add JSDoc describing build-time aggregation rules and the mode-filter caveat.
- [x] 1.6 Define five fresh context types — `BundleAfterTurnContext`, `BundleOnConnectContext`, `BundleDisposeContext`, `BundleTurnEndContext`, `BundleAgentEndContext`. None SHALL extend `BundleHookContext`. None SHALL carry `hookBridge`. Each carries the slim `BundleSpineClientLifecycle` shape. Document v1 parity gaps (no `schedules`/`rateLimit`/`requestFromClient`/`broadcastToAll`/`notifyBundlePointerChanged`).
- [x] 1.7 Define `BundleToolResult { toolName: string; args: unknown; content: string; isError: boolean }` and export from the SDK barrel.
- [x] 1.8 Extend `BundleExport` interface comments listing the five new endpoints (`/after-turn`, `/on-connect`, `/dispose`, `/on-turn-end`, `/on-agent-end`).

## 2. Bundle SDK runtime — fetch handler endpoints

- [x] 2.1 In `packages/runtime/bundle-sdk/src/define.ts`, extend the fetch handler switch with a `POST /after-turn` case. Parse `{agentId, sessionId, finalText}`, build a `BundleAfterTurnContext` per declaring capability via the new `buildAfterTurnContext` helper, iterate `setup.capabilities(env)` in registration order, invoke each declared `afterTurn` sequentially in a try/catch (log per-cap error to `console.error` with `[BundleSDK] afterTurn failed` prefix; continue to next cap), return 204 on success.
- [x] 2.2 Extend the switch with a `POST /on-connect` case. Same envelope pattern as 2.1 — parse `{agentId, sessionId}`, build `BundleOnConnectContext` per declaring cap, iterate capabilities, invoke `hooks.onConnect` per cap.
- [x] 2.3 Extend the switch with a `POST /dispose` case. Parse `{agentId}` only (no sessionId). Build `BundleDisposeContext` per declaring cap (NO sessionId, NO channel, NO emitCost, NO agentConfig). Iterate capabilities, invoke `dispose()` per cap.
- [x] 2.4 Extend the switch with a `POST /on-turn-end` case. Parse `{agentId, sessionId, messages, toolResults}`. Build `BundleTurnEndContext`. Invoke `setup.onTurnEnd(messages, toolResults)` once. Return 204.
- [x] 2.5 Extend the switch with a `POST /on-agent-end` case. Parse `{agentId, messages}`. Build `BundleAgentEndContext`. Invoke `setup.onAgentEnd(messages)` once. Return 204.

## 3. Bundle SDK runtime — context builders

- [x] 3.1 Add `buildAfterTurnContext(capabilityId, sessionId, agentId, env)` to `packages/runtime/bundle-sdk/src/runtime.ts`. Returns a `BundleAfterTurnContext` with the slim `BundleSpineClientLifecycle` (no `hookBridge`).
- [x] 3.2 Add `buildOnConnectContext(capabilityId, sessionId, agentId, env)` returning `BundleOnConnectContext`.
- [x] 3.3 Add `buildDisposeContext(capabilityId, agentId, env)` returning `BundleDisposeContext` — note no sessionId, no channel.
- [x] 3.4 Add `buildTurnEndContext(sessionId, agentId, env)` returning `BundleTurnEndContext`.
- [x] 3.5 Add `buildAgentEndContext(agentId, env)` returning `BundleAgentEndContext` — note no sessionId.
- [x] 3.6 In each context builder for `/dispose`, the spine client SHALL surface `ERR_SESSION_REQUIRED` errors thrown by host-side spine methods cleanly (not wrap them) so bundle handlers can typed-catch.

## 4. Bundle SDK build-time metadata aggregation

- [x] 4.1 In `packages/runtime/bundle-sdk/src/define.ts`, extend the build-time walk of `setup.capabilities(probeEnv)` to detect per-cap lifecycle hook declarations. Aggregate flags: `lifecycleHooks.afterTurn = capabilities.some(c => typeof c.afterTurn === "function")`; same shape for `onConnect` (via `c.hooks?.onConnect`) and `dispose` (via `c.dispose`).
- [x] 4.2 Set `lifecycleHooks.onTurnEnd = typeof setup.onTurnEnd === "function"` and `lifecycleHooks.onAgentEnd = typeof setup.onAgentEnd === "function"`.
- [x] 4.3 Ensure the existing `lifecycleHooks` object schema accepts the new fields without dropping them on JSON round-trip — add unit test covering metadata serialization and re-parse for a bundle declaring all five flags.

## 5. Bundle host — prerequisite cleanup + getActiveLifecycleFlags

- [x] 5.1 Refactor `BundleDispatcher.dispatchClientEvent` (`packages/runtime/bundle-host/src/dispatcher.ts:340-381`) to call `composeWorkerLoaderConfig` instead of hand-rolling the loader config. Existing tests for `dispatchClientEvent` SHALL pass unchanged after the refactor.
- [x] 5.2 Add `BundleDispatcher.getActiveLifecycleFlags(): BundleMetadata["lifecycleHooks"] | null` returning the active bundle's flag snapshot (or `null` when no bundle is active). Used by `agent-do.ts` callbacks to decide whether to dispatch.
- [x] 5.3 Add a code-comment in `bundle-host/src/loader-config.ts` listing all dispatch endpoints (turn, alarm, session-created, client-event, http, action, after-turn, on-connect, dispose, on-turn-end, on-agent-end, config-change, agent-config-change, config-namespace-get, config-namespace-set) so future contributors see the full set in one place.
- [x] 5.4 Verify `composeWorkerLoaderConfig` accepts the five new endpoint paths without modification. If signature requires extension to carry the new endpoints' envelope shape, extend it; otherwise reuse as-is.

## 6. Bundle host — token mint extension + ERR_SESSION_REQUIRED

- [x] 6.1 Extend `mintToken` (`packages/runtime/bundle-host/src/token.ts`) payload from `sessionId: string` to `sid: string | null`. Maintain `sessionId` field for one release cycle for backward compatibility.
- [x] 6.2 Add `requireSession(caller: SpineCaller): asserts caller is SpineCaller & {sid: string}` helper in `packages/runtime/bundle-host/src/spine-service.ts` that throws `ERR_SESSION_REQUIRED` when `caller.sid === null`.
- [x] 6.3 Add `"ERR_SESSION_REQUIRED"` to the `SpineErrorCode` union in `packages/runtime/bundle-token/src/`. Mirror the addition in any verify-only token shape.
- [x] 6.4 Audit every session-scoped spine method in `bundle-host/src/spine-service.ts` (`spineAppendEntry`, `spineGetEntries`, `spineBuildContext`, `spineBroadcast`, `spineRecordToolExecution`, `spineProcessBeforeInference`, `spineProcessBeforeToolExecution`, `spineRecordBundlePromptSections`, `spineGetBundlePromptSections`, etc.) and add `requireSession(caller)` as the first line of the method body.
- [x] 6.5 Verify-side compatibility — `bundle-token/src/` SHALL accept both `sessionId: string` (legacy) and `sid: string | null` (new) for one release cycle. Add explicit dual-shape acceptance with a TODO to remove legacy after one release.

## 7. Bundle host — toolResults projection

- [x] 7.1 Add `projectToolResultsForBundle(toolResults: unknown[]): BundleToolResult[]` to `packages/runtime/bundle-host/src/serialization.ts`. Each entry reduced to `{toolName, args, content, isError}` based on the existing `agent-core` event shape.
- [x] 7.2 Non-projectable entries (functions, class instances, stream readers) SHALL be replaced with `{toolName: "unknown", args: null, content: "<projection failed>", isError: true}` and emit a `[BundleDispatch] kind: "lifecycle_on_turn_end" outcome: "tool_result_projection_failed"` log entry per entry (with `entryIndex`).
- [x] 7.3 Add unit test covering: (a) clean two-result array projects unchanged, (b) entry with function reference substitutes sentinel, (c) entry with stream reader substitutes sentinel.

## 8. Agent runtime — callback declarations + invocation sites

- [x] 8.1 Add five optional callback fields to `AgentRuntimeOptions` (and the corresponding fields on `AgentRuntime`) in `packages/runtime/agent-runtime/src/agent-runtime.ts` mirroring `bundleClientEventHandler` (`448`), `bundleAlarmHandler` (`462`), `bundleSessionCreatedHandler` (`472`):
  - `bundleAfterTurnHandler?: (sessionId: string, finalText: string, capabilitiesSnapshot: Capability[]) => Promise<void>`
  - `bundleOnConnectHandler?: (sessionId: string) => Promise<void>`
  - `bundleDisposeHandler?: () => Promise<void>`
  - `bundleOnTurnEndHandler?: (sessionId: string, messages: AgentMessage[], toolResults: BundleToolResult[]) => Promise<void>`
  - `bundleOnAgentEndHandler?: (messages: AgentMessage[]) => Promise<void>`
- [x] 8.2 Extend `dispatchAfterTurn` (`agent-runtime.ts:3064-3117`) — AFTER the static `for (const cap of hooks)` loop, await `bundleAfterTurnHandler?(sessionId, finalText, capabilities)` inside a try/catch. The existing `waitUntil`-tracked `dispatchPromise` (registered at lines 3046-3048) covers both static and bundle execution; no new `waitUntil` registration needed.
- [x] 8.3 Extend `fireOnConnectHooks` (`agent-runtime.ts:2814+`) — AFTER the per-cap `await hook(ctx)` loop completes, register `runtimeContext.waitUntil(...)` for `bundleOnConnectHandler?(sessionId)` AND add the resulting promise to `pendingAsyncOps`. Inner try/catch catches and logs handler errors.
- [x] 8.4 Extend `disposeCapabilities` (`agent-runtime.ts:2802-2811`) — AFTER the static `for (const { capabilityId, dispose } of this.capabilityDisposers)` loop kicks off the static disposes (non-awaited per current substrate), register `runtimeContext.waitUntil(...)` for `bundleDisposeHandler?()` AND add to `pendingAsyncOps`.
- [x] 8.5 Extend the `onTurnEnd` handler (`agent-runtime.ts:2983-2998`) — AFTER kicking off the static `onTurnEnd?([event.message], event.toolResults)` (non-awaited per current substrate), register `runtimeContext.waitUntil(...)` for `bundleOnTurnEndHandler?(sessionId, [event.message], event.toolResults)`. NOTE: at this layer `toolResults` is still raw — projection happens in the `agent-do.ts` callback before HTTP forward.
- [x] 8.6 Extend the `onAgentEnd` handler (`agent-runtime.ts:2999-3013`) — AFTER kicking off the static `onAgentEnd?(event.messages)` (non-awaited per current substrate), register `runtimeContext.waitUntil(...)` for `bundleOnAgentEndHandler?(event.messages)`.
- [x] 8.7 In every new callback invocation site, ensure failures are caught locally and do NOT increment `BundleDispatcher.consecutiveFailures`. Add comment cross-referencing Decision 11 (lifecycle failures are observation-only).
- [x] 8.8 Verify `agent-runtime.ts` does NOT import anything from `@crabbykit/bundle-host` after these edits — run `bun run lint` (which invokes `scripts/check-package-deps.ts`) to confirm.

## 9. Agent runtime — BundleConfig timeout

- [x] 9.1 Add `lifecycleHookTimeoutMs?: number` (default 5 000) to the `BundleConfig` interface in `packages/runtime/agent-runtime/src/bundle-config.ts`. Document the precedent (matches `configHookTimeoutMs`).

## 10. Agent DO — callback wiring

- [x] 10.1 In `packages/runtime/agent-runtime/src/agent-do.ts`, extend the `1886-1917` block where `bundleClientEventHandler` / `bundleAlarmHandler` / `bundleSessionCreatedHandler` are wired. Add five new wirings.
- [x] 10.2 `runtime.bundleAfterTurnHandler = async (sessionId, finalText, _capabilities): Promise<void> => { ... }` — read `BundleDispatcher.getActiveLifecycleFlags()`; if `afterTurn` flag is `false`, return; otherwise mint a per-turn token (sid: sessionId), build loader config via `composeWorkerLoaderConfig`, dispatch `POST /after-turn` with body `{agentId, sessionId, finalText}`, race against `lifecycleHookTimeoutMs`, log structured outcome, swallow errors.
- [x] 10.3 `runtime.bundleOnConnectHandler = async (sessionId): Promise<void> => { ... }` — same pattern; dispatch `POST /on-connect` with `{agentId, sessionId}`.
- [x] 10.4 `runtime.bundleDisposeHandler = async (): Promise<void> => { ... }` — read flag; if false return; mint token with `sid: null`; dispatch `POST /dispose` with body `{agentId}` (no sessionId); race against timeout; log; swallow errors.
- [x] 10.5 `runtime.bundleOnTurnEndHandler = async (sessionId, messages, toolResults): Promise<void> => { ... }` — read flag; if false return; project `toolResults` via `projectToolResultsForBundle(toolResults)`; mint token (sid: sessionId); dispatch `POST /on-turn-end` with body `{agentId, sessionId, messages, toolResults: projected}`; race against timeout.
- [x] 10.6 `runtime.bundleOnAgentEndHandler = async (messages): Promise<void> => { ... }` — read flag; if false return; mint token with `sid: null`; dispatch `POST /on-agent-end` with body `{agentId, messages}`; race against timeout.

## 11. Telemetry

- [x] 11.1 Audit each new dispatch site to confirm structured `[BundleDispatch]` log emits with `kind`, `agentId`, `sessionId?` (omitted for dispose/on-agent-end), `bundleVersionId`, `outcome` ("ok"|"timeout"|"error"|"tool_result_projection_failed").
- [x] 11.2 On error path, include `error: error.message` in the log payload (truncated to 500 chars to bound log size).

## 12. Tests — bundle SDK

- [x] 12.1 Add unit test in `packages/runtime/bundle-sdk/src/__tests__/lifecycle-after-turn.test.ts`: bundle with two capabilities, both declaring `afterTurn`, verify both fire in registration order.
- [x] 12.2 Add test for `afterTurn` error isolation: capability A throws, capability B still runs.
- [x] 12.3 Add test for `/on-connect` invoking `hooks.onConnect` for each declaring cap.
- [x] 12.4 Add test for `/dispose` invoking each cap's `dispose()` exactly once with `BundleDisposeContext` (no sessionId, no channel).
- [x] 12.5 Add test for `/on-turn-end` invoking `setup.onTurnEnd` once with `messages` and `toolResults: BundleToolResult[]`.
- [x] 12.6 Add test for `/on-agent-end` invoking `setup.onAgentEnd` once with `messages` payload (no sessionId in envelope).
- [x] 12.7 Add test for build-time metadata aggregation: bundle with one cap declaring all three per-cap hooks → `lifecycleHooks.{afterTurn, onConnect, dispose}` all true; bundle with no setup-level hooks → `lifecycleHooks.{onTurnEnd, onAgentEnd}` both false.
- [x] 12.8 Add type-level test (or compilation assertion): `BundleDisposeContext` does NOT have `sessionId`, `channel`, `emitCost`, `agentConfig`. `BundleAgentEndContext` does NOT have `sessionId`.

## 13. Tests — host integration

- [ ] 13.1 Add integration test in `packages/runtime/agent-runtime/test/bundle-lifecycle-hooks.test.ts`: bundle with `afterTurn` declared, run a turn, verify the host invokes `bundleAfterTurnHandler` AFTER the static walk completes.
- [ ] 13.2 Add integration test: bundle WITHOUT `afterTurn` declared, run a turn, verify the host's `bundleAfterTurnHandler` callback short-circuits without calling `composeWorkerLoaderConfig` (assert via spy/mock).
- [ ] 13.3 Add integration test: bundle `afterTurn` throws, verify the host logs `[BundleDispatch] kind: "lifecycle_after_turn" outcome: "error"`, `consecutiveFailures` does NOT increment, subsequent turn proceeds.
- [ ] 13.4 Add integration test: bundle `onConnect` is dispatched on initial connect AND on hibernation-restore (separate dispatches at lines 1629 and 1638).
- [ ] 13.5 Add integration test: bundle `dispose` dispatched once on agent_end with `sessionId: undefined` in payload.
- [ ] 13.6 Add integration test: bundle `setup.onTurnEnd` receives projected `toolResults: BundleToolResult[]` — assert `event.toolResults` containing a function reference is replaced with sentinel.
- [ ] 13.7 Add integration test: lifecycle hook timeout — bundle handler delays 7 000 ms with `lifecycleHookTimeoutMs = 5 000`, host abandons after 5 000 ms with `outcome: "timeout"` log.
- [ ] 13.8 Add integration test: bundle `dispose` calls `ctx.spine.appendEntry(...)` → `ERR_SESSION_REQUIRED` thrown. Bundle SDK surfaces typed error.
- [ ] 13.9 Add integration test: token mint with `sid: null` succeeds; verify yields `caller.sid === null`.
- [ ] 13.10 Add integration test: refactored `dispatchClientEvent` produces same loader config shape as before refactor (snapshot the loader config object, compare against pre-refactor snapshot).

## 14. Examples

- [ ] 14.1 In `examples/bundle-agent-phase2/`, extend the example bundle's capability list with one capability declaring `afterTurn` (logs `finalText` to console), `hooks.onConnect` (broadcasts a custom state event via `ctx.channel`), and `dispose` (logs cleanup).
- [ ] 14.2 Add `setup.onTurnEnd` to the example bundle that logs turn-completion telemetry (e.g. message count + tool-result count).
- [ ] 14.3 Update the example's README section to document the new lifecycle hooks and how to observe them in the example UI.

## 15. Documentation

- [x] 15.1 Update `CLAUDE.md` under the bundle-brain section to document the five new lifecycle hook endpoints, the timeout knob (`lifecycleHookTimeoutMs`), the v1 parity gaps (no `schedules`/`rateLimit`/`requestFromClient`/`broadcastToAll` on bundle lifecycle contexts), the per-handler error-isolation invariant, the kicked-off-first-static ordering for `dispose`/`onTurnEnd`/`onAgentEnd` (vs strictly-after-static for `afterTurn` inside `dispatchAfterTurn`), the rationale for `dispose` being session-less, the `mintToken` payload extension to `sid: string | null`, and the new `ERR_SESSION_REQUIRED` SpineErrorCode.
- [x] 15.2 Add a one-line entry in CLAUDE.md's `bundle_disabled` reason codes section noting that lifecycle hook failures do NOT trigger any disable code (they're observation-only and exempt from `consecutiveFailures`).
- [x] 15.3 Update the bundle authoring guide (or proposal cross-reference) noting that `afterTurn` runs AFTER `agent_end` broadcast — bundle authors needing pre-broadcast modification must use `beforeInference` or interpose at the static turn loop, not `afterTurn`.
- [x] 15.4 Document the mode-filter caveat: a bundle whose only `afterTurn`-declaring capability is filtered out by the active mode still incurs the dispatch cost (the bundle SDK iterates and finds nothing to invoke). The "zero overhead for bundles that didn't declare the hook" claim applies at build time, not dispatch time after mode filtering.

## 16. Validation

- [x] 16.1 Run `bun run typecheck` to confirm type extensions compile across `bundle-sdk`, `bundle-host`, `bundle-token`, and `agent-runtime`.
- [x] 16.2 Run `bun run lint` to confirm dependency-direction invariants still hold (no new cross-bucket edges); especially confirm `agent-runtime` does NOT import from `bundle-host`.
- [x] 16.3 Run `bun run test` across the four modified workspaces; verify coverage on the new dispatch sites and callback wirings falls within the existing thresholds (statements 98%, branches 90%, functions 100%, lines 99%).
- [x] 16.4 Run the existing `dispatchClientEvent` tests after the prerequisite refactor in 5.1 to confirm no regression.
