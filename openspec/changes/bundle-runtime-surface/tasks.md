## 1. Phase 0a — Bundle-side capability + tool resolution (no execution yet)

### 1a. Bundle SDK runtime — resolve setup.capabilities and setup.tools

- [x] 1.1 In `packages/runtime/bundle-sdk/src/runtime.ts`, at the start of `runBundleTurn`'s `work` closure, invoke `setup.capabilities?.(env) ?? []` and `setup.tools?.(env) ?? []` to obtain `BundleCapability[]` and the bundle's author-supplied tools
- [x] 1.2 Build the merged tool list: concat `setup.tools(env)` with each capability's `cap.tools(ctx) ?? []`. Build the merged section list: collect each capability's `cap.promptSections(ctx) ?? []`. Build hook chains: collect each capability's `cap.hooks?.beforeInference` and `cap.hooks?.afterToolExecution`
- [x] 1.3 Update the system-prompt build to splice merged section list (string-content of normalized sections, see Phase 1) AFTER the default-builder output. Respect the `setup.prompt: string` override rule — when `setup.prompt` is a string, the merged section list is NOT spliced into the prompt (suppressed). Add a new helper `mergeSections(promptOptions, capabilitySections)` in `bundle-sdk/src/prompt/` that encapsulates the rule
- [x] 1.4 Preserve the v1 text-only fast path: when merged tools and merged sections are both empty AND no host hook bridge calls are required, take the existing streaming path with no per-tool round-trips. Detect via `mergedTools.length === 0 && mergedSections.length === 0`
- [x] 1.5 **Do NOT advertise the merged tool list to the LLM in this commit.** Plumb the tool list into a local variable available to `runBundleTurn`'s closure, but the `inferStream` call SHALL continue to omit `tools` from its request. Tool advertisement lands together with the execution loop in Phase 0b — splitting them would let the model emit tool calls the bundle silently fails to execute (worse than current text-only behavior)

### 1b. Tests

- [x] 1.6 Unit tests in `bundle-sdk/src/__tests__/`: `runBundleTurn` with `setup.capabilities` returning a capability with one tool merges the tool into the LLM call's tool inventory; with `setup.tools` returning tools they appear too; with both empty the fast-path is taken
- [x] 1.7 Unit test for `mergeSections`: string override suppresses; PromptOptions allows; default (undefined prompt) splices

### 1c. Verification

- [x] 1.8 `bun run typecheck` clean; `bun run lint` clean; `bun run test` green
- [x] 1.9 Atomic commit: `feat(bundle): resolve setup.capabilities and setup.tools per turn; merge into prompt build`

## 2. Phase 0b — Bundle tool-execution loop

### 2a. Provider tool-call parsers

- [x] 2.0 **Vendoring decision**: spend AT MOST 1 day evaluating whether pi-agent-core's existing tool-call parsers can be extracted into an isolate-safe shared package consumed by both bundle-sdk and host. Document the outcome in the commit message. If extractable, vendor and use; if not, proceed with fresh parsers (next tasks). Reason: OpenAI streaming tool-call argument deltas + multi-byte UTF-8 across SSE-event boundaries + provider quirks (OpenRouter mixing formats, Anthropic `input_json_delta` accumulation rules) are known foot-guns; reusing battle-tested code beats reimplementing
- [x] 2.1 Create `packages/runtime/bundle-sdk/src/providers/openai-toolcalls.ts` (or vendor equivalent): extract OpenAI/OpenRouter `tool_calls` deltas from SSE payloads (parallel to `extractDelta`), accumulate `function.arguments` JSON string per call-id across events, surface complete calls when the stop reason indicates tool-use. Handle: split-arguments across events, multi-byte UTF-8 across SSE-event boundaries (decoder needs `stream: true` until terminator), interleaved text+tool deltas
- [x] 2.2 Create `packages/runtime/bundle-sdk/src/providers/anthropic-toolcalls.ts`: extract Anthropic `tool_use` content-block + `input_json_delta` deltas similarly
- [x] 2.3 Update `iterateSseData` consumers to also yield tool-call deltas; consider returning a discriminated union `{ type: "text", delta } | { type: "toolCall", call }` from a unified iterator
- [x] 2.4 Recorded SSE fixture test matrix — hard cases enumerated explicitly: (a) text-only stream, (b) single tool call with single-event arguments, (c) single tool call with arguments split across 5+ events, (d) two parallel tool calls in one assistant message, (e) interleaved text + tool, (f) premature stream close mid-arguments, (g) UTF-8 multi-byte char split across SSE-event boundary inside arguments JSON, (h) OpenRouter upstream-provider variation (at least one Anthropic-via-OpenRouter fixture)

### 2b. Tool execution loop in runBundleTurn

- [x] 2.4a **Now advertise the merged tool list to the LLM** by passing it on the `inferStream` request (provider-agnostic tool-definition shape — verify against `packages/runtime/ai-proxy/`'s request schema). This is the boundary at which the model can emit tool calls; the loop below executes them
- [x] 2.5 After the LLM stream emits a tool-use stop reason, for each completed tool call: call `ctx.hookBridge.processBeforeToolExecution({ toolName, args, toolCallId })`; if `block: true`, append a tool-result message with `reason` as error and SKIP execution; otherwise look up the tool in the merged tool list
- [x] 2.6 Execute each non-blocked tool by calling its `execute(args, ctx)` (typed against the bundle's `BundleContext`); catch and convert errors to tool-error results
- [x] 2.7 After each tool execution: run bundle-side `BundleCapability.hooks.afterToolExecution` (in capability registration order across the bundle's capabilities) before calling `ctx.hookBridge.recordToolExecution({ toolName, args, isError })`
- [x] 2.8 Append tool-result message(s) to the conversation; broadcast tool-call/tool-result events with the same wire format static brain produces (verify by comparing against `agent-runtime`'s tool-event broadcasts)
- [x] 2.9 Re-run inference: call `ctx.hookBridge.processBeforeInference(messages)` first (existing bridge call), then `LlmService.inferStream` again with the updated message list; loop until the model emits a non-tool-use stop reason
- [x] 2.10 Cap inference iterations per turn at a sensible default (e.g. 25) to prevent runaway loops; surface as an explicit error message when hit

### 2c. Tool-call concurrency

- [x] 2.11 Tool-call sequencing: scope-bound the audit. Spend AT MOST 1 day attempting to extract pi-agent-core's tool-call sequencing logic into an isolate-safe shared helper. If portable within budget, both static and bundle paths use the helper. If not, ship Phase 0b with **sequential-only** tool execution and file a follow-up for parallelization. Decision is documented in the commit message

### 2d. Tests

- [x] 2.12 Unit tests for the loop: single-tool-call round-trips and re-inferences; two-tool-call message executes both before re-inference; blocked tool-call path appends deny reason without executing; iteration cap throws expected error
- [ ] 2.13 Integration test: bundle agent calls Tavily's `web_search` (real shape-2 capability) end-to-end via basic-agent example; assert tool result appears in conversation; assert `recordToolExecution` was called bundle-side — **deferred**: e2e test against real Tavily requires basic-agent + wrangler-dev + provider credentials. Wiring is exercised by `tool-loop.test.ts` against a duck-typed shape-2 capability (same `name`+`description`+`parameters`+`execute` shape Tavily produces via `defineTool`). Manual smoke recommended before merge.
- [x] 2.14 Integration test: bundle-side `afterToolExecution` hook on a capability fires before host hook bridge call; assert ordering

### 2e. Verification

- [x] 2.15 `bun run typecheck` clean; `bun run lint` clean; `bun run test` green
- [ ] 2.16 Basic-agent example smoke: bundle agent calls a tool from at least one shape-2 capability and the agent completes successfully — **deferred**: requires manual `bun dev` against basic-agent + provider credentials. Captured for manual smoke before merge.
- [x] 2.17 Atomic commit: `feat(bundle): add tool-execution loop with hook-bridge integration and provider tool-call parsing`

## 3. Phase 1 — Bundle PromptSection parity

### 3a. Type widening + normalization

- [x] 3.1 Widen `BundleCapability.promptSections` return type in `packages/runtime/bundle-sdk/src/types.ts` from `Array<string | BundlePromptSection>` to `Array<string | BundlePromptSection | PromptSection>`; add `PromptSection` import from `./prompt/types.js`
- [x] 3.2 Implement `normalizeBundlePromptSection(entry, capabilityId, capabilityName, index): PromptSection | null` (returns `null` for malformed entries):
  - String → `PromptSection` with `source: { type: "custom" }`, `key: "cap-${capabilityId}-${index}"`, computed `lines`/`tokens`, `included: true`
  - `BundlePromptSection` (kind: included|excluded) → `PromptSection` with `source: { type: "capability", capabilityId, capabilityName }`, computed `key`, `included` from `kind`
  - `PromptSection` → pass-through with default-fill for missing optional fields
  - Anything else → log warning + return `null`
- [x] 3.3 In `runBundleTurn` (Phase 0b output), normalize the merged section list using `normalizeBundlePromptSection` before splicing into the prompt
- [x] 3.4 Compute `lines`/`tokens` using same heuristics as the static path (extract to a shared utility in `bundle-sdk/src/prompt/` if not already shared)

### 3b. Inspection cache (version-keyed)

- [x] 3.5 Add `BundleSpineClient.recordPromptSections(sessionId: string, sections: PromptSection[]): Promise<void>` to the bundle-side spine client in `bundle-sdk/src/spine-clients.ts`
- [x] 3.6 Add `recordPromptSections(token: string, sessionId: string, sections: PromptSection[]): Promise<void>` to `SpineService` in `bundle-host/src/services/spine-service.ts`; verify token with `requiredScope: "spine"`; delegate to host
- [x] 3.7 Add `spineRecordBundlePromptSections(caller: SpineCaller, sessionId: string, sections: PromptSection[]): Promise<void>` to `SpineHost` in `agent-runtime/src/spine-host.ts`
- [x] 3.8 Implement on `AgentRuntime`: write to `ctx.storage.put("bundle:prompt-sections:" + sessionId + ":v=" + bundleVersionId, sections)`. Wrap through `withSpineBudget` (likely a write-side category — pick or add `"inspection"`) — implemented via `kvStore` under the reserved capability id `_bundle-inspection` so the platform-agnostic abstraction is used; storage shape is identical (key includes `:v=<bundleVersionId>`).
- [x] 3.9 Add `spineGetBundlePromptSections(caller: SpineCaller, sessionId: string, bundleVersionId?: string): Promise<PromptSection[]>` to `SpineHost` and implement on `AgentRuntime`: read from `ctx.storage.get("bundle:prompt-sections:" + sessionId + ":v=" + (bundleVersionId ?? activeBundleVersionId))`; return `[]` if absent
- [x] 3.10 Add `getBundlePromptSections(token, sessionId, bundleVersionId?)` to `SpineService`; verify scope, delegate, sanitize errors. Note this is read-side; consumed by inspection panel via spine RPC
- [x] 3.11 Wire `recordPromptSections` into `runBundleTurn` after each prompt build (call once per turn)

### 3c. Tests

- [x] 3.12 Unit tests for `normalizeBundlePromptSection`: each input form produces the expected `PromptSection`; malformed entries return `null` with warning
- [x] 3.13 Integration test: bundle dispatcher writes prompt-section snapshot per turn; subsequent `spineGetBundlePromptSections` returns the snapshot for the active version
- [ ] 3.14 Integration test: cache for a stale bundle version is NOT returned when querying with no version argument (active version mismatch) — **deferred to Phase 1 e2e follow-up**: requires DO storage harness; covered structurally by version-keying (key includes `:v=<id>`).
- [ ] 3.15 Cold-session test: `spineGetBundlePromptSections` returns `[]` for a never-dispatched session — **deferred to Phase 1 e2e follow-up**: requires DO storage harness; covered structurally by `if (!Array.isArray(sections)) return []` in impl.
- [x] 3.16 Backwards-compat test: bundle whose capabilities return only strings/`BundlePromptSection` renders identically to pre-Phase-1 behavior (assert prompt text unchanged)

### 3d. Verification

- [x] 3.17 `bun run typecheck` clean; `bun run lint` clean; `bun run test` green
- [x] 3.18 Atomic commit: `feat(bundle): normalize bundle prompt sections to full PromptSection[] with version-keyed inspection cache`

## 4. Phase 2 — Bundle lifecycle hooks

### 4a. Bundle SDK type additions

- [x] 4.1 Add three optional top-level fields to `BundleAgentSetup<TEnv>` in `packages/runtime/bundle-sdk/src/types.ts`: `onAlarm?` (returning `void | Promise<void> | Promise<{ skip?, prompt? }>`), `onSessionCreated?`, `onClientEvent?` (both returning `void | Promise<void>`) — exact signatures per spec
- [x] 4.2 Add three new context interfaces: `BundleAlarmContext { schedule: Schedule; spine: BundleSpineClient }`, `BundleSessionContext { sessionId: string; spine: BundleSpineClient }`, `BundleClientEventContext { sessionId: string; event: BundleClientEvent; spine: BundleSpineClient }`
- [x] 4.3 Add `BundleClientEvent` type — discriminated union `{ kind: "steer" | "abort" | string; payload: unknown }` (refine to match what host actually sends — verify against transport client-event payload type in `agent-runtime`)
- [x] 4.4 Add `lifecycleHooks?: { onAlarm?: boolean; onSessionCreated?: boolean; onClientEvent?: boolean }` to `BundleMetadata` in `types.ts`

### 4b. defineBundleAgent populates metadata

- [x] 4.5 In `packages/runtime/bundle-sdk/src/define.ts`, populate `metadata.lifecycleHooks` from setup field presence: `lifecycleHooks: { onAlarm: setup.onAlarm !== undefined, onSessionCreated: setup.onSessionCreated !== undefined, onClientEvent: setup.onClientEvent !== undefined }`. If all three are false, omit `lifecycleHooks` from metadata for backwards-compat

### 4c. HTTP handler implementations

- [x] 4.6 Replace stub `handleAlarm` in `define.ts`: verify `env.__BUNDLE_TOKEN` (401 if missing); verify `env.SPINE` (500 if missing with clear error); parse body for `{ schedule: Schedule }` payload; build `BundleAlarmContext`; invoke `setup.onAlarm?.(env, ctx)`; return `{ status: "ok", result }` (where `result` is the handler return) / `{ status: "error", message }` / `{ status: "noop" }` per spec
- [x] 4.7 Replace stub `handleSessionCreated`: same env guards; parse body for `{ session: { id, name } }`; build context; invoke handler; return `{ status: "ok" }` / `{ status: "error" }` / `{ status: "noop" }`
- [x] 4.8 Replace stub `handleClientEvent`: same env guards; parse body for `{ event }`; build context; invoke handler; return same status shape

### 4d. Host-side dispatch wiring

- [x] 4.9 In `agent-runtime/src/agent-runtime.ts`'s `handleAlarmFired` (or wherever the alarm path iterates due schedules), check `bundleMetadata.lifecycleHooks?.onAlarm`; if true, dispatch the bundle's `/alarm` for each due schedule. **Sequential-only in this commit**: parallel dispatch via `Promise.allSettled` is filed as a v2.1 follow-up — the alarm loop iterates serially today and refactoring iteration order is out of this commit's scope. Per-handler 5s timeout enforced; on timeout, treat as `{}`. Bundle's `{ skip, prompt }` wins over static `onScheduleFire`'s; either side's skip wins.
- [x] 4.10 In the session-bootstrap path: gate on `lifecycleHooks?.onSessionCreated`, mint token, POST to `/session-created` with `{ session }`. FIRE-AND-FORGET (do not await for state-affecting purposes); telemetry-log error responses
- [x] 4.11 In the client-event routing path (steer/abort handling): gate on `lifecycleHooks?.onClientEvent`, mint token, POST to `/client-event` with `{ event }`. Fire-and-forget; telemetry-log
- [x] 4.12 Each lifecycle dispatch goes alongside (not replacing) the host's other event consumers — static `onScheduleFire`, static `onSessionCreated`, transport client-event subscribers all still fire
- [ ] 4.13 Apply same wiring in `bundle-host/src/dispatcher.ts` (test-only `BundleDispatcher`) so the test path mirrors production — **deferred**: bundles together with task 5.5.1 (`composeWorkerLoaderConfig` extraction) which is the structural fix for the test/prod path drift. Production path is fully wired; test path mirror lands as a single follow-up that fixes the drift root cause instead of accumulating more touch-points.

### 4e. Tests

- [x] 4.14 Unit tests for each handler in `bundle-sdk/src/__tests__/`: handler defined → invokes user code, returns ok with result; handler undefined → returns noop; handler throws → returns error with message; missing `__BUNDLE_TOKEN` → 401; missing `env.SPINE` → 500
- [ ] 4.15 Integration test (in agent-runtime test suite): alarm fires for bundle with `onAlarm` declared → bundle handler invoked PER due schedule, structured success log; alarm fires for bundle without `onAlarm` declaration → no Worker Loader instantiation, no POST — **deferred**: needs DO + WorkerLoader test harness; Phase 2 e2e follow-up.
- [ ] 4.16 Integration test for `{ skip: true }` return — **deferred** with 4.15.
- [ ] 4.17 Integration test for `{ prompt }` return — **deferred** with 4.15.
- [ ] 4.18 Integration test for handler timeout — **deferred** with 4.15.
- [ ] 4.19 Integration test: bundle handler throws on `onSessionCreated` → static `onSessionCreated` still fires; structured error log records bundle id + version + handler + message — **deferred** with 4.15.
- [x] 4.20 `defineBundleAgent` metadata test: setup with all three hooks → metadata declares all three; setup with none → metadata omits `lifecycleHooks` entirely

### 4f. Verification

- [x] 4.21 `bun run typecheck` clean; `bun run lint` clean; `bun run test` green
- [ ] 4.22 Extend basic-agent example to demonstrate at least one lifecycle hook (e.g., `onSessionCreated` writing a seed entry); verify end-to-end via smoke test — **deferred**: manual smoke before merge.
- [x] 4.23 Atomic commit: `feat(bundle): add onAlarm, onSessionCreated, onClientEvent lifecycle hooks with awaited onAlarm semantics`

## 5. Phase 3 — Mode-aware bundle dispatch

### 5a. Bundle context activeMode

- [x] 5.1 Add `activeMode?: { id: string; name: string }` to `BundleContext` in `packages/runtime/bundle-sdk/src/types.ts`
- [x] 5.2 Update `buildBundleContext` (in `bundle-sdk/src/runtime.ts`) signature to accept an optional `activeMode` parameter and populate it on the constructed context

### 5b. Bundle dispatcher mode resolution + filtering

- [x] 5.2a **Ordering precondition**: BEFORE adding any mode-resolution logic, verify the merged section list seen by `filterToolsAndSections` already reflects Phase 0's `setup.prompt: string` override rule (string-override suppresses sections; mode filter then operates on the post-override list). Adding mode resolution without honoring this order is a silent regression vector
- [x] 5.3 In `agent-runtime/src/agent-do.ts`'s `initBundleDispatch` closure (production path), at the start of the per-turn flow (before composing the bundle env), resolve the active Mode and inject `__BUNDLE_ACTIVE_MODE = { id, name, tools, capabilities }` into the bundle env. The bundle SDK applies the allow/deny filters inside the isolate (capabilities filter drops tools+sections+hooks; tools filter applies to merged tool list by name). Defense-in-depth note (Decision 9): bundle controls execute(); filter is the recommendation surfaced to the LLM rather than a security boundary.
- [ ] 5.4 Apply the same flow in `bundle-host/src/dispatcher.ts`'s `BundleDispatcher` (test-only) so the test path matches production — **deferred**: bundles with task 5.5.1 (`composeWorkerLoaderConfig` extraction).
- [x] 5.5 Pass the resolved active mode (`{ id, name }`) into `buildBundleContext` so the bundle's runtime sees `ctx.activeMode`
- [x] 5.6 No active mode OR no registered mode matching `activeModeId` → skip filtering (bundle sees full tool/section set); `ctx.activeMode` is `undefined`
- [x] 5.6a **Behavior-shift mitigation**: one-time structured warning per (agentId, bundleVersionId) on first dispatch under an active mode — persistent flag at `bundle:mode-warning-emitted:<agentId>:<bundleVersionId>` prevents spam.
- [x] 5.7 Verify ordering: string-override (Phase 0) suppresses sections FIRST, then mode filter runs on the post-override section list (which may be empty)

### 5c. Subagent mode parity

- [ ] 5.8 Audit subagent bundle dispatch path (in `packages/capabilities/subagent/`) — confirm the same mode-resolution-and-filter steps run for subagent dispatches; if not, apply the same logic — **deferred**: requires audit of subagent capability's dispatch path; structurally the same `__BUNDLE_ACTIVE_MODE` env-injection mechanism applies once subagent dispatch invokes `bundleConfig.bundleEnv` similarly.
- [ ] 5.9 Add an integration test: parent + subagent both bundle agents, both register the same `Mode` in `modes`/`subagentModes`, both observe filtered tool sets when the mode is active — **deferred** with 5.8.

### 5d. Tests

- [x] 5.10 Integration test: bundle agent with active mode `"planning"` (registered with `tools: { allow: ["task_create"] }`) sees only `task_create` in its tool list at dispatch
- [x] 5.11 Integration test: bundle agent with active mode that excludes a capability section → bundle prompt does not contain the section content; inspection cache has the section with `included: false`, `excludedReason: "Filtered by mode: <id>"`
- [x] 5.12 Integration test: no active mode → bundle sees full tool/section set
- [ ] 5.13 Integration test: `activeModeId` set but no registered mode matches → dispatcher does not throw; bundle sees full tool/section set — **deferred** to e2e (covered structurally: dispatcher only injects env when `readActiveModeForSession` returns a Mode, so unmatched ids are no-op).
- [ ] 5.14 Integration test: bundle agent enters/exits mode via `enter_mode`/`exit_mode` tools → `mode_event` broadcast fires with same wire format as static-brain transitions — **deferred** to e2e (broadcast plumbing unchanged, only the bundle dispatch path receives the activeMode lookup).
- [x] 5.15 Interaction test for Decision 14: `setup.prompt: string` + active mode → capability sections suppressed in prompt regardless of mode; mode filter still applies to tool list

### 5e. Verification

- [x] 5.16 `bun run typecheck` clean; `bun run lint` clean; `bun run test` green
- [ ] 5.17 Extend basic-agent example to demonstrate a mode-using bundle agent — **deferred**: manual smoke before merge.
- [x] 5.18 Atomic commit: `feat(bundle): add mode-aware dispatch — resolve and apply active mode before bundle env composition`

## 5.5. Cross-cutting infrastructure tasks

- [ ] 5.5.1 **Extract `composeWorkerLoaderConfig(versionId, bytes, env, token)` helper** in `bundle-host/src/` that decodes the v1 envelope via `decodeBundlePayload` and produces the Worker Loader config. Update BOTH `initBundleDispatch` (production path: `dispatchTurn`, `dispatchClientEvent`, and the new lifecycle dispatch helpers from Phase 2) AND `BundleDispatcher` (test path) to call this helper. The convention "two paths kept in sync" is currently leaky — `dispatchClientEvent` in BundleDispatcher silently bypasses envelope decode while production `dispatchTurn` does not — and the more touch-points this proposal adds the worse the drift gets unless centralized
- [x] 5.5.2 **Pick budget category** for `recordPromptSections` and `getBundlePromptSections`: add new `"inspection"` category to `BudgetTracker` so inspection writes don't compete with hot-path session-store budget. Document defaults
- [x] 5.5.3 **Inspection cache eviction on session-delete**: in the existing session-delete code path, also delete all `bundle:prompt-sections:<sessionId>:v=*` keys for the deleted session. Use the existing storage `list` API with the prefix
- [x] 5.5.4 **`BundleCapability.configSchema` field**: it exists on the type but no current code reads it. This proposal does not add a consumer. Decision: keep the field (deferred to a future config-namespaces-for-bundles proposal) and add a JSDoc note `@deferred — no consumer in v2; planned for bundle-config-namespaces follow-up`. Do NOT remove it (would be a breaking type change for any forward-looking bundle author who already populated it)

## 6. Cross-phase verification

- [ ] 6.1 Run full repo test suite once after all four phases land — green
- [ ] 6.2 Run basic-agent example end-to-end exercising all four phases: bundle agent calling a shape-2 capability tool (Phase 0), with rich prompt sections rendered (Phase 1), at least one lifecycle hook firing (Phase 2), and an active mode filtering tools/sections (Phase 3)
- [ ] 6.3 Cross-cap regression test: an agent wiring `doom-loop-detection` (`afterToolExecution` consumer) + `tool-output-truncation` (`beforeInference` consumer) as a bundle observes identical behavior to the static-brain version (proves the host hook bridge works for real consumers, not just the trivial test cases that landed with shape-2)
- [ ] 6.4 Static-brain regression-free check: existing static-brain example/test runs green with no behavior change
- [ ] 6.5 Update `CLAUDE.md`: remove the "v1.1 follow-up" note about bundle mode-awareness; document the new `setup.tools`/`setup.capabilities`/`onAlarm`/`onSessionCreated`/`onClientEvent` fields; document `BundleContext.activeMode`; document the version-keyed inspection cache; note the canonical-vs-test dispatch path convention is preserved
- [ ] 6.6 Update `README.md` if it documents `defineBundleAgent`'s field set; add the new fields and note tool-execution + mode-awareness now work for bundles

## 7. Archive

- [ ] 7.1 Once all phases land and verification passes, archive this change via the OpenSpec workflow (`/opsx:archive bundle-runtime-surface`)
