## Why

When a bundle runs inside a Worker Loader isolate, its brain-facing tool surface depends on two disjoint halves: the bundle-side clients it imports (e.g. `tavilyClient` from `@crabbykit/tavily-web-search/client`) and the host-side services that actually carry credentials and do the work (e.g. `TavilyService`, a `WorkerEntrypoint` bound into the host worker's `wrangler.jsonc`). The bundle author ships the first half inside their bundle; the worker operator ships the second half as a deploy-time binding.

There is currently no declaration, no validation, and no error story for when these two halves disagree. Concretely:

1. A bundle author publishes a version whose `capabilities()` factory returns `tavilyClient({ service: env.TAVILY })`. The bundle is byte-valid, tree-shakes cleanly, passes workshop smoke tests, and promotes to active.
2. The deployment it lands in has no `TAVILY` service binding in `wrangler.jsonc` — either the operator forgot, or the binding was renamed, or the bundle is running in a staging worker that never had that capability wired.
3. The first turn dispatches. Worker Loader constructs the bundle env by calling `config.bundleEnv(env)`; if the operator's `bundleEnv` factory doesn't spread `env.TAVILY` (because it isn't there to spread), `env.TAVILY` in the isolate is `undefined`.
4. The LLM calls `web_search`. The bundle's tool handler does `options.service.search(token, args)`. `options.service` is `undefined`. A `TypeError: Cannot read properties of undefined (reading 'search')` escapes the tool, propagates up the bundle's turn loop, and emits as a generic tool-error event with no useful signal. No client-visible message points at a missing binding. No bundle-level context says "this version needs Tavily and Tavily isn't here."

This fails silently-ish — the turn fails, but the operator sees a JavaScript type error in a minified bundle, not a deployment-integrity error. It also fails per-turn indefinitely: the pointer stays active, each turn reproduces the same error, and the existing auto-revert-after-N-load-failures path doesn't trip because the bundle *loaded* fine, it just couldn't do useful work.

This proposal introduces a capability catalog: the bundle declares which host-side capabilities it requires, and the host validates that declaration against its registered capabilities. Validation runs at pointer-flip time (inside `BundleRegistry.setActive`) and as a dispatch-time guard for out-of-band mutations. A mismatch disables the bundle with an error that names both the missing capability id and the bundle version that declared it. Static fallback takes over; the next turn runs on the static brain as if no bundle had been promoted.

The catalog is also a prerequisite for several in-flight follow-up proposals. A unified bundle capability token scheme needs to know which per-service subkeys to mint. A typed `ctx.capabilities.tavily.search(...)` surface needs the declaration to drive type narrowing. Neither is designed here; the catalog just makes both buildable.

## What Changes

- **New authoring field: `requiredCapabilities` on `BundleAgentSetup`.** The setup passed to `defineBundleAgent` gains `requiredCapabilities?: BundleCapabilityRequirement[]`. Each requirement is `{ id: string }` — just the id. `id` is a host-side capability identifier (matching a host `Capability.id` — kebab-case, e.g. `"tavily-web-search"`).

  ```ts
  export default defineBundleAgent({
    model: () => ({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4" }),
    requiredCapabilities: [
      { id: "tavily-web-search" },
      { id: "file-tools" },
    ],
    capabilities: (env) => [tavilyClient({ service: env.TAVILY })],
    prompt: { agentName: "Helper" },
  });
  ```

  The name `requiredCapabilities` (not `capabilities`) avoids collision with the existing `capabilities: (env) => BundleCapability[]` factory on the same setup object. The two sit at different phases: `capabilities` is a runtime factory that needs `env` to bind services; `requiredCapabilities` is a static build-time declaration that must be extractable without running any bundle code. They can't be merged without changing the factory shape, which is out of scope.

- **Declaration is persisted into bundle metadata as records.** `BundleMetadata` gains `requiredCapabilities?: BundleCapabilityRequirement[]`. **The existing `BundleMetadata.capabilityIds: string[]` field is NOT repurposed.** That field is vestigial — declared in `bundle-sdk/src/types.ts:110` and `bundle-registry/src/types.ts:38`, written by the D1 sanitizer, but with zero downstream readers. The hundreds of `capabilityIds` grep hits in the codebase all refer to the *unrelated* `CapabilityHookContext.capabilityIds` at `agent-runtime/src/capabilities/types.ts:24` (a runtime field carrying "capability ids currently registered on the agent"). Despite the name collision, the two fields have no shared code. Repurposing the vestigial `BundleMetadata.capabilityIds` would reuse a name that grep-collides with an unrelated concept, inviting future confusion. Better: add a well-named `requiredCapabilities` field and leave the vestigial one in place (a follow-up change can remove it cleanly). Consumers needing the id-only projection call `meta.requiredCapabilities?.map(r => r.id) ?? []` at the call site.

  `defineBundleAgent` copies `setup.requiredCapabilities` into `BundleMetadata.requiredCapabilities` verbatim. Workshop build surfaces this via the bundle's `/metadata` endpoint; the registry persists it into `BundleVersionMetadata` at `workshop_deploy` time.

- **Primary validation: at pointer flip inside `BundleRegistry.setActive`.** Every path that flips the active pointer — workshop_deploy, admin RPC, test harness, `dispatchClientEvent` auto-revert — goes through `setActive`. Putting validation there catches every promotion at its source.

  ```ts
  // BundleRegistry
  setActive(agentId: string, versionId: string | null, options?: SetActiveOptions): Promise<void>;

  interface SetActiveOptions {
    rationale?: string;
    sessionId?: string;
    /** Skip catalog validation. For cross-deployment promotions where the
     *  source host's capability set is not authoritative. */
    skipCatalogCheck?: boolean;
    /** Opaque accessor for the known-id set the registry validates against. */
    knownCapabilityIds?: string[];
  }
  ```

  When `versionId` is non-null and `skipCatalogCheck` is not set, the registry reads the version's metadata, computes `missing = requiredIds - knownIds`, and if `missing` is non-empty, throws `CapabilityMismatchError` before flipping the pointer. The pointer stays at its previous value. The caller surfaces the error.

- **Dispatch-time guard for out-of-band mutations.** A `dispatchTurn` preflight check compares `validatedVersionId` to `activeVersionId`; mismatch re-validates via `getVersion(versionId)` against the current host's known ids. This covers paths that bypassed `setActive` (direct DB writes, schema migration scripts, misbehaving integrations). Immediate disable on mismatch at this layer — reuse of `maxLoadFailures` is not appropriate because the set of registered capabilities does not change between turns within the same DO lifetime.

- **Cross-deployment propagation race: handled at `setActive`, not in the dispatcher.** A `wrangler deploy` that changes both bindings and bundle promotion atomically calls `setActive` from code that has already loaded the new bindings — `knownCapabilityIds` reflects the new state. The CF propagation race happens at an isolate-boot layer below `setActive`, so validation-at-setActive is insulated from it.

- **Failure mode: throw at `setActive`, immediate disable at dispatch-time guard.** Two entry points, two shapes:
  - `setActive` throws `CapabilityMismatchError` — promotion doesn't happen, pointer unchanged, caller sees the error inline. Workshop / admin tools surface it; operators see "promotion rejected: capability 'tavily-web-search' not bound." The bundle is never activated, so there's nothing to revert.
  - Dispatch-time guard calls `registry.setActive(agentId, null, { rationale, sessionId, skipCatalogCheck: true })` to atomically clear the pointer (skipping re-validation since we're clearing to null), writes `null` to cache, broadcasts `bundle_disabled`.

  Neither path touches the existing `maxLoadFailures` counter. A catalog mismatch is deterministic for the current DO lifetime; retries buy nothing.

- **Unknown capability ids rejected.** If a bundle declares `{ id: "fqbhjweq" }` — a typo, a nonexistent capability, a future capability not yet deployed — it's in `requiredIds` but not in `knownIds`, so it's a mismatch. No fuzzy match, no warn-but-continue.

- **Input validation on the declaration.** `requiredCapabilities` is operator input (from a bundle author). `defineBundleAgent` validates each entry: id must match `/^[a-z][a-z0-9-]*[a-z0-9]$/` (kebab-case, 2+ chars), total list length capped at 64 entries. Invalid declarations throw at build time with a clear error. This prevents a malicious or buggy bundle from injecting, say, a null-byte id that confuses downstream consumers.

- **Client-facing error shape.** The `bundle_disabled` broadcast event (used by manual disable and auto-revert today) gains an optional structured `reason` field: `{ code: "ERR_CAPABILITY_MISMATCH", missingIds: string[], versionId: string }`. Additive; legacy consumers read only `rationale` and see no shape break.

- **`workshop_deploy` cross-deployment escape hatch.** The tool gains a `--skip-catalog-check` flag (or equivalent argument) that passes `skipCatalogCheck: true` to `setActive`. Use case: an operator knows the target deployment has the required bindings even though the workshop host doesn't. Default behavior is strict (catalog-check enforced); opting out is explicit.

- **Static fallback stays static.** Because a catalog mismatch either prevents promotion (setActive path) or clears the pointer before dispatch (guard path), there is no partial-capability dispatch. A mismatched bundle is never run.

## Capabilities

### Added Capabilities

- **`bundle-capability-catalog`** — declares the capabilities a bundle requires, validates them against the host's registered capabilities at pointer-flip time (primary) and as a dispatch-time guard (backup). Ownership:
  - `@crabbykit/bundle-sdk` owns the declaration authoring surface and build-time input validation.
  - `@crabbykit/agent-runtime` owns the `BundleRegistry` interface (at `src/bundle-config.ts`) and therefore owns the widened `SetActiveOptions` that carries catalog-validation fields. It also owns the `getBundleHostCapabilityIds()` method on `AgentRuntime` / `AgentDO`.
  - `@crabbykit/bundle-registry` implements catalog validation inside `D1BundleRegistry.setActive` against the interface owned by agent-runtime, and hosts the shared `validateCatalogAgainstKnownIds` helper.
  - `@crabbykit/bundle-host` implements catalog validation inside `InMemoryBundleRegistry.setActive` and contributes the dispatch-time guard inside `BundleDispatcher`.

### Modified Capabilities

- **`agent-bundles`** — pointer-flip validation is part of the bundle-dispatch lifecycle; the `bundle_disabled` event payload widens; the `maxLoadFailures` auto-revert mechanism is clarified to apply only to transient load failures, not catalog mismatches.

### Removed Capabilities

None.

## Impact

- **Modified packages**:
  - `packages/runtime/bundle-sdk/` — `BundleAgentSetup` gains `requiredCapabilities?: BundleCapabilityRequirement[]`. `BundleMetadata` gains the same field. `defineBundleAgent` populates and input-validates it. Exports `BundleCapabilityRequirement`; re-exports `CapabilityMismatchError` from `@crabbykit/agent-runtime` (the class is owned by agent-runtime, which owns `BundleRegistry` — see agent-runtime bullet below).
  - `packages/runtime/agent-runtime/` — owns the `BundleRegistry` interface. Widens it by promoting the inline `setActive` option type into a named `SetActiveOptions` and adding `skipCatalogCheck?: boolean` + `knownCapabilityIds?: string[]`. Adds `getBundleHostCapabilityIds()` to `AgentRuntime` and a delegating method on `AgentDO`. Widens the `bundle_disabled` event type's `data` payload with the optional structured `reason`.
  - `packages/runtime/bundle-registry/` — migrates `D1BundleRegistry.setActive` to the new `SetActiveOptions` shape. Renames / relocates the existing `SetActiveOpts` interface: the authoritative option type becomes `SetActiveOptions` owned by `agent-runtime/src/bundle-config.ts`; `bundle-registry/src/types.ts` stops declaring its own copy and re-exports the widened type for backward compat with existing imports. Adds `validateCatalogAgainstKnownIds` helper at `src/validate.ts`.
  - `packages/runtime/bundle-host/` — `InMemoryBundleRegistry.setActive` implements the new contract. `BundleDispatcher` gains `getHostCapabilityIds: () => string[]` callback at construction, a `validatedVersionId` cache, a `dispatchTurn` preflight guard, and a `disableForCatalogMismatch` path that calls `setActive(..., null, { skipCatalogCheck: true })` and broadcasts the widened event.
  - `packages/runtime/agent-workshop/` — `workshop_build` emits an advisory warning when a declared id isn't in the workshop host's capability set. `workshop_deploy` accepts `skipCatalogCheck` / equivalent arg; without the flag, it passes `knownCapabilityIds` and default-strict behavior to `setActive`, so promotion fails loud on mismatch. Test helpers at `src/__tests__/test-helpers.ts` that imported `SetActiveOpts` from `bundle-registry` migrate to the new `SetActiveOptions` type.
- **Unchanged packages**:
  - `packages/runtime/bundle-token/` — unchanged.
  - Individual capability packages — unchanged. Their `id` values match whatever string bundles declare.
- **Wire-format changes**: `BundleMetadata.requiredCapabilities` is additive; older bundle versions without the field still validate (empty declaration = no requirements). The `bundle_disabled` event's `reason` field is additive.
- **Security posture**: strengthened. Declaration entries go through input validation at `defineBundleAgent` time (shape, charset, length), preventing malformed ids from entering metadata. Validation does not expose new attack surface — the registry compares string sets and throws structured errors.
- **Observability improvement**. Today a catalog mismatch surfaces as a generic tool-error event deep inside a turn. After this change, it either prevents promotion (operator sees it at deploy time) or surfaces as a `bundle_disabled` event with a structured reason naming the missing capability.
- **Hot-path cost**: one `getVersion` read per pointer flip, which the auto-rebuild path already does today (`packages/runtime/agent-runtime/src/bundle-config.ts:65`). Caching the result across both consumers is a follow-up optimization; v1 reads twice. Per-turn cost is unchanged (validation is cached on `validatedVersionId`).
- **Out of scope**:
  - A typed `ctx.capabilities.tavily.search(...)` bundle-side surface. Separate proposal.
  - Shape-2 rollouts for `file-tools`, `vector-memory`, `skills`, `browserbase`. Separate per-capability proposals.
  - Unified bundle capability token scheme. Explicit dependency: that proposal consumes the declaration introduced here.
  - A `hostCapabilityIds` resolver on `BundleConfig` for service-only capabilities. No current consumer exists (every shape-2 capability today registers a static `Capability`). When the first service-only capability lands, its proposal introduces the resolver. YAGNI for v1.
  - Capability version matching. The `version` field was dropped from `BundleCapabilityRequirement` in this proposal — any version discriminator is the responsibility of the capability id itself (e.g. `tavily-web-search-v2`) or a follow-up proposal with actual semantics.
  - Mode-aware catalog declarations. Follow-up.
  - Workshop lint for declaration-vs-import drift.
  - Shared `getVersion` cache across auto-rebuild + catalog validation paths. Follow-up optimization.
- **Depends on**: `split-agent-bundle-host-and-sdk` having landed. No other ordering constraint.
- **Unblocks**: unified-bundle-capability-token, typed-capability-client-surface.
- **Risk profile**: low. Change is additive on the authoring side (empty declaration = current behavior), confined to three well-scoped additions (registry `setActive` option, dispatcher guard, event payload field). The only behavior change for a deployed bundle is: if it declares capabilities that aren't bound, promotion now fails loud instead of silently breaking turns.
