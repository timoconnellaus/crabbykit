# bundle-host-hook-bridging Specification

## Purpose
TBD - created by archiving change bundle-shape-2-rollout. Update Purpose after archive.
## Requirements
### Requirement: `SpineHost` SHALL expose two new methods bridging the host hook chains for bundle-originated events

The `SpineHost` interface in `@claw-for-cloudflare/agent-runtime/src/spine-host.ts` SHALL be extended with two methods:

- `spineRecordToolExecution(caller: SpineCaller, event: ToolExecutionEvent): Promise<void>` — runs the host's `afterToolExecutionHooks` chain against the supplied event with a `CapabilityHookContext` constructed from the caller's `aid`/`sid`.
- `spineProcessBeforeInference(caller: SpineCaller, messages: AgentMessage[]): Promise<AgentMessage[]>` — runs the host's `beforeInferenceHooks` chain against the supplied messages, threading them through each hook in registration order, returning the final (possibly mutated) array.

Both methods SHALL be implemented by `AgentRuntime`. Both implementations SHALL reuse the existing `afterToolExecutionHooks` and `beforeInferenceHooks` arrays — they SHALL NOT introduce a parallel hook chain.

#### Scenario: AgentRuntime structurally satisfies the widened SpineHost
- **WHEN** the project compiles
- **THEN** the compile-time assertion that `AgentRuntime` satisfies `SpineHost` (in `agent-runtime/src/agent-do.ts`) passes
- **AND** both new methods exist on `AgentRuntime` with matching signatures

#### Scenario: spineRecordToolExecution iterates the existing hook array
- **WHEN** `AgentRuntime` is constructed with a capability that registers an `afterToolExecution` hook
- **AND** `spineRecordToolExecution` is called with a valid caller and event
- **THEN** the registered hook is invoked exactly once with the event and a `CapabilityHookContext` built from the caller

#### Scenario: spineProcessBeforeInference threads messages in registration order
- **WHEN** two capabilities register `beforeInference` hooks H1 (registered first) and H2 (registered second)
- **AND** `spineProcessBeforeInference` is called with `[m]`
- **THEN** H1 receives `[m]` and returns `[m']`
- **AND** H2 receives `[m']` and returns `[m'']`
- **AND** the method returns `[m'']`

<!-- Section: Per-turn budget -->

### Requirement: Bridge methods SHALL run under per-turn budget categories

`AgentRuntime`'s implementation of both bridge methods SHALL wrap their body through `withSpineBudget(caller, category, fn)` where `category` is `"hook_after_tool"` for `spineRecordToolExecution` and `"hook_before_inference"` for `spineProcessBeforeInference`. Default caps SHALL be conservative (sufficient for any legitimate per-turn usage; tight enough that a runaway bundle hits them rather than degrading host performance).

#### Scenario: Budget exceeded for after-tool category
- **WHEN** a bundle calls `recordToolExecution` more times in a turn than the `"hook_after_tool"` cap allows
- **THEN** the next call throws an error with code matching the existing budget-exceeded category (`ERR_BUDGET_EXCEEDED` or equivalent per existing convention)
- **AND** the host's hook chain is NOT invoked for the over-cap call

#### Scenario: Budget exceeded for before-inference category
- **WHEN** a bundle calls `processBeforeInference` more times in a turn than the `"hook_before_inference"` cap allows
- **THEN** the next call throws an error matching the existing budget-exceeded convention
- **AND** the host's hook chain is NOT invoked for the over-cap call

<!-- Section: SpineService bundle-callable methods -->

### Requirement: `SpineService` SHALL expose two new bundle-callable RPC methods that delegate to `SpineHost`

`SpineService` in `bundle-host/src/services/spine-service.ts` SHALL expose:

- `recordToolExecution(token: string, event: ToolExecutionEvent): Promise<void>`
- `processBeforeInference(token: string, messages: AgentMessage[]): Promise<AgentMessage[]>`

Both SHALL verify the unified bundle token with `requiredScope: "spine"` (matching SpineService's existing scope requirement; no new scope string introduced). Both SHALL construct a `SpineCaller` from the verified token payload (`aid`, `sid`, `nonce`) and call the corresponding `SpineHost` method via the typed `DurableObjectStub<SpineHost>`. Errors SHALL route through the existing `SpineService.sanitize` path before crossing the RPC boundary back to the bundle.

#### Scenario: Token without "spine" scope is rejected
- **WHEN** either bridge method is called with a `__BUNDLE_TOKEN` whose `scope` array does not contain `"spine"`
- **THEN** the method throws `ERR_SCOPE_DENIED`
- **AND** no `SpineHost` call is made

#### Scenario: Verified call delegates to SpineHost
- **WHEN** `recordToolExecution` is called with a token whose scope contains `"spine"` and a well-formed event
- **THEN** the method calls `host.spineRecordToolExecution(caller, event)` exactly once with `caller` derived from the verified token

#### Scenario: Errors are sanitized before propagation
- **WHEN** the underlying `SpineHost` call throws an error containing host-internal detail
- **THEN** the bundle observes a sanitized error matching the format used by existing `SpineService` methods

<!-- Section: Bundle SDK runtime call sites -->

### Requirement: Bundle SDK runtime SHALL invoke the bridge after every tool execution and before every inference call

The bundle runtime in `@claw-for-cloudflare/bundle-sdk` SHALL call `spine.recordToolExecution(token, event)` after every tool execution completes (whether success or error). The call SHALL be awaited before the bundle proceeds to the next loop step.

The bundle runtime SHALL call `messages = await spine.processBeforeInference(token, messages)` immediately before each model inference call. The bundle SHALL pass the returned message array (not the original) to the inference call.

`token` SHALL be the value of `env.__BUNDLE_TOKEN`. If `__BUNDLE_TOKEN` is undefined, the runtime SHALL throw an error matching the existing missing-token convention before calling the bridge.

#### Scenario: After-tool bridge fires for every tool execution
- **WHEN** a bundle agent's turn executes N tools (any mix of success and error)
- **THEN** `spine.recordToolExecution` is called exactly N times
- **AND** each call's event payload corresponds to the matching tool execution

#### Scenario: Before-inference bridge fires for every model call
- **WHEN** a bundle agent's turn makes N model inference calls
- **THEN** `spine.processBeforeInference` is called exactly N times
- **AND** each call precedes its matching inference call
- **AND** the inference call uses the message array returned by the bridge call

#### Scenario: Bridge call is awaited (ordering preserved)
- **WHEN** a bundle executes tool T1 then tool T2 in sequence
- **THEN** `recordToolExecution` for T1 completes before T2 begins executing

#### Scenario: Failure of bridge call does not silently break loop
- **WHEN** a bridge call throws (e.g., budget exceeded)
- **THEN** the error surfaces to the bundle's error handling path
- **AND** the bundle does NOT silently continue with stale state

<!-- Section: Hook chain semantics preserved -->

### Requirement: Bridge SHALL NOT change observable hook semantics relative to the static path

A capability registering an `afterToolExecution` or `beforeInference` hook SHALL observe identical behavior whether the originating tool/inference event came from the static path or the bridge. Specifically:

- `CapabilityHookContext` shape is identical (same fields populated from the caller).
- Hook execution order is identical (registration order in both paths).
- Per-hook error swallowing matches the static path: a hook that throws does NOT abort the chain; subsequent hooks still run; the error is logged.
- A `beforeInference` hook's returned message array is the input to the next hook in the chain (mutator chaining).

#### Scenario: Identical context shape
- **WHEN** the same capability hook is invoked from a static-pipeline tool event vs a bridge-routed bundle event
- **THEN** the `CapabilityHookContext` passed to the hook has identical structural shape (same set of populated fields)

#### Scenario: Hook error does not abort the chain
- **WHEN** three `afterToolExecution` hooks H1, H2, H3 are registered (in that order)
- **AND** H2 throws
- **AND** the bridge runs the chain
- **THEN** H1 ran successfully
- **AND** H3 also ran (despite H2 throwing)
- **AND** the bridge call resolves successfully

#### Scenario: beforeInference mutator chaining
- **WHEN** H1 returns `[m']` from input `[m]` and H2 returns `[m'']` from input `[m']`
- **AND** the bridge runs the chain
- **THEN** the bridge returns `[m'']`

<!-- Section: Static path unchanged -->

### Requirement: The static-pipeline hook invocation path SHALL be unchanged

`AgentRuntime`'s existing inline invocation of `afterToolExecutionHooks` and `beforeInferenceHooks` for static-brain tool execution and inference SHALL continue to function unchanged. The bridge SHALL be an *additional* entry point into the same hook chains, not a replacement.

A static-brain agent's hook execution timing, ordering, context shape, and error handling SHALL be byte-identical before and after this change.

#### Scenario: Static-brain agent regression-free
- **WHEN** a static-brain agent (no `bundle` field on `defineAgent`) executes a tool
- **THEN** the static path invokes `afterToolExecutionHooks` directly (not through SpineService/bridge)
- **AND** observable hook behavior is identical to behavior before this change

#### Scenario: Static-brain agent does not invoke the bridge
- **WHEN** a static-brain agent runs a turn
- **THEN** `spineRecordToolExecution` and `spineProcessBeforeInference` are NOT called

