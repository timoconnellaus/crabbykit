## Why

Bundle agents in their current state are text-streaming brains. The bundle SDK's `runBundleTurn` builds a system prompt from `setup.prompt` only, opens an SSE stream against `LlmService.inferStream`, accumulates the text into an assistant message, and persists it. `setup.tools(env)` is never invoked. `setup.capabilities(env)` is never invoked. There is no tool-execution loop, no capability-contributed prompt sections in the bundle's prompt, no per-turn mode resolution, and no way for a bundle to react to alarm fires, session creation, or steer/abort messages. The compiled bundle's HTTP fetch handler discriminates on `/turn`, `/client-event`, `/alarm`, `/session-created`, `/smoke`, `/metadata` — but `/client-event`, `/alarm`, `/session-created` are stub handlers that return `{ status: "acknowledged" }` and ignore the body.

The `bundle-shape-2-rollout` work that just shipped wired four host-side capabilities (`tavily-web-search`, `file-tools`, `vector-memory`, `skills`) for bundle access — bundles can now declare them in `requiredCapabilities`, mint a token whose `scope` includes their kebab-case ids, and call them via service-binding RPC. It also added the host-hook-bus bridge so `afterToolExecution` and `beforeInference` host hooks fire against bundle-originated events. But the bundle runtime itself never produces `afterToolExecution` events because it doesn't execute tools, and bundles never declare `BundleCapability`s with bundle-side tools or sections because `setup.capabilities(env)` is never read. Shape-2 wired the highway; the bundle runtime is still on the on-ramp.

The honest framing: this proposal is the bundle runtime's v2 — bringing the bundle brain to functional parity with the static brain across four axes: tool execution, capability-contributed prompt sections, lifecycle reaction (alarms / session created / client events), and mode-aware scoping. Each phase widens the same `defineBundleAgent` contract and the bundle-side runtime that consumes it; collapsing them into one proposal avoids four rounds of edits to the same files (`bundle-sdk/src/runtime.ts`, `bundle-sdk/src/define.ts`, `bundle-sdk/src/types.ts`, `agent-do.ts`'s `initBundleDispatch` closure, `bundle-host/src/dispatcher.ts`).

The scope is bigger than an earlier draft of this proposal claimed. That draft framed three of the four phases as "additive type widening" against an existing pipeline; an Opus review correctly identified that the pipeline doesn't exist. Phase 0 of this proposal builds it. Phases 1–3 then sit on real substrate.

Why now:

1. **Bundle agents are not credible without tool execution.** A non-trivial agent calls tools. Bundles today can stream text. That's a demo, not a brain. Every additional bundle feature shipped before tool execution widens the gap rather than closes it.
2. **The shape-2 capabilities are the consumers.** `tavily-web-search`'s bundle client returns a `Capability` with two tools; `file-tools`'s returns nine. None of those tools execute today inside a bundle agent because `setup.capabilities(env)` is never invoked. Phase 0 makes shape-2 actually do something for bundle agents.
3. **Hook bridge is already in place.** `afterToolExecution` and `beforeInference` hook chains fire from spine for bundle events — but only if the bundle generates those events. Phase 0 is what makes them generate.
4. **Lifecycle hooks (Phase 2) are independently shippable.** They don't depend on tool execution. They could be a separate proposal, but they touch the same files as Phase 0 (`bundle-sdk/src/define.ts`, `agent-do.ts` event paths) and bundling them keeps the review surface coherent.
5. **`bundle-authoring-guide` (the deferred docs proposal) needs a stable surface.** This proposal is the surface settling.

Functional parity goal: a bundle agent and a static agent wired with the same `model` + `tools` + `capabilities` + `modes` + lifecycle hooks should produce equivalent observable behavior. The bundle changes how the brain runs, not what the brain can do. After this proposal lands, that invariant holds for the first time.

## What Changes

### Phase 0 — Bundle-side capability + tool execution

- **`runBundleTurn` invokes `setup.capabilities(env)` and `setup.tools(env)`.** At the start of each turn, after building the bundle context, the runtime resolves the bundle's capability list and tool list. Capabilities supply additional tools (via `cap.tools(ctx)`) and prompt sections (via `cap.promptSections(ctx)`). Tools are merged into the LLM call's tool inventory; sections are merged into the system prompt.

- **Bundle prompt build merges `setup.prompt` (or default) + capability-contributed sections.** The static brain's rule applies: when `setup.prompt: string` is supplied, it is the verbatim system prompt and capability sections are NOT appended (matches static `defineAgent` behavior). When `setup.prompt: PromptOptions` (or undefined), the default builder runs with capability sections spliced after defaults. The merged section list is the input to the prompt-string assembly.

- **Bundle tool-execution loop.** The bundle runtime parses tool calls from the streamed assistant message (provider-agnostic — OpenAI tool_calls and Anthropic tool_use blocks), invokes each tool's `execute(args, ctx)` against the merged tool list, calls `hookBridge.processBeforeToolExecution(event)` before each tool runs (matching the host hook bridge's pre-tool gate already shipped in shape-2), calls `hookBridge.recordToolExecution(event)` after each tool completes, broadcasts tool-call/tool-result events identical to the static brain's wire format, appends a tool-result message to the conversation, and re-runs inference until the model produces a stop-reason terminal turn or hits the per-turn tool-call cap (enforced by spine budget category `"hook_after_tool"` from the existing bridge).

- **`BundleCapability.hooks.afterToolExecution` fires bundle-side too.** The existing `BundleCapability.hooks` shape (with `beforeInference` and `afterToolExecution`) is invoked in the bundle's loop alongside the host hook bridge. Bundle-side hooks run inside the isolate; host-side hooks run via the bridge. Both fire for the same tool execution event. Order: bundle-side hooks first (registered order), then bridge to host (which runs host-registered hooks in their registered order).

- **Bundle context is unchanged externally.** `BundleContext` already exposes everything the loop needs — `sessionStore`, `kvStore`, `scheduler`, `channel`, `emitCost`, `hookBridge`. No new fields in Phase 0.

- **Existing text-only behavior preserved as a special case.** A bundle whose `setup.tools` and `setup.capabilities` are both undefined (or return empty arrays) follows the existing v1 streaming-text path. No regression for any bundle in flight.

### Phase 1 — Bundle PromptSection parity

- **`BundleCapability.promptSections` widens to accept full `PromptSection`.** Return type goes from `Array<string | BundlePromptSection>` to `Array<string | BundlePromptSection | PromptSection>`. The bundle prompt handler normalizes every entry into a full `PromptSection` with `source: PromptSectionSource`, `key: "cap-<id>-<index>"`, `lines`, `tokens`, `included`, `excludedReason`. Bare strings normalize to `{ source: { type: "custom" } }` matching the static path's "buildSystemPrompt as a single 'custom' section" rule. `BundlePromptSection` normalizes to `{ source: { type: "capability", capabilityId, capabilityName } }`. Full `PromptSection` passes through with default-fill for missing optional fields.

- **Bundle dispatcher caches the most-recent normalized `PromptSection[]` per session.** After each per-turn prompt build (in Phase 0's `runBundleTurn`), the bundle SDK calls `spine.recordPromptSections(sessionId, sections)` (a new spine bridge method). The host writes to `ctx.storage.put("bundle:prompt-sections:<sessionId>:v=<bundleVersionId>", sections)`. Version-keyed to prevent stale snapshots from previous bundle versions appearing in inspection.

- **Inspection RPC reads the cache.** New spine method `spineGetBundlePromptSections(caller, sessionId, bundleVersionId?): Promise<PromptSection[]>` returns the cached sections for the requested version (defaults to active). Cold session returns `[]`. Wrapped through `withSpineBudget` under a new `"inspection"` category.

- **Backwards compatibility.** Bundles whose capabilities return strings or `BundlePromptSection` from `promptSections` are unchanged in observable output. The new `PromptSection` form is purely additive.

### Phase 2 — Bundle lifecycle hooks

- **`BundleAgentSetup` gains three optional top-level fields.** Mirrors `defineAgent`'s flat shape:
  - `onAlarm?: (env: TEnv, ctx: BundleAlarmContext) => void | Promise<void> | Promise<{ skip?: boolean; prompt?: string }>`
  - `onSessionCreated?: (env: TEnv, session: { id: string; name: string }, ctx: BundleSessionContext) => void | Promise<void>`
  - `onClientEvent?: (env: TEnv, event: BundleClientEvent, ctx: BundleClientEventContext) => void | Promise<void>`

- **`onAlarm` matches static `onScheduleFire` semantics.** One bundle dispatch *per due schedule* (not per wake), payload includes the full `Schedule` object, return value can be `{ skip: true }` to cancel that schedule fire OR `{ prompt: string }` to override the schedule's prompt (parity with `agent-runtime/src/agent-runtime.ts`'s `handleAlarmFired` per-schedule loop). The host awaits the bundle's response on this path so the return value can influence dispatch — the latency cost (one cross-isolate RPC per due schedule) is bounded by the per-wake schedule fan-out, which existing static behavior already pays for.

- **`onSessionCreated` and `onClientEvent` are observation/reaction hooks.** Return type `void | Promise<void>`. Host fires them alongside any other event subscribers (static `onSessionCreated`, transport client-event routing) and proceeds regardless of bundle handler outcome. Failure surfaces as structured error in telemetry.

- **`BundleMetadata.lifecycleHooks` build-time declaration.** Populated by `defineBundleAgent` from setup field presence: `lifecycleHooks: { onAlarm: setup.onAlarm !== undefined, onSessionCreated: setup.onSessionCreated !== undefined, onClientEvent: setup.onClientEvent !== undefined }`. Host reads at dispatch time and skips Worker Loader instantiation entirely for hooks the bundle doesn't declare. Bundles published before this change have `lifecycleHooks: undefined`, treated as all-false.

- **HTTP handler implementations replace stubs.** `handleAlarm`, `handleSessionCreated`, `handleClientEvent` parse their typed payloads, build the appropriate context (with `BundleSpineClient`), invoke the user handler if defined, return JSON status with the handler's typed return value (for `onAlarm`) or `{ status: "ok" }` (for the void-returning hooks). All three verify `env.__BUNDLE_TOKEN` first (401 if missing).

- **Lifecycle hook context is event-scoped, not turn-scoped.** Lifecycle handlers receive `BundleAlarmContext` / `BundleSessionContext` / `BundleClientEventContext`, each with `spine: BundleSpineClient` and event-specific fields (`schedule: Schedule` for alarm, `sessionId` for session, `event: BundleClientEvent` for client event). Full `BundleContext` (with `kvStore`, `scheduler`, `channel`, `hookBridge`) is NOT supplied — the hookBridge's methods (`processBeforeInference`, `recordToolExecution`, `processBeforeToolExecution`) are turn-loop concepts and would generate phantom hook events host-side if invoked outside a turn. The contract surface is intentionally minimal; widening is cheaper than narrowing later.

- **Lifecycle dispatch token uses the same scope shape as `/turn`.** Mints `__BUNDLE_TOKEN` with `scope: ["spine", "llm", ...catalogIds]`. The lifecycle handler can call back through spine and inference using the same authority the turn brain has.

### Phase 3 — Mode-aware bundle dispatch

- **Bundle dispatcher resolves and applies the active mode before composing the bundle env.** Per-turn flow (after Phase 0's capability/tool resolution):
  1. Read `activeModeId` from session metadata (existing `readActiveModeId`).
  2. If set AND a registered mode matches, look up `Mode` from cached modes.
  3. Apply `filterToolsAndSections(mode, tools, sections)` against the bundle's full tool list (from Phase 0's resolution) and full prompt section list (from Phase 1's normalization).
  4. Compose the bundle env with the *filtered* tool list (the bundle isolate sees only mode-allowed tools).
  5. Compose the prompt with the *filtered* section list. Excluded sections surface in the inspection cache with `excludedReason: "Filtered by mode: <id>"`.
  6. Mint the token, dispatch.

- **`BundleContext.activeMode` exposes thin identity.** New optional field: `activeMode?: { id: string; name: string }`. Bundle code reads `ctx.activeMode?.id` to branch on the active mode. Allow/deny lists stay host-side; the bundle never sees mode internals (defense in depth — filter is the only enforcement point).

- **Mode transitions broadcast `mode_event` for bundle agents identically to static.** No change to broadcast plumbing — `enter_mode`/`exit_mode`/`/mode <id>` work identically because the broadcast lives at the session-store layer, not the dispatch layer.

- **Subagent mode parity.** Bundle subagents spawned via `call_subagent`/`start_subagent` apply mode-awareness equivalently — the same mode-resolution step runs in the subagent dispatch path. Same `Mode` constants placed in `subagentModes` produce identical filtering.

- **Behavior-shifting note.** Any agent with modes registered + bundle wired today sees no filtering. After Phase 3 lands, the bundle suddenly sees the filtered tool/section set. This is correctness-improving (matches the documented v1.1 follow-up in CLAUDE.md) but visible. No opt-in flag — the v1 limitation was documented; removing it is the change. Release note flags it.

### Cross-cutting

- **Canonical dispatch path: production is the `initBundleDispatch` closure in `agent-do.ts`.** The `BundleDispatcher` class in `bundle-host/src/dispatcher.ts` is unit-test-only and is kept in sync with the closure (same convention as the catalog dispatch guard). Both must be updated for any per-turn flow change. Tasks explicitly thread changes through both.

- **No new packages.** All work lands in `packages/runtime/bundle-sdk/`, `packages/runtime/bundle-host/`, and `packages/runtime/agent-runtime/`.

- **No security model changes.** Token mint/verify, scope checks, catalog validation, dispatch guard, hook bridge — all unchanged.

## Capabilities

### New Capabilities

- `bundle-runtime-surface`: the v2 bundle runtime surface — `runBundleTurn` resolves `setup.capabilities(env)` and `setup.tools(env)`, runs a tool-execution loop with hook-bridge integration, builds prompts from default/setup + capability sections, applies mode filtering before composing the bundle env, and surfaces the rendered `PromptSection[]` for inspection. Three new lifecycle hook fields (`onAlarm`/`onSessionCreated`/`onClientEvent`) on `BundleAgentSetup`. `BundleContext.activeMode` exposes the active mode identity. `BundleMetadata.lifecycleHooks` declares which lifecycle endpoints the bundle implements. Establishes that bundle and static brains are functionally equivalent across tool execution, prompt composition, lifecycle reaction, and mode scoping.

### Modified Capabilities

- `agent-bundles`: the bundle dispatcher's per-turn flow now invokes bundle-side capability + tool resolution, applies mode-filtering before composing the bundle env, dispatches `/alarm` per due schedule with the full `Schedule` payload (gated by `BundleMetadata.lifecycleHooks?.onAlarm`), dispatches `/session-created` and `/client-event` from existing event sources gated by metadata, and writes a per-turn `PromptSection[]` snapshot keyed by `(sessionId, bundleVersionId)` for inspection. The dispatch gate, security primitive, catalog validation, and hook bridge are unchanged.

## Impact

- **Modified packages**:
  - `packages/runtime/bundle-sdk/`:
    - `runtime.ts` — `runBundleTurn` widens to invoke `setup.capabilities(env)` and `setup.tools(env)`, builds the merged prompt section list, runs the tool-execution loop, calls `processBeforeToolExecution`/`recordToolExecution` per tool, persists the rendered section snapshot via spine, exposes `BundleContext.activeMode`.
    - `types.ts` — `BundleAgentSetup` adds three lifecycle hook fields; `BundleContext` adds `activeMode?`; `BundleCapability.promptSections` widens return type; `BundleMetadata` adds `lifecycleHooks?`; new context types `BundleAlarmContext`/`BundleSessionContext`/`BundleClientEventContext` and `BundleClientEvent`.
    - `define.ts` — three stub HTTP handlers gain real implementations; metadata population from setup field presence.
    - `prompt/build-system-prompt.ts` (or new `prompt/merge-sections.ts`) — section merge logic respecting the `setup.prompt: string` override rule.
  - `packages/runtime/bundle-host/`:
    - `dispatcher.ts` — `BundleDispatcher` (test path) per-turn flow updated to mirror the production closure.
    - `services/spine-service.ts` — adds `recordPromptSections(token, sessionId, sections)` (write) and `getBundlePromptSections(token, sessionId, bundleVersionId?)` (read).
  - `packages/runtime/agent-runtime/`:
    - `spine-host.ts` — `SpineHost` adds `spineRecordBundlePromptSections` and `spineGetBundlePromptSections`.
    - `agent-runtime.ts` — implements both new spine methods reading/writing DO storage.
    - `agent-do.ts` — `initBundleDispatch` closure (production path) updated to: invoke bundle-side capability + tool resolution at dispatch time (host-side filtering — see Phase 3); thread mode resolution before env composition; gate lifecycle dispatches on `BundleMetadata.lifecycleHooks`; dispatch `/alarm` per due schedule with full payload; dispatch `/session-created` from session bootstrap; dispatch `/client-event` from steer/abort routing.
    - `agent-runtime.ts` `handleAlarmFired` — gain bundle-aware path that fires `/alarm` per schedule and respects `{ skip, prompt }` return.
- **Unchanged packages**: `packages/runtime/bundle-token/`, `packages/runtime/bundle-registry/`, `packages/runtime/agent-workshop/`, all `packages/capabilities/*`, all `packages/infra/*`, all `packages/channels/*`, all `packages/federation/*`, all `packages/ui/*`. Capabilities benefit downstream because their bundle clients' tools now actually execute, but no per-cap code change.
- **Wire-format changes**:
  - `BundleMetadata.lifecycleHooks` is a new optional field. Old bundles compatible.
  - `BundleContext.activeMode` is a new optional field on the bundle-side context.
  - Three lifecycle HTTP endpoint payloads formalized (per spec).
  - Two new spine methods (`recordPromptSections`, `getBundlePromptSections`) added.
- **Hot-path cost**:
  - Phase 0 tool-execution loop: same per-tool cost as the static path (one tool dispatch + one hook-bridge round trip per tool, already paid by the bridge for any bundle event).
  - Phase 0 capability/tool resolution: one in-isolate iteration over `setup.capabilities` + `setup.tools` per turn. Negligible.
  - Phase 1 cache write per turn: one spine call per turn writing the rendered `PromptSection[]`. Modest — matches Tavily's `emitCost` cost shape.
  - Phase 2 lifecycle dispatches: one Worker Loader cold-start per fire when bundle declares the hook. Per-due-schedule for alarms (matches static behavior).
  - Phase 3 mode resolution + filtering: one `readActiveModeId` (cached storage read) + one `filterToolsAndSections` (in-memory pure function) per turn. Negligible.
- **Cold-start cost**: lifecycle hook dispatches incur a Worker Loader instantiation per fire when the bundle isolate isn't warm. Bundles without the corresponding lifecycle declaration pay zero. High-frequency alarm consumers should batch logic into `/turn` and use `onAlarm` only as a trigger (documented in the authoring guide follow-up).
- **Breaking change**: none (additive everywhere). Behavior shift in Phase 3 for any agent with modes + bundle.
- **Security posture**: unchanged.
- **Out of scope**:
  - Bridging the remaining static hooks (`onConnect`, `onTurnEnd`, `onAgentEnd`, `onConfigChange`, `validateAuth`). Either host-pipeline-only by nature or already covered by the existing hook bridge.
  - Mode definition inside bundles. Modes remain a static-brain authoring concern.
  - A typed `ctx.mode.is("planning")` ergonomic helper. `ctx.activeMode?.id` is enough for now.
  - Bundle authoring of `subagentModes` definitions. Bundles consume the active subagent mode; they don't define new ones.
  - A `BundleCapability.httpHandlers`/`onConnect`/`configNamespaces` surface mirroring the host-side `Capability`. These remain host-only.
  - Compatibility shims for the Phase 3 behavior shift. Documented limitation; removing it is the change.
  - Auto-reindex tool-call wiring for `vector-memory` (already works once Phase 0 lands — the existing host-side `afterToolExecution` indexing hook fires via the bridge once the bundle generates tool events).
  - `BundleHookContext` mirroring the host-side `CapabilityHookContext`. Bundle hooks fire inside the isolate against the bundle's `BundleContext`.
- **Risk profile**: high for Phase 0 (substantially expands bundle runtime surface), medium-high for Phase 3 (behavior shift), low-medium for Phases 1 and 2 (additive). Phase 0 is the foundation — its design correctness affects every downstream phase. design.md enumerates open questions on tool-call parsing, error handling, hook ordering, and per-turn caps.
- **Phase atomicity**: each phase lands as one or more atomic commits per CLAW conventions. Phase 0 may need 2 commits (capability/tool resolution; tool-execution loop). Phases 1, 2, 3 each one commit. Order: Phase 0 → 1 → 2 → 3, by dependency (Phase 1 needs Phase 0's section merge; Phase 3 needs Phase 0's tool list to filter; Phase 2 is independent but lands after 1 to keep the order linear).
- **Unblocks**: the deferred `bundle-authoring-guide` proposal. After this lands, the bundle authoring surface is stable and the guide becomes write-once docs against a settled contract.
