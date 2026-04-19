## Context

The bundle runtime today (`packages/runtime/bundle-sdk/src/runtime.ts`) is a text-streaming v1: it builds a system prompt from `setup.prompt`, opens an SSE stream against `LlmService.inferStream`, accumulates the assistant text, persists it. `setup.tools(env)` is never invoked. `setup.capabilities(env)` is never invoked. There is no tool-execution loop, no `afterToolExecution` events generated bundle-side, no capability-contributed prompt sections in the bundle's prompt. The compiled bundle's `/alarm`, `/session-created`, `/client-event` HTTP endpoints are stubs returning `{ status: "acknowledged" }`. Bundle dispatch is mode-blind — `agent-do.ts`'s `bundlePromptHandler` short-circuits before `ensureAgent`, so `applyMode` never runs.

`bundle-shape-2-rollout` shipped four host-side capabilities for bundle access (Tavily, file-tools, vector-memory, skills) plus the host-hook-bus bridge so `afterToolExecution` and `beforeInference` host hooks fire against bundle-originated events. Both halves of the wiring are in place — the missing piece is that the bundle runtime never *generates* the events the bridge would relay. Shape-2 is the highway; bundle runtime is on the on-ramp.

Production bundle dispatch lives in `agent-runtime/src/agent-do.ts`'s `initBundleDispatch` closure (~480 lines starting at line 495). The `BundleDispatcher` class in `bundle-host/src/dispatcher.ts` (~566 lines) is unit-test-only and is kept in sync with the closure — the same convention used for the catalog dispatch guard, documented in CLAUDE.md. Both need updates for any per-turn flow change.

This proposal closes four gaps that together amount to "make the bundle brain do what the static brain does":

1. **Phase 0** — bundle-side capability + tool execution. `runBundleTurn` invokes `setup.capabilities(env)` and `setup.tools(env)`, runs a tool-execution loop, fires bundle-side hooks + the host hook bridge.
2. **Phase 1** — PromptSection parity. Bundle prompt handler normalizes capability sections into full `PromptSection[]` with source attribution; cached per session for inspection.
3. **Phase 2** — lifecycle hooks (`onAlarm` / `onSessionCreated` / `onClientEvent`) wired from existing host event sources to bundle HTTP endpoints, with `onAlarm` matching static `onScheduleFire`'s `{ skip, prompt }` semantics.
4. **Phase 3** — mode-aware bundle dispatch. `activeModeId` resolved at dispatch start, `filterToolsAndSections` applied to the bundle's tool list (from Phase 0) and section list (from Phase 1).

The unifying through-line: every phase widens the same `defineBundleAgent` contract or the bundle-side runtime that consumes it. Bundling them avoids four rounds of edits to `runtime.ts`, `define.ts`, `types.ts`, the `initBundleDispatch` closure, and `BundleDispatcher`.

## Goals / Non-Goals

**Goals:**

- **Bundle ≡ static functionally** for tool execution, prompt composition, lifecycle reaction, and mode scoping. Same authoring surface, same observable behavior. The bundle changes the runtime, not the brain.
- Build the missing substrate (Phase 0) honestly as its own phase, not pretend it already exists.
- Reuse the static brain's `applyMode`/`filterToolsAndSections`/`PromptSection` machinery verbatim. No parallel implementation.
- Preserve the existing v1 text-only path as a special case: bundles with no tools and no capabilities follow the same fast path as today.
- Land each phase as one or more atomic commits. Order: Phase 0 → 1 → 2 → 3 by dependency.

**Non-Goals:**

- Bridging `onConnect`, `onTurnEnd`, `onAgentEnd`, `onConfigChange`, `validateAuth` into the bundle isolate. Either host-pipeline-only by nature or already covered by the hook bridge.
- Mode definition inside bundles. Modes are a static-brain authoring concern.
- A `BundleCapability.httpHandlers` / `onConnect` / `configNamespaces` surface. Bundle capabilities expose tools + sections + the two existing hook fields (`beforeInference`, `afterToolExecution`); the rest stays host-only.
- Bundle subagent definition surface. Bundle subagents are spawned via the existing capability path; this proposal makes them mode-aware but doesn't change how they're declared.
- Backwards-compat shims. All changes are additive; the only behavior shift (Phase 3) is a documented v1 limitation being removed.
- A typed `ctx.capabilities.<id>.<method>(...)` bundle-side surface as alternative to tool calls.
- An opt-in flag for Phase 3's mode-awareness behavior. Per CLAUDE.md "v1.1 follow-up" note, the limitation was always documented; removing it is the change.

## Decisions

### Decision 1 — Production dispatch path is `initBundleDispatch` closure; `BundleDispatcher` class is test-only and kept in sync via a shared envelope helper.

`agent-runtime/src/agent-do.ts`'s `initBundleDispatch` closure is the production path; `bundle-host/src/dispatcher.ts`'s `BundleDispatcher` class is referenced from tests only and mirrors the closure's flow. Both must be updated together for any per-turn change. This proposal's tasks explicitly thread changes through both files.

**Existing drift acknowledged**: a spot-check shows the convention is already leaky — `BundleDispatcher.dispatchClientEvent` (and the production `bundleClientEventHandler`) wrap the bundle bytes as legacy single-file (`mainModule: "bundle.js"`) without going through `decodeBundlePayload`, while `dispatchTurn` does decode. Both paths *coincidentally* drift the same way for the client-event path. This proposal extracts a `composeWorkerLoaderConfig(versionId, bytes, env, token)` helper (task 5.5.1) and routes BOTH dispatch paths AND every new lifecycle dispatch (Phase 2) through the helper. The "kept in sync" convention then becomes "both paths call the same helper" — structurally enforced rather than convention-dependent.

**Why two paths exist.** Historical: `BundleDispatcher` was the original implementation; `initBundleDispatch` evolved from it as the integration with `AgentRuntime` deepened. The unify-token archived proposal ([2026-04-17-unify-bundle-capability-token](archive/2026-04-17-unify-bundle-capability-token)) called this out as an open architectural question and explicitly chose to keep both in sync rather than collapse them. This proposal does NOT collapse them either — that's a separate refactor — but the shared-helper extraction makes the parity convention enforceable.

**Alternative considered.** *Collapse `BundleDispatcher` into `initBundleDispatch`.* Rejected: scope creep. The dispatch-class consolidation is a worthwhile follow-up but is not blocking this proposal. The shared-helper approach achieves the parity invariant without the consolidation.

### Decision 2 — Phase 0's tool-execution loop runs inside the bundle isolate, not host-side.

The bundle SDK's `runBundleTurn` parses tool calls from the streamed assistant message, looks up tools in the merged `setup.tools(env) + capability.tools(ctx)` list, calls `execute(args, ctx)` for each tool, broadcasts tool-call/tool-result events, appends a tool-result message, and re-runs inference. All of this happens inside the bundle isolate.

**Why bundle-side?** The tools the bundle calls live in the bundle isolate's runtime — they're closures over `setup.tools(env)` (which had access to the bundle's `env`) and over `cap.tools(ctx)` (which had access to the bundle's `BundleContext`). Moving tool execution host-side would mean serializing tool definitions across the boundary, which doesn't work for closures. Same architectural reason the bundle has its own model loop in v1.

**What about host-side hooks on those tool executions?** The hook bridge (already shipped in shape-2) is precisely the answer: bundle calls `processBeforeToolExecution` before each tool, `recordToolExecution` after. Host hooks fire identically to static-brain tool events. This proposal doesn't change the bridge; it generates events for it.

**Alternative considered.** *Have the bundle proxy each tool execution through spine to a host-side executor.* Rejected: requires serializing tool definitions, defeats the bundle isolate purpose, and doubles RPC count per turn. Bundle-side execution + host hook bridge is the correct division of labor.

### Decision 3 — Tool-call parsing is provider-agnostic; vendor pi-agent-core's parsers if extractable, otherwise bundle SDK ships its own.

The bundle's existing SSE iterator (`iterateSseData` in `runtime.ts`) extracts text deltas from both OpenAI/OpenRouter and Anthropic streams. Phase 0 extends the same approach to tool-call deltas: OpenAI's `tool_calls[].function.{name, arguments}` and Anthropic's `tool_use` content blocks with `input_json_delta` accumulation. Tool-call accumulation is per-call-id; complete tool-call sets dispatch after the model emits a tool-use stop reason.

**Foot-guns to handle correctly:**
- OpenAI `function.arguments` arrives as a JSON-string built up across multiple SSE events; only complete strings can be `JSON.parse`d.
- The TextDecoder reading SSE bytes must use `stream: true` so a multi-byte UTF-8 char split across SSE-event boundaries inside `arguments` doesn't corrupt the JSON.
- OpenRouter mixes upstream provider formats per-route; routes targeting Anthropic emit Anthropic-shape events via OpenRouter's wrapper.
- Anthropic's `input_json_delta` has its own accumulation rules (per content block index).

**Vendoring decision (task 2.0).** Spend AT MOST 1 day evaluating whether pi-agent-core's existing tool-call parsers can be extracted into an isolate-safe shared package consumed by both bundle-sdk and host. If extractable within budget, vendor and use — battle-tested code beats reimplementing. If not (pi-agent-core's CJS issues in Workers may block extraction), proceed with fresh parsers, but ship with the explicit fixture-test matrix enumerated in task 2.4 (split-arguments, UTF-8 boundary, OpenRouter variation, premature stream close).

**Why parsers must run in the bundle isolate either way.** Tool-call execution happens bundle-side (Decision 2). The parser must be reachable from inside the isolate. Whether the parser source originated as fresh code or vendored from pi-agent-core, it ships in `bundle-sdk` and is consumed by `runBundleTurn`.

**Alternative considered.** *Move tool-call parsing host-side and forward parsed calls to the bundle for execution.* Rejected: doubles the RPC count per stream chunk, requires host to hold per-bundle SSE state, and serializes deltas across the boundary. Parser proximity to executor is correct.

### Decision 4 — Bundle hook ordering: bundle-side hooks fire first, then host hook bridge.

For each tool execution, the bundle's loop calls bundle-side `BundleCapability.hooks.afterToolExecution` (in registered order across the bundle's capabilities) before calling `hookBridge.recordToolExecution`. Same pattern for `beforeInference`: bundle-side `beforeInference` hooks transform messages first, then `processBeforeInference` bridges to host hooks.

**Why bundle-first?** Bundle-side hooks have access to the bundle's `BundleContext` (with bundle-side capability state, in-isolate caches, etc.). Host-side hooks have access to the host's `CapabilityHookContext`. Running bundle-first means bundle-internal state is consistent before the host sees the event. Host hooks then operate on the (possibly bundle-mutated) message stream — same flow direction as the static path's "registration order" rule.

**Alternative considered.** *Host first, then bundle.* Rejected: host can't observe bundle-internal state, so host-first would surface incomplete events. Bundle-first matches "events fire where they originate, then propagate."

### Decision 5 — `setup.prompt: string` overrides ALL capability sections (matches static `defineAgent` rule).

When a bundle's `setup.prompt` is a string, that string is the verbatim system prompt and capability-contributed sections are NOT appended. When `setup.prompt` is `PromptOptions` (or undefined), the default builder runs and capability sections splice in after the default sections.

**Why this rule?** The static brain has the same rule (`defineAgent`'s `prompt: string` overrides `buildSystemPromptSections`). Authoring symmetry — a static→bundle migration of an agent with `prompt: "verbatim string"` produces identical output.

**Inspection still surfaces excluded sections.** Capability sections that would have rendered are still surfaced in the inspection cache with `included: false, excludedReason: "Suppressed by setup.prompt: string override"`. Operators see what would have been in the prompt and why it isn't.

### Decision 6 — `onAlarm` matches static `onScheduleFire` semantics: per-schedule dispatch, awaitable, `{ skip, prompt }` return — but dispatched IN PARALLEL across due schedules with a tight per-handler timeout.

`agent-runtime.ts`'s `handleAlarmFired` iterates due schedules per wake and calls `onScheduleFire(schedule)` for each, respecting `{ skip: true }` to cancel that schedule and `{ prompt: string }` to override the schedule's prompt. Bundle's `onAlarm` mirrors the *contract* exactly. The *dispatch shape* differs from static (which calls in-process serially) for a CF Durable Objects reason explained below:

- One bundle dispatch per due schedule (not per wake).
- Payload: `{ schedule: Schedule }`.
- Return: `void | Promise<void> | Promise<{ skip?: boolean; prompt?: string }>`.
- Host awaits the bundle response on this path so the return value can influence dispatch.
- Dispatches across N due schedules run **in parallel** (`Promise.allSettled`), not serially.
- Per-handler timeout default **5 seconds** (configurable), much tighter than the previously-drafted 30s.

**Why parallel + tight timeout?** CF DO alarms have a hard wall-time budget (~30s on most plans without explicit extension). `handleAlarmFired` runs inside that budget. Per-schedule dispatch (Decision 6 contract) has cross-isolate RPC cost; serial dispatch with N schedules × 30s would blow the wall-time budget after just two stuck handlers. Parallel dispatch bounds total wall-time at `max(per-handler timeouts)` regardless of N. A 5s default is short enough that even a runaway handler can't consume the whole alarm budget.

**Why 5s default not 30s?** A schedule handler doing real work (read state, decide whether to skip/override) should complete in well under a second. 5s is generous headroom. The timeout's purpose is to bound the worst case, not to accommodate slow handlers — slow handlers should run their work async via spine and return quickly. Configurable per-bundle if a specific use case justifies more.

**Why awaited (vs fire-and-forget)?** The static brain's contract gives `onScheduleFire` control over whether the schedule fires and what prompt it fires with. Functional parity requires the bundle's `onAlarm` to have the same control.

**`onSessionCreated` and `onClientEvent` are observation-only.** Their return type is `void | Promise<void>`. Static `onSessionCreated` is also observation-only (no return that influences dispatch). Bundle parity preserved. These remain fire-and-forget since they have no return-value contract to honor.

**Alternative considered.** *Serial dispatch with 30s timeout.* Rejected: blows DO alarm wall-time budget on multi-stuck-handler wakes.

**Alternative considered.** *Single batched `/alarm` dispatch with `dueSchedules: Schedule[]`.* Rejected: breaks the per-schedule `{ skip, prompt }` return semantics — the response would have to be `Schedule[]→{skip,prompt}` map or an indexed array, which is a more complex contract than per-schedule dispatch and harder to type.

### Decision 7 — `BundleMetadata.lifecycleHooks` is build-time-static; host skips dispatch when undeclared.

`defineBundleAgent` populates `lifecycleHooks: { onAlarm, onSessionCreated, onClientEvent }` from setup field presence. The host reads this declaration at dispatch time and skips Worker Loader instantiation when the relevant field is false.

**What about conditional registration?** A bundle author writing `setup.onAlarm = condition ? handler : undefined` resolves to `undefined` at `defineBundleAgent` call time, which produces `lifecycleHooks.onAlarm: false`. This is structurally equivalent to "the bundle has no `onAlarm`." If `condition` is dynamic per-turn, the bundle author should write `onAlarm: async (env, ctx) => { if (!condition) return; /* ... */ }` — the metadata declares "I have an `onAlarm`," the handler decides per-fire whether to act.

**Alternative considered.** *Always dispatch; let the bundle's stub return `{ status: "noop" }`.* Rejected: still pays Worker Loader cost. Build-time gate strictly better.

### Decision 8 — Lifecycle context excludes `hookBridge` for semantic, not security, reasons.

Lifecycle handlers receive event-scoped contexts (`BundleAlarmContext`, `BundleSessionContext`, `BundleClientEventContext`) with `spine: BundleSpineClient` and event-specific fields. The full `BundleContext` (with `kvStore`, `scheduler`, `channel`, `hookBridge`) is NOT supplied.

**Why exclude `hookBridge`?** Not because the token can't authorize it — the lifecycle dispatch token has the same `["spine", "llm", ...catalogIds]` scope as the turn token (Decision 11), so `hookBridge.recordToolExecution` would technically authorize. The reason is semantic: the bridge's methods (`processBeforeInference`, `recordToolExecution`, `processBeforeToolExecution`) are *turn-loop concepts*. Firing `recordToolExecution` from `onAlarm` would generate a phantom tool-execution event host-side with no real tool to attribute it to. `processBeforeInference` from `onSessionCreated` has no inference call to mutate. The hook bridge belongs to the turn loop; lifecycle hooks fire outside it.

**Why include `spine`?** Lifecycle handlers legitimately want to write session entries (`onSessionCreated` seeding state), broadcast events (`onClientEvent` reflecting back), or read KV (`onAlarm` checking state). The spine client covers these without exposing the turn-loop-only bridge.

### Decision 9 — `BundleContext.activeMode` is a thin identity (id + name only).

```ts
export interface BundleContext {
  // ... existing fields ...
  activeMode?: { id: string; name: string };
}
```

**Why thin?** Defense in depth — bundle code that knew the mode's allow/deny lists could in principle bypass them by calling tools by raw name. Filter is enforced host-side; bundle gets the post-filter result + the mode identity for branching/telemetry.

**Why include `name`?** Convenience for telemetry/UI. The id is sufficient for branching but the name shows up in user-facing strings.

### Decision 10 — `SpineCaller.activeModeId` is NOT added in this proposal.

Earlier draft proposed adding `activeModeId?: string` to `SpineCaller`. Reviewer correctly flagged this as YAGNI — no current spine method consumes it, and adding speculative fields to a security-critical caller context inverts the codebase's restraint default. Drop it.

If a future hook genuinely needs mode-aware behavior at the spine layer, the field can be added with the consumer that needs it. Until then, the active mode lives on `BundleContext.activeMode` (where the bundle reads it) and on the dispatcher's local state (where filtering happens).

**Alternative considered.** *Add it now anyway, for symmetry.* Rejected per YAGNI.

### Decision 11 — Lifecycle dispatch token uses the same scope shape as `/turn`.

Mints `__BUNDLE_TOKEN` with `scope: ["spine", "llm", ...catalogIds]` derived from the validated catalog. Same shape as turn dispatch.

**Why same shape?** Lifecycle handlers are bundle code running with the same authority as turn code. Differentiating per-dispatch path would multiply the token-mint surface. An `onAlarm` that wants to call the LLM (e.g., to summarize) shouldn't be artificially blocked.

### Decision 12 — Bundle prompt-section cache is version-keyed: `bundle:prompt-sections:<sessionId>:v=<bundleVersionId>`.

The earlier draft used `bundle:prompt-sections:<sessionId>` and acknowledged version-staleness as an Open Question. Reviewer correctly flagged that a stale snapshot from a previous bundle version is *misleading* for inspection (the user is debugging what the model sees now, not what it saw before the redeploy). Version-key the cache so inspection only returns sections that match the active bundle version.

**Eviction:** session-delete path deletes all keys with the session's prefix. Old-version keys after a bundle redeploy linger until session deletion — bounded by `O(active_sessions × bundle_version_history)` which is small; not worth a TTL today. Documented for follow-up if it accumulates.

### Decision 13 — Phase 3 ships without an opt-in flag, but with a one-time runtime warning per (agent, bundle version).

The CLAUDE.md "v1.1 follow-up" note is the public commitment that bundle dispatch will become mode-aware. Anyone with `modes` registered + bundle wired today depends on the documented v1 limitation; removing the limitation is the change. No `modesAware?: boolean` flag.

**Why not opt-in?** An opt-in flag is a compat shim. Per CLAUDE.md "Delete old APIs, don't add compat shims." If the behavior shift surfaces a regression for someone, that's a release-note conversation, not a permanent flag in the API.

**Mitigation: one-time runtime warning** (task 5.6a). The first time a given `(agentId, bundleVersionId)` pair dispatches under an active mode, the host emits a structured warning log listing which tools and sections were filtered out vs the bundle's full inventory. A small persistent flag in DO storage (`bundle:mode-warning-emitted:<agentId>:<bundleVersionId>`) prevents spam — one warning per agent per bundle version. Operators tailing logs after the upgrade see immediately which bundles are now filtering and which capabilities/tools they lost. Cheap insurance without entrenching the wrong default.

**Alternative considered.** *Ship Phase 3 behind `defineBundleAgent({ modesAware: true })` defaulting to false in v0.x.* Rejected: contradicts the no-shims stance and entrenches the wrong default. The runtime warning is the right shape — it surfaces the change to the people who need to know without making the new behavior opt-in.

**Alternative considered.** *No warning, release note only.* Rejected per the prior reviewer's correct observation that CLAUDE.md isn't a stable URL with versioning, isn't in any consumer's CHANGELOG, and the v1 limitation is a single sentence buried in the bundle section. Release notes are skim-read; a runtime log entry tied to the actual filtering event is harder to miss.

### Decision 14 — `setup.prompt: string` override applies BEFORE mode filtering.

When the bundle's prompt is a verbatim string (Decision 5), capability sections are suppressed BEFORE Phase 3's mode filter runs. The mode filter then operates on an empty section list (string-override path) or the merged section list (default-builder path). This means `excludedReason` for mode-filtered sections only appears on bundles using the default builder; bundles using `prompt: string` see all capability sections marked excluded with reason "Suppressed by setup.prompt: string override" regardless of mode.

**Alternative considered.** *Apply mode filter first, then string-override suppress.* Rejected: incoherent — the string override is "use this exact prompt," which can't honor a partial mode filter. Suppress first, filter later (on an empty list) is the cleaner order.

## Risks / Trade-offs

[Risk] **Phase 0 bundle tool-execution loop is the largest change in the proposal.** Brand-new code path: tool-call parsing per provider, accumulation, dispatch, hook integration, error handling, message round-trip back to the model. Cold paths (e.g., a provider stream that emits tool calls + text in interleaved order) need careful test coverage. → **Mitigation**: Phase 0 lands as two atomic commits — capability/tool resolution first, tool-execution loop second — so the second commit's diff is reviewable in isolation. Provider-specific parsers ship with their own test fixture sets (recorded SSE streams). The basic-agent example smoke tests a bundle agent calling at least one tool from each shape-2 capability end-to-end before Phase 1 begins.

[Risk] **Per-due-schedule alarm dispatch (Decision 6) blowing the DO alarm wall-time budget.** CF DO alarms have a hard ~30s wall-time limit. With per-schedule dispatch and N due schedules, a serial loop with 30s timeouts could blow the budget after just two stuck handlers. → **Mitigation (Decision 6)**: parallel dispatch via `Promise.allSettled` so total wall-time is `max(per-handler timeouts)` not `sum`. Per-handler timeout default 5s (much tighter than initially-drafted 30s) — enough headroom for legitimate handlers, tight enough to bound runaway. Worker Loader instance reuse keeps cold-start cost amortized across the parallel dispatches.

[Risk] **Phase 3 mode-awareness behavior shift.** Any agent with modes registered + bundle wired today gets unfiltered tool/section visibility. After Phase 3 lands, the bundle suddenly sees the filtered set. Anyone who silently relied on bundle-ignoring-modes loses tools mid-deploy. → **Mitigation**: documented v1.1 follow-up in CLAUDE.md is the public commitment. Release note explicitly flags it. basic-agent example exercises a mode-using bundle agent before the change to demonstrate post-change correct behavior. No opt-in flag (per Decision 13). If a user genuinely relied on the v1 limitation, they had a bug — the change surfaces it.

[Risk] **Bundle-side hook ordering vs host-side hook ordering may diverge under mutation.** A `beforeInference` hook on a bundle-side capability mutates the message stream; the host-side bridge then runs host-registered `beforeInference` hooks against the bundle-mutated stream. The reverse never happens. → **Acceptable**: matches the documented "registration order" rule applied at the bundle/host boundary. Bundle-side hooks are part of the bundle's capability registration; host-side hooks are separate registration. Order is "bundle's set, then host's set" which is unambiguous.

[Risk] **Lifecycle hook handler can throw and disappear into telemetry.** `onSessionCreated` and `onClientEvent` are fire-and-forget (Decision 6). A broken handler logs but doesn't bubble. → **Mitigation**: structured error log with bundle id + version + handler + message. Workshop test path can exercise lifecycle handlers via a mock event source. basic-agent smoke fires each lifecycle hook with both happy-path and intentional-throw cases and verifies the structured error log.

[Risk] **`onAlarm` awaited path couples host alarm latency to bundle handler latency.** Even with parallel dispatch (Decision 6), a single stuck handler holds its slot for the full timeout. → **Mitigation**: 5s per-handler timeout default (revised down from 30s after reviewer feedback). On timeout, treat as `{}` (no skip, no prompt override) and continue the schedule's normal dispatch. Matches static `onScheduleFire` in semantic effect — slow handler doesn't get the schedule cancelled, just doesn't get to influence the prompt.

[Risk] **Bundle prompt-section cache write per turn consumes DO storage.** One `spine.recordPromptSections` call per turn writing rendered `PromptSection[]`. Bounded by per-turn frequency × prompt size. → **Mitigation**: version-keyed cache (Decision 12) prevents accumulation across versions. Per-session-per-version single key — bounded by `O(active_sessions × bundle_version_history)`. If pressure surfaces, move to KV with TTL (deferred until measured).

[Risk] **Tool-call parser drift between providers.** OpenAI/OpenRouter and Anthropic tool-call formats diverge; new providers may add new shapes. → **Mitigation**: parsers are small (~150 lines each) and well-tested with recorded SSE fixtures. New providers add new parsers with their own fixtures. Same maintenance burden as the existing text-delta extraction.

[Trade-off] **Bundle SDK ships its own tool-call parsers (Decision 3).** Couples bundle SDK to provider format quirks. → **Acceptable**: the alternative (importing pi-agent-core) doesn't work in the bundle isolate. Narrow parsers in bundle SDK is the right division of labor; tracks the same constraint that drove text-delta extraction in v1.

[Trade-off] **Per-phase atomic commits = N edits to shared files.** `runtime.ts`, `define.ts`, `types.ts`, `agent-do.ts`, `dispatcher.ts` all touched in multiple phases. → **Acceptable**: phase atomicity is more valuable than commit-isolation per file. Reviewers see one phase at a time; conflicts within a phase are author's problem to resolve before opening the next.

[Trade-off] **`BundleClientEvent` shape is loosely typed (Open Question).** The discriminated union `{ kind: "steer" | "abort" | string, payload: unknown }` is a sketch. → **Acceptable**: tighten at implementation against what the host actually sends. Spec scenarios cover steer + abort explicitly; future event types are additive.

## Migration Plan

No data migration. Four phases, deployed in order. Each phase additive against the codebase as it stood at the start of the phase.

**Per-phase sequence:**

1. **Phase 0 — capability + tool execution.** Two commits:
   - Commit A: `runBundleTurn` invokes `setup.capabilities(env)` and `setup.tools(env)`, builds merged section list (string override rule applied), preserves text-only fast path when both empty. Capability prompt sections splice into the default-builder output. No tool execution yet.
   - Commit B: tool-execution loop with per-provider parsers, hook bridge integration (`processBeforeToolExecution` + `recordToolExecution`), bundle-side hook firing, multi-turn until stop reason. basic-agent smoke exercises Tavily's `web_search` end-to-end.
2. **Phase 1 — PromptSection.** One commit: widen `BundleCapability.promptSections` return type, host-side normalization to full `PromptSection[]` with source attribution, version-keyed inspection cache, two new spine methods. basic-agent smoke verifies inspection panel renders bundle-contributed sections with source pills.
3. **Phase 2 — Lifecycle hooks.** One commit: three setup fields, `BundleMetadata.lifecycleHooks` declaration, three real handler implementations, host wiring per-due-schedule for `/alarm` with `{ skip, prompt }` return support, per-session-create for `/session-created`, per-event for `/client-event`. basic-agent smoke exercises each hook with happy-path and intentional-throw cases.
4. **Phase 3 — Mode-aware dispatch.** One commit: bundle dispatcher resolves `activeModeId`, runs `filterToolsAndSections`, composes filtered env, populates `BundleContext.activeMode`. basic-agent smoke demonstrates a mode-using bundle agent.

**Rollback per phase**: revert the corresponding commit(s). Each phase independent. Phase 3 rollback restores the v1 "modes don't apply to bundles" limitation — safe but degraded correctness. Phase 0 rollback degrades all bundle agents to text-only — should not be needed once the loop is tested, but possible.

**Cross-deploy safety**: bundles built before any phase lands are unaffected. After Phase 0, an old bundle without `setup.tools` or `setup.capabilities` follows the existing text-only fast path. After Phase 2, an old bundle without `lifecycleHooks` in metadata receives no host-driven dispatches to those endpoints. After Phase 3, an old bundle in a mode-registered agent suddenly sees filtered tools — release note is the only mitigation.

## Open Questions

- **`BundleClientEvent` exact shape.** Phase 2 task 4.3 confirms the discriminated union against transport's actual client-event payload type. Spec scenario locks in at minimum a representative `{ kind: "steer", payload: {...} }` shape; future event kinds are additive.
- **Tool-call concurrency within a turn.** Task 2.11 scope-bounds the audit (1 day to evaluate extracting pi-agent-core's sequencing logic; if not extractable, ship Phase 0b with sequential-only execution and file a follow-up).
- **Vendoring pi-agent-core's tool-call parsers.** Task 2.0 scope-bounds the evaluation (1 day). Outcome documented in the commit message.
- **Per-turn tool-call cap.** Static brain has implicit caps via the spine budget's `"hook_after_tool"` category (added in shape-2). Bundle's loop respects the same cap because every tool call hits `recordToolExecution`. Confirm cap defaults are sufficient for typical multi-tool turns at implementation.
- **Bundle `onAlarm` + static `onScheduleFire` interaction**: when both fire for the same schedule and both return `{prompt: ...}`, who wins? Spec requirement added. Working assumption: bundle's return wins (bundle is the runtime brain; static is the host-side hook). Confirm in Phase 2 implementation.
- **Mode-aware subagent dispatch verification.** Task 5.8 audits the subagent dispatch path; confirm the same mode-resolution-and-filter steps apply or implement them.
- **`BundleCapability.configSchema`**: task 5.5.4 keeps the field with a `@deferred` JSDoc note pending a future `bundle-config-namespaces` proposal. Removing it would be a breaking type change for any forward-looking bundle author.
- **Inspection-panel UI updates** to render bundle prompt sections with source-pill components. Not part of this proposal; captured as follow-up.
