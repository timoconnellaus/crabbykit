## Context

`tavily-web-search` is the only existing shape-2 capability. Its layout (`index` + `service` + `client` + `schemas` subpaths, `WorkerEntrypoint` host class with HKDF-derived verify subkey, RPC methods that take `(token, args, schemaHash)`, scope-checked verify) is the reference for every other host-side capability that bundles need to call. After `unify-bundle-capability-token` shipped, the security primitive collapsed to a single `__BUNDLE_TOKEN` env field with a `scope: string[]` payload validated against the catalog. `verifyToken(..., { requiredScope: "<id>" })` is the per-capability gate.

A shape-2 split on its own does *not* preserve functional equivalence between static and bundle brains. The host's capability hook bus — specifically `afterToolExecution` (observer) and `beforeInference` (mutator) — fires only against the *host's* tool pipeline. Bundle-originated tool execution and inference happen inside the bundle isolate; the host hook chain never sees them. Capabilities that depend on those hooks for their behavior (vector-memory's auto-reindex, doom-loop-detection's repeat-tool counter, tool-output-truncation's result rewriter, skills' conflict injection) silently no-op for bundle agents. The shape-2 rollout cannot ship without first solving this; otherwise every static→bundle migration of an agent using these capabilities is a regression.

Phase 0 introduces the bridge: bundle SDK runtime calls back into the host via two new spine methods, the host runs its existing hook chains against bundle events, the (possibly mutated) result feeds back into the bundle's loop. With the bridge in place, a bundle agent's `file_write` triggers vector-memory's `afterToolExecution` re-indexing identically to a static agent's `file_write`. A bundle agent's pre-inference message stream passes through tool-output-truncation's `beforeInference` rewriter identically to a static agent's. The functional contract holds; only the runtime shape changes.

The three phases that follow are then mechanical capability splits. Tool counts: `skills` has 1, `vector-memory` has 2, `file-tools` has 9. Binding profiles: `skills` (D1 registry, R2 read), `vector-memory` (R2 read, Vectorize index, Workers AI), `file-tools` (R2 read/write). Phase ordering (skills → vector-memory → file-tools) reflects binding count, not hook count — once the bridge is in place, hook routing is no longer a per-cap design question.

The static (non-bundle) consumer surface is unchanged and must keep working. Bundles are an opt-in second runtime, not a replacement; existing static-brain agents continue to wire `fileTools(...)`, `vectorMemory(...)`, `skills(...)` from each package's `./` (legacy) export and see no behavior difference.

## Goals / Non-Goals

**Goals:**

- **Bundle ≡ static functionally.** A bundle agent and a static agent wired with the same capability set produce equivalent observable behavior for every host capability whose semantics depend on `afterToolExecution` or `beforeInference`. The bundle changes the runtime, not the brain.
- Add a host-hook-bus bridge so the existing hook chains (`afterToolExecutionHooks`, `beforeInferenceHooks` arrays on `AgentRuntime`) fire against bundle-originated events. Reuses the existing hook code; introduces no new hook semantics.
- Add `service`/`client`/`schemas` subpaths to `skills`, `vector-memory`, and `file-tools` so bundles can call their tools via the unified `__BUNDLE_TOKEN` security primitive. Mirror the Tavily reference exactly for the parts that don't need to differ.
- Land the four phases as independently shippable units. Phase 0 first; Phases 1–3 in any order after, with 1→2→3 recommended for binding-count-based de-risking.
- Keep the legacy `index.ts` static factory in each package working unchanged. Bundle and static brains share the same package; consumers pick their wiring.

**Non-Goals:**

- Mode-aware bundle dispatch. Out of scope, belongs in `bundle-runtime-surface`.
- Bridging `onConnect`, `httpHandlers`, `configNamespaces`, `onAction`, `onSessionCreated`, `onTurnEnd`, `onAgentEnd`, `onConfigChange`, `onScheduleFire`. These are either host-pipeline-only (connection lifecycle, session/turn lifecycle, config UI) or expose host-only surfaces (HTTP, UI bridge). The bridge specifically targets the two hooks whose semantics are tied to tool-execution and inference — the only two that affect bundle/static functional equivalence for the capabilities in scope.
- A typed `ctx.capabilities.<id>.<method>(...)` bundle-side surface as an alternative to tool calls. Same out-of-scope as `unify-bundle-capability-token`.
- Cost emission for capabilities that have no paid binding today (`skills`, `vector-memory`, `file-tools`).
- Compatibility shims. Static-brain consumers keep wiring the legacy factory; bundle-brain consumers wire the bundle client. No package-level shim layers either direction.
- Re-implementing hook semantics inside the bundle isolate. The host stays the source of truth for hook execution; the bridge is a round-trip, not a port.

## Decisions

### Decision 1 — Hook bridge runs the existing host hook chains; semantics are preserved verbatim.

`AgentRuntime` already exposes `afterToolExecutionHooks` and `beforeInferenceHooks` arrays. The host's static-pipeline tool execution path iterates these arrays inline. Phase 0 adds two new entry points into the same arrays:

- `AgentRuntime.spineRecordToolExecution(caller, event)`: iterates `afterToolExecutionHooks` against the supplied event, with a `CapabilityHookContext` constructed from the caller's verified `aid`/`sid`/`nonce`. Awaited. Each hook's `Promise<void>` is awaited in registration order (matching the static path's order); errors caught per-hook to prevent one hook failing from breaking the chain (matching static behavior).
- `AgentRuntime.spineProcessBeforeInference(caller, messages)`: iterates `beforeInferenceHooks`, threading `messages` through each hook (each hook returns a possibly-mutated array), in registration order. Returns the final array.

**Why reuse the existing arrays?** Single source of truth. A capability author registers one `afterToolExecution` and it fires for both static and bundle brains. No "this hook is bundle-aware vs static-aware" distinction. No code duplication. No drift between two parallel hook chains.

**Why awaited, not fire-and-forget?** Two reasons. First, `beforeInference` is a mutator — the bundle has to await the result before continuing to the model call. Second, even for `afterToolExecution` (observer), preserving the static path's "hooks complete before the next pipeline step" ordering keeps the per-turn observable timing equivalent. A fire-and-forget bridge for `afterToolExecution` would let the bundle proceed to the next tool before the previous tool's hook completes — a different per-turn order than static, surfacing as race conditions for any hook with state.

**Alternatives considered.**

- *Run hooks bundle-side by porting capability code into the isolate.* Rejected: massive duplication of capability code, breaks the "capability = one factory" invariant, and the isolate cannot hold the bindings hooks need (D1 for skills, Vectorize for vector-memory, R2 etc.). Hooks must execute where their bindings are.
- *Maintain a separate "bundle hook chain" array.* Rejected: drift inevitable, capability authors have to register both, no benefit over the single-array bridge.

### Decision 2 — Bridge is part of the spine surface, scoped under `"spine"`.

`SpineService` exposes the two new methods. They verify the unified `__BUNDLE_TOKEN` with `requiredScope: "spine"`. No new scope string introduced. Rationale: the bridge methods are host-state-touching infrastructure, exactly the role of spine. Every bundle implicitly has `"spine"` in its scope (it's one of the two reserved scopes), so the bridge is callable by any bundle that runs at all — there's nothing to opt into.

**Alternatives considered.**

- *New scope string `"hook-bridge"`.* Rejected: opting out of hooks is not a meaningful choice — a bundle that opts out is silently breaking every hook-dependent capability it uses. The scope would always be present; adding it would be ceremonial.
- *Separate `BundleHookBridgeService` `WorkerEntrypoint`.* Rejected: doubles the wiring (consumers add a second service binding), and the methods naturally belong on spine alongside the other host-state-touching methods (`spineGetEntries`, `spineBroadcast`, `spineEmitCost`).

### Decision 3 — Bridge calls run under a per-turn budget under fresh categories.

The existing `withSpineBudget(caller, category, fn)` wrapper applies. Two new categories: `"hook_after_tool"` and `"hook_before_inference"`. Default caps are conservative (e.g., 100 invocations per turn — generous enough that legitimate use never trips, tight enough that a runaway bundle hits the cap).

**Why?** The bridge crosses the bundle/host boundary on every tool execution and every inference call. A misbehaving bundle that tool-loops at high frequency could pin host CPU running hook chains. The budget makes the failure mode loud (turn-killed) rather than silent (host degradation).

**Alternatives considered.** *Share a single `"spine"` budget category.* Rejected: hides the distinct cost shape of bridge calls vs other spine calls, and a runaway tool loop would consume budget that legitimate `spineGetEntries`/`spineBroadcast` calls need. Separate categories give clean operational signal.

### Decision 4 — Bridge `recordToolExecution` is awaited per call, not batched.

After every tool execution, the bundle awaits `spine.recordToolExecution(token, event)` before proceeding to the next loop step. No batching, no fire-and-forget.

**Why awaited?** Matches static-path ordering (Decision 1). Hooks may have state (vector-memory's indexing, doom-loop-detection's counter) that the next tool execution depends on. Fire-and-forget would let the next tool execute before the previous hook completes — different observable order from static.

**Why not batched?** Batching defers hook execution until N tools have run, which defeats the "hooks fire between tools" contract. A capability that uses `afterToolExecution` to influence subsequent tool selection (none today, but architecturally permitted) would silently behave differently in a batched bundle.

**Trade-off accepted**: per-tool RPC overhead. For tool-heavy turns this is real. The budget cap (Decision 3) bounds the worst case; the proposal does not propose batching as a mitigation because batching breaks ordering.

### Decision 5 — Bridge `processBeforeInference` is mutator-aware; bundle must use the returned message array.

`beforeInference` hooks are signed `(messages, ctx) => Promise<AgentMessage[]>` — they return a possibly-mutated array. The bundle SDK runtime's inference loop calls `messages = await spine.processBeforeInference(token, messages)` and uses the returned array as input to the model call. If the returned array differs from what the bundle sent (e.g., `tool-output-truncation` rewrote a tool result message), the bundle uses the new array verbatim.

**Why JSON serialization round-trip?** `AgentMessage[]` is already JSON-serializable per the existing static-path contract. The hook chain operates on the deserialized form host-side; the result re-serializes for the return trip. Cost is one JSON parse + one stringify per inference call. Acceptable next to the LLM call cost.

**Alternative considered.** *Bundle-side hook re-implementation.* Rejected: capability code lives in one place. A capability ships its hooks once and they fire for both brains; re-implementing inside the bundle would mean every hook author writes (and tests) two implementations.

### Decision 6 — Bridge errors are sanitized but propagate; bundle decides how to recover.

`SpineService.sanitize` is the existing error-sanitization path. Bridge methods route through it. A hook that throws surfaces to the bundle as a sanitized error; the bundle's runtime decides whether to abort the turn, retry, or continue. The default Phase 0 behavior is **continue**: a bridge call failure logs and proceeds, on the principle that hooks are observers/refinements, not gating policy. A capability that wants to fail-the-turn on its hook erroring would surface that as an explicit hook return convention (out of scope for Phase 0).

**Why continue rather than fail?** Static-path hooks already swallow per-hook errors (Decision 1 reuses that behavior). The bridge preserves the same semantics: one bad hook doesn't break the turn. Fail-on-hook-error is a different policy decision and would change static behavior too.

### Decision 7 — Tools cross the bundle boundary; lifecycle and host-only hooks stay host-side.

For Phases 1–3, every shape-2 capability has the same shape: a `service` (host `WorkerEntrypoint`) holding bindings + verifying tokens + executing the tool body, a `client` (bundle-side `Capability`) exposing the tools by name with thin RPC stubs, and a static `index.ts` preserving the existing host-side capability for non-bundle agents. Hooks on the static capability are unchanged.

The two hooks the bridge covers (`afterToolExecution`, `beforeInference`) fire against bundle events automatically. Other lifecycle hooks (`onConnect`, `onSessionCreated`, `onTurnEnd`, `onAgentEnd`, `onConfigChange`, `onScheduleFire`) are host-pipeline-only by nature — they fire on connection lifecycle, session lifecycle, etc., which the bundle does not have its own copy of. `httpHandlers`, `configNamespaces`, and `onAction` expose host-only surfaces (HTTP routes, config UI, UI bridge) that the bundle cannot reach into. All of these stay on the static capability and behave identically whether or not a bundle brain is also wired.

**What the bundle client returns:**

- `skills` bundle client: 1 tool (`skill_load`). No hooks. No prompt section (the static one reads cached state populated by `onConnect`, which has no bundle equivalent; if a future bundle wants the section it builds it from a service RPC).
- `vector-memory` bundle client: 2 tools (`memory_search`, `memory_get`). No hooks. Content-only `promptSections` describing the memory system (the section text is identical to the static one — auto-reindexing is true now via the bridge).
- `file-tools` bundle client: 9 tools. No hooks.

### Decision 8 — File-tools UI broadcast comes through the static capability's hook firing via the bridge.

Earlier draft proposed `FileToolsService.write` calling `spine.broadcastGlobal` directly to emit `file_changed` to the UI. With the Phase 0 bridge in place, this is unnecessary. The static `fileTools(...)` capability's existing `broadcastAgentMutation` (`afterToolExecution` hook) fires automatically against the bundle's `file_write`/`file_edit`/`file_delete`/`file_copy`/`file_move` events. Same UI wire format, same code path, no per-method spine call inside the service.

The service stays a pure RPC executor: verify, do the R2 operation, return the result. The hook bus handles the broadcast.

### Decision 9 — Each `service` lazily derives + caches the verify subkey on the entrypoint instance.

Same pattern as `TavilyService.getSubkey()`. `subkeyPromise: Promise<CryptoKey> | null` on the entrypoint, populated on first call via `deriveVerifyOnlySubkey(env.AGENT_AUTH_KEY, BUNDLE_SUBKEY_LABEL)`. Cached for the lifetime of the entrypoint instance. `WorkerEntrypoint` recycling resets the cache; the derive is millisecond-scale.

### Decision 10 — Schema drift hash is per-capability, version-string-style, manually bumped.

Each `schemas.ts` exports `SCHEMA_CONTENT_HASH = "<id>-schemas-v1"`. Manually-set version string, bumped by hand when args schemas change in a way that would silently mistype older bundles. Tavily's pattern.

### Decision 11 — `package.json` deps add `@crabbykit/bundle-token` from the start (Phases 1–3).

Tavily missed this dep on its initial landing and had to add it retroactively. Each phase here adds it from the start. The dep is needed in every shape-2 capability because the service imports `verifyToken`, `deriveVerifyOnlySubkey`, and `BUNDLE_SUBKEY_LABEL` from `bundle-token`. The bundle-side client imports nothing from `bundle-token`. Only the service gets the dep.

`bundle-host` is not added as a dep — capabilities only verify, never mint. Mint stays in `bundle-host`. Capabilities depend on `bundle-token`. Direction preserved.

### Decision 12 — Per-tool RPC method, not a single dispatch method.

Per-tool methods on each service (`FileToolsService.read`, `.write`, …) — same as Tavily's `search`/`extract`. Type safety per call. Worse error messages and weaker autocomplete for a unified `dispatch(toolName, args)`.

### Decision 13 — Phase ordering: hook bridge → skills → vector-memory → file-tools.

Phase 0 (hook bridge) lands first because Phases 1–3 depend on it for hook-firing parity. Within 1–3, easiest first by binding count: `skills` (D1 + R2) → `vector-memory` (R2 + Vectorize + Workers AI) → `file-tools` (R2). Smallest first de-risks the pattern; biggest last lands the most code with the most-validated pattern.

### Decision 14 — `examples/basic-agent` wiring is per-phase and demonstrates both static and bundle paths.

Each phase adds a service binding (or, for Phase 0, no new binding — the bridge is invisible to consumers), exports the corresponding `WorkerEntrypoint` from the basic-agent's worker entry, and wires the bundle-client variant in the example's `defineAgent`'s `bundleCapabilities` block. Static factory wiring stays in `defineAgent`'s `capabilities` block.

Phase 0's smoke test exercises the bridge directly: register a no-op `afterToolExecution` hook on a static capability, run a bundle tool, assert the hook ran. Then again with `beforeInference`, assert the message stream was rewritten.

### Decision 15 — `dispatcher.knownCapabilityIds` widening is a consumer concern, not a package concern.

The dispatcher's `validateRequiredCapabilities` accepts a caller-supplied `knownCapabilityIds: Set<string>`. Each consumer (basic-agent today, future agents tomorrow) builds its own set from the capabilities it wires. This proposal does not introduce a global "known capabilities" registry. Per-consumer is the correct level.

## Risks / Trade-offs

[Risk] **Bridge call latency on tool-heavy turns.** `recordToolExecution` is awaited per tool. A turn that runs 50 tools incurs 50 extra RPC round-trips. Round-trip cost is dominated by isolate→DO call latency, ~sub-millisecond in-region but adds up. → **Mitigation**: budget cap (Decision 3) prevents pathological cases; the per-call cost is the price of static-equivalent ordering. If real-world tool-heavy turns surface as slow, a follow-up could explore *batched* bridging with explicit ordering hints — explicitly out of scope here because batching changes ordering semantics.

[Risk] **Bridge `processBeforeInference` JSON round-trip on every model call.** `AgentMessage[]` can be large (long conversations, big tool results). Serializing → RPC → host hook chain → re-serialize → bundle is a non-trivial cost per inference. → **Mitigation**: the cost dwarfs in absolute terms next to the LLM call (which is a multi-second cross-region call); the relative overhead is small. Tool-output-truncation, the prime mutator, *reduces* message size, so the round-trip tends to shrink subsequent calls.

[Risk] **Hook code that closes over host state still works for bundle calls.** Hooks reference DO-local state via `CapabilityHookContext`. The bridge constructs the context from the verified caller. If a hook reads from `ctx.storage` (the `CapabilityStorage` for that capability), the read still goes through the host's storage — same behavior as static. → **Acceptable**: this is the design intent. The hook code is portable across pipelines because the context surface is identical.

[Risk] **Hook fails for bundle event but not static event.** A hook that depends on host-only context shape (e.g., presence of an active WebSocket) might behave differently when the originating event came from a bundle. → **Mitigation**: hooks should be written against the documented `CapabilityHookContext` surface, not against undocumented internal state. The bridge constructs the same context shape; any divergence is a hook-author bug, surfaced loudly via the existing hook error path.

[Risk] **`SCHEMA_CONTENT_HASH` divergence at deploy time.** Host deploys with `"file-tools-schemas-v2"` while a deployed bundle still hashes `"file-tools-schemas-v1"`. Every tool call from that bundle hits `ERR_SCHEMA_VERSION` and fails. → **Mitigation**: hashes bumped manually only on breaking schema changes; bundles content-addressed; catalog dispatch guard catches structurally-stale bundles. Documented in rollout runbook.

[Risk] **Service-binding wiring forgotten by consumer.** Consumer wires `bundleCapabilities: [skillsClient({ service: env.SKILLS_SERVICE })]` but forgets `[[services]] binding = "SKILLS_SERVICE"` in `wrangler.toml`. → **Mitigation**: bundle client throws clear error at `tools()` resolution time if `options.service` is undefined.

[Risk] **Test coverage for cross-isolate paths.** New code crosses bundle/host boundary. Cross-isolate paths tested via `bundle-host` integration tests + basic-agent smoke. → **Mitigation**: each phase's tasks include unit tests on each side and an end-to-end smoke. Phase 0's smoke is load-bearing — assert that hooks fire identically for static and bundle.

[Trade-off] **Two wirings for the same capability per consumer.** Consumer wanting both brains imports two factories per cap (`fileTools` static + `fileToolsClient` bundle). → **Acceptable**: alternative is a single auto-detecting factory that switches on agent shape — couples capability to runtime concern it shouldn't know about.

[Trade-off] **Per-phase consumer wiring changes are unavoidable.** Each phase modifies `wrangler.toml`, worker entry, agent definition. → **Acceptable**: cost of phase atomicity.

## Migration Plan

No data migration. Phase 0 is additive runtime surface; Phases 1–3 are additive package surfaces and consumer wiring. Existing static-brain agents are untouched throughout.

**Per-phase deploy sequence:**

1. Land Phase 0 first. Atomic commit covering SpineHost interface widening, AgentRuntime impl, SpineService new methods, bundle-sdk runtime call sites, and the smoke test asserting bridge correctness.
2. Land Phases 1, 2, 3 in order. Each phase: package-side commit (subpaths + tests + dep update) → consumer wiring commit (wrangler + worker entry + agent definition + smoke test). Two atomic commits per phase.
3. Run full test suite + basic-agent smoke after each commit. Confirm static-brain regressions are zero.

**Rollback per phase**: revert the consumer wiring commit (the package-side subpaths can stay as dead code). For Phase 0, rollback reverts the runtime surface widening — bundle agents lose hook firing again, but no shape-2 caps are deployed yet so no regression beyond pre-Phase-0 state.

**Cross-deploy safety**: bundles built before a Phase 1–3 lands do not declare the new capability id and are unaffected. Bundles built after a phase ships and deployed against a host that hasn't widened `knownCapabilityIds` fail at promotion time with `ERR_CAPABILITY_MISMATCH`. Phase 0 has no bundle-side change required — old bundles call the bridge methods only if they're rebuilt against the new `bundle-sdk`.

## Open Questions

- **Phase 0 hook-error policy.** Decision 6 picks "continue on hook error, log it." A future capability might want fail-the-turn semantics. Out of scope — when that need surfaces, add a hook return convention (e.g., a hook returning `{ abort: true }`).
- **`spineRecordToolExecution` payload size.** Big tool results (e.g., `file_read` of a 500KB file) cross the bundle→host boundary verbatim in the event. Worth sizing in Phase 0 implementation; if pathologically large, add a payload cap with a structured truncation marker the host understands. Likely a non-issue — tool results are already bounded by per-tool limits.
- **Ordering across multiple capabilities' hooks for a single bundle event.** Decision 1 specifies "registration order" matching static. Verify in Phase 0 tests that registration order is preserved end-to-end through the bridge.
- **Vectorize index naming for the `VectorMemoryService` env.** The static capability accepts a `VectorizeIndex` instance via the options object. The service env declares it as a binding name — phase task picks the convention (likely `MEMORY_INDEX`).
- **`spineProcessBeforeInference` — does it run for the bundle's static-system-prompt path too, or only for actual model-call inference?** The bundle has both a static system prompt build phase and per-turn inference. The bridge fires only on per-turn inference (matching the static path's `beforeInference` semantics). Confirm in Phase 0 that the bundle SDK's wrapper hooks the right call site.
- **`SkillsService` registry-vs-storage source-of-truth.** Service reads R2 directly for skill content (per earlier design rationale, applies unchanged). For the installed-skill record (enabled flag + metadata), service reads either the host's `CapabilityStorage` via spine or its own D1 binding. Phase 1 picks one — leaning toward direct D1 read for symmetry with the bridge model (service holds its own bindings, doesn't proxy state through spine for read-only data).
- **Test isolation for `WorkerEntrypoint` services.** Existing Tavily tests use `@cloudflare/vitest-pool-workers`. Same pool. "Unique DO name per describe block" rule applies. Phase tasks include test setup mirroring Tavily's.
