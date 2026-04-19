## The shape of the declaration

`BundleCapabilityRequirement` in v1 is one field:

```ts
export interface BundleCapabilityRequirement {
  /** Capability id, must match a host-registered capability's id.
   *  Kebab-case, charset `/^[a-z][a-z0-9-]*[a-z0-9]$/`, 2+ chars. */
  id: string;
}
```

### Why not a flat string array

```ts
requiredCapabilities: ["tavily-web-search", "file-tools"]
```

Minimum surface, but every future optional field (`optional`, `mode-scoped`, typed-client annotations) forces a rewrite of every authored bundle. The object form adds one character per entry and reserves the shape for growth without migration.

### Why not `version`

The initial draft proposed `version?: string` as "opaque informational." That's noise — an opaque string users will fill with `"1.0"`, `"^1"`, `"latest"`, or whatever they guess, none of which the host interprets. A later proposal that actually uses the field (say, semver matching against `Capability.version`) would have to define semantics retroactively, breaking prior declarations that used any of the above as free-text. Cleaner: drop the field entirely in v1. The proposal that needs version semantics adds the field along with those semantics.

If a capability needs to version-discriminate before that proposal lands, it can encode the version in the id itself (`tavily-web-search-v2`). That pattern is self-documenting and doesn't require a schema change.

### Why not a map keyed by id

`{ "tavily-web-search": {}, "file-tools": {} }` needs empty-object values for the common case. Awkward. Rejected.

## The naming collision — what to call the field

`BundleAgentSetup` already has a `capabilities` slot:

```ts
capabilities?: (env: TEnv) => BundleCapability[];
```

This is a runtime factory: it takes `env` (populated at bundle isolate boot) and returns capability instances. The new declaration needs to be extractable at build time without running any bundle code — the workshop build pipeline reads it, the registry stores it, the host validates from it. These are phase-incompatible:

- `capabilities` is bundle-local, runtime-constructed, env-dependent.
- `requiredCapabilities` is metadata-persistent, build-time-static, env-independent.

Merging them would mean either (a) making `capabilities` a static array of `{id, factory}` records, which is a breaking change across every existing bundle and the interior of every bundle-side client factory, or (b) running the `capabilities` factory at build time with a dummy env to extract ids, which couples build-time correctness to factory purity — a factory that reads `env.FOO?.BAR` to decide which capabilities to return would silently produce the wrong declaration.

Both are worse than a sibling field. The declaration is a separate concept and gets its own slot.

Named candidates:
- `requires` — shortest, but generic ("requires what? env? bindings?").
- `requiredCapabilities` — verbose but unambiguous at the call site.
- `capabilityManifest` — suggests a richer structure than we're building.
- `declaredCapabilities` — conflates "declared in source" with "declared to host."

**Decision: `requiredCapabilities`.** Verbosity pays for clarity.

## Where the declaration lives at runtime

Two paths are available for getting the declaration from bundle source to the host:

### Path 1: Build-time into metadata

`defineBundleAgent` reads `setup.requiredCapabilities` at authoring time and writes it into the returned `BundleMetadata`. The workshop build extracts metadata from the bundle's `/metadata` endpoint and stores it in `BundleVersionMetadata` in the registry. The host reads the metadata row at validation time.

**Pro**: declaration is immutable once promoted. No skew between "bundle declared" and "host validated."
**Pro**: validation can happen without instantiating the bundle isolate.
**Con**: requires the workshop and registry to carry the field end-to-end. One-time migration cost.

### Path 2: Fetch from bundle at validation time

Host loads the bundle via Worker Loader, calls its `/metadata` endpoint, reads the declaration, then proceeds.

**Pro**: declaration is always derived from the deployed bundle's actual code.
**Con**: requires Worker Loader to instantiate the bundle isolate just to validate. Expensive for a preflight check.
**Con**: if the bundle's `/metadata` handler is broken, validation fails for reasons unrelated to the declaration.

**Decision: Path 1.** Declaration is persisted into `BundleVersionMetadata.requiredCapabilities` at `workshop_deploy` time. Host reads from registry metadata. No isolate instantiation required.

## Why we do NOT repurpose `BundleMetadata.capabilityIds`

An earlier draft proposed re-using the existing `BundleMetadata.capabilityIds: string[]` field as the derived id-only projection of the new `requiredCapabilities` records. That field exists in `packages/runtime/bundle-sdk/src/types.ts:110` and `packages/runtime/bundle-registry/src/types.ts:38`, with D1 serialization at `d1-registry.ts:323` and a `METADATA_CAPABILITY_IDS_MAX = 32` invariant enforced by the sanitizer.

**The field has no downstream readers.** Grepping `capabilityIds` in `packages/` returns hundreds of hits, but every non-sanitizer hit is the *unrelated* `CapabilityHookContext.capabilityIds` defined at `packages/runtime/agent-runtime/src/capabilities/types.ts:24`. Those two fields share a name but no owner, no source, and no semantics: the context field is "capability ids currently registered on the agent" (runtime-provided), whereas the metadata field was stubbed as "capability ids declared by the bundle" (bundle-authored) and never wired to anything that reads it. The metadata field is vestigial — a half-laid hook from an earlier design that shipped without the second half.

Given that, two choices:

1. **Revive the vestigial field** by widening it from `string[]` to `BundleCapabilityRequirement[]`. Saves one field but (a) breaks the sanitizer's `string[]` shape, (b) reuses a name that collides with the unrelated `CapabilityHookContext.capabilityIds`, making grep-based navigation misleading, and (c) conflates "capabilities the agent registers" with "capabilities the bundle requires" — even though no code currently confuses them, the name invites future confusion.
2. **Leave the vestigial field in place** and add `requiredCapabilities` as a separate, well-named field. Explicit-is-better-than-implicit; separate fields for separate concerns. The tradeoff is a dead field in the type (cost: one `?` entry, one sanitizer case) until a follow-up cleanup removes it.

**Decision: choice 2.** Add `requiredCapabilities` alongside the vestigial `capabilityIds`. A follow-up change SHOULD delete `BundleMetadata.capabilityIds` (and its sanitizer entries in `d1-registry.ts:323` and `METADATA_KEYS`/`METADATA_CAPABILITY_IDS_MAX`), but that deletion is out of scope here — this proposal deliberately does not touch the existing field so the sanitizer surface is unchanged.

Anywhere the id-only projection is needed, call `meta.requiredCapabilities?.map(r => r.id) ?? []` at the call site — one line, no shared state, no invariant to maintain.

## Where the validation lives on the host

Two integration points, each covering a different set of failure modes:

### Primary: inside `BundleRegistry.setActive`

`setActive` is the single atomic operation that flips the active version pointer. Every path that activates a version — `workshop_deploy`, admin RPC, test harness, `AgentDO` auto-revert, `dispatchClientEvent`-triggered refresh — goes through it. Putting validation inside `setActive` catches every promotion at the source, with no dispatcher guard needed for the common case.

**Interface ownership.** The `BundleRegistry` interface is defined at `packages/runtime/agent-runtime/src/bundle-config.ts:52-58`, NOT in `@crabbykit/bundle-registry` — the split-host proposal moved it there so agent-runtime has no runtime dependency on bundle-host. The interface currently uses an inline option type `{ rationale?: string; sessionId?: string }` for `setActive`'s third parameter. This proposal promotes that inline type into a named `SetActiveOptions` interface exported from `agent-runtime/src/bundle-config.ts` so every implementation (D1BundleRegistry in `bundle-registry/`, InMemoryBundleRegistry in `bundle-host/`) reads the same definition.

**Reconciling the existing `SetActiveOpts` type.** `packages/runtime/bundle-registry/src/types.ts:98-101` declares a `SetActiveOpts` interface with the current `{ rationale, sessionId }` shape. Contrary to the first review's characterization, this type is NOT orphan — it's imported and used by `D1BundleRegistry.setActive` at `d1-registry.ts:18,92`, re-exported from `bundle-registry/src/index.ts:12`, and imported by workshop test helpers at `agent-workshop/src/__tests__/test-helpers.ts:7,69`. The inline option shape on the `BundleRegistry` interface at `agent-runtime/src/bundle-config.ts` and this `SetActiveOpts` are two hand-synchronized declarations of the same contract.

This proposal collapses them into one authoritative declaration:

1. Move the option type to `agent-runtime/src/bundle-config.ts` and rename to `SetActiveOptions` (matches the conventional `*Options` naming the rest of agent-runtime uses — e.g. `PromptOptions`, `A2AClientOptions`).
2. Widen it with the two new catalog fields (`knownCapabilityIds?`, `skipCatalogCheck?`).
3. Delete the local `SetActiveOpts` declaration from `bundle-registry/src/types.ts:98-101`.
4. Re-export `SetActiveOptions` from `bundle-registry/src/index.ts` so existing imports (workshop test helpers, external consumers) continue to work after replacing the local-declaration re-export with a pass-through.
5. Update `d1-registry.ts:18,92` and `agent-workshop/src/__tests__/test-helpers.ts:7,69` to import the new name. These two migrations + the local deletion land in the same commit that introduces the widened type.

After the commit, grep `SetActiveOpts\b` across `packages/` returns zero hits; `SetActiveOptions` is the sole name for the contract.

```ts
// agent-runtime/src/bundle-config.ts
export interface SetActiveOptions {
  rationale?: string;
  sessionId?: string;
  /** Pre-computed set of host-known capability ids. Required for catalog
   *  validation; if omitted and `skipCatalogCheck` is false, setActive
   *  throws to force the caller to make the decision explicit. */
  knownCapabilityIds?: string[];
  /** Skip catalog validation. For cross-deployment promotions, clearing
   *  the pointer (versionId: null), and internal auto-revert paths. */
  skipCatalogCheck?: boolean;
}

export interface BundleRegistry {
  getActiveForAgent(agentId: string): Promise<string | null>;
  setActive(
    agentId: string,
    versionId: string | null,
    options?: SetActiveOptions,
  ): Promise<void>;
  // ...existing getBytes, getVersion, createVersion
}
```

Both `D1BundleRegistry` (in `packages/runtime/bundle-registry/src/d1-registry.ts`) and `InMemoryBundleRegistry` (in `packages/runtime/bundle-host/src/in-memory-registry.ts`) implement the widened signature.

When `versionId` is non-null and `skipCatalogCheck !== true`:

1. Registry reads `getVersion(versionId).metadata.requiredCapabilities`.
2. Registry computes `missing = required.filter(r => !knownIds.has(r.id))`.
3. If `missing.length > 0`, throws `CapabilityMismatchError` — pointer is not flipped.
4. Otherwise flips the pointer as normal.

Clearing (`versionId: null`) always skips the check — there's nothing to validate.

**Atomic caller migration.** Adding a required-when-validating parameter is a breaking change for every existing `setActive` caller. Today the in-tree callers are:

- `bundle-host/src/dispatcher.ts` — `disable()` and `autoRevert()` both clear to `null`, so they pass `skipCatalogCheck: true` (clearing is always safe).
- `bundle-host/src/bundle-builder.ts` — auto-rebuild path promotes a newly-built version, must pass `knownCapabilityIds`.
- `agent-workshop` tools — `workshop_deploy` promotes a new version, must pass `knownCapabilityIds`; `workshop_disable`/`workshop_rollback` use the clearing path or promote to a previous version (which must also pass `knownCapabilityIds`).
- Tests in `bundle-host/src/__tests__/`, `bundle-registry/src/__tests__/`, `agent-runtime/test/integration/`, `agent-workshop/src/__tests__/` — each existing call-site is audited and updated.

Every caller is updated in the same commit that widens the interface. The tree does not pass through an intermediate state where `setActive` exists but callers have not been migrated. No compatibility shim, no "optional with silent fallback to skip." Greenfield explicit-over-implicit: if `knownCapabilityIds` is omitted and `skipCatalogCheck` is not true, the registry throws `TypeError` at the call site — failing loud is better than silently skipping validation on a caller that forgot to opt in. (See CLAUDE.md: "No legacy code" memory — CLAW is greenfield and does not add backward-compat shims.)

**Why throw instead of return a result tuple**: the registry is at a layer where promotion is transactional. An invalid promotion is an error, not a value. Throwing integrates with every caller's existing error handling (workshop tools surface tool errors, admin RPC returns 4xx, test harness fails the test). A result tuple would force every caller to add a branch.

### Secondary: dispatch-time guard in `BundleDispatcher`

Not every pointer mutation goes through `setActive` — direct DB writes, schema migration scripts, misbehaving integrations, and any future code path that bypasses the registry's contract. To defend against these, the dispatcher does a cheap check at the top of `dispatchTurn`:

```ts
if (this.state.activeVersionId && this.state.activeVersionId !== this.validatedVersionId) {
  const result = await this.validateCatalog(this.state.activeVersionId);
  if (!result.valid) {
    await this.disableForCatalogMismatch(result, ctxStorage, sessionId);
    return { dispatched: false, reason: `catalog mismatch: ${result.missingIds.join(", ")}` };
  }
  this.validatedVersionId = this.state.activeVersionId;
}
```

Per-turn cost is one property comparison in the common case (already-validated). On a new version, one `getVersion` registry read — cheap and already done by the auto-rebuild path (`packages/runtime/agent-runtime/src/bundle-config.ts:65`).

`disableForCatalogMismatch` calls `setActive(agentId, null, { skipCatalogCheck: true, rationale, sessionId })` to clear the pointer, then broadcasts the widened `bundle_disabled` event.

## Cold start + host redeploy

A third failure mode sits between "pointer changed via `setActive`" and "pointer mutated out-of-band": the pointer didn't change at all, but the *host* did.

1. Agent's DO cold-starts. Nothing in memory.
2. `hasActiveBundle` reads `ctx.storage.activeBundleVersionId = "v-old"` (the cached pointer from a prior session, written by the previous DO lifetime that validated it).
3. Meanwhile, the host Worker was redeployed with a different capability set. Some capability the bundle declared is no longer bound.
4. The dispatcher's `validatedVersionId` starts `null` in the new DO.
5. First `dispatchTurn` runs: `state.activeVersionId = "v-old"`, `validatedVersionId = null`, so the guard fires. The guard reads the metadata, computes `missingIds` against the *new* host capability set, and disables.

This case is covered by the same guard as out-of-band mutations — the precondition `activeVersionId !== validatedVersionId` is true on any cold start with a non-null cached pointer, regardless of *why* they differ. The guard does not distinguish "pointer changed by out-of-band write" from "dispatcher state lost across isolate boots" because it does not need to: both present identically and both need validation.

The spec calls this out explicitly so the guard's coverage of cold-start scenarios is an invariant, not an accident of implementation.

## The CF deploy propagation race

An adversarial scenario raised during review:

1. Operator runs `wrangler deploy` that updates both a service binding AND the bundle version.
2. Cloudflare's edge propagation publishes the new Worker code before the new service binding is fully visible on every PoP.
3. Some PoP boots the new Worker code against the old binding set for ~5s.
4. The dispatcher in that isolate sees "declared tavily, no tavily bound" and disables.
5. Propagation catches up 5s later. The bundle is now disabled even though the deploy was correct.

This is a real race but a narrow one. The primary validation point (`setActive`) is **not affected**: `setActive` is called from code that already has the new binding set loaded (the operator's deploy-time promotion script, or the newly-deployed Worker calling its own `setActive`), so `knownCapabilityIds` reflects the new state.

The dispatch-time guard **is** affected, but only when the guard fires — which means `setActive` was bypassed. In a correctly-wired deploy, `setActive` runs with the new binding set and the pointer is flipped only if the catalog matches. Subsequent dispatches pick up the already-validated pointer. The race window closes when `setActive` completes.

The narrow case where the guard fires during a propagation race is an out-of-band mutation against a newly-booted isolate. The guard disables; the next deploy or `/bundle/refresh` from a correctly-propagated isolate will re-promote. Accepting this edge case in exchange for the simpler single-path model is the right tradeoff; the guard is a backstop, not the primary check.

## The failure semantics — throw at registry, immediate disable at guard

The existing `BundleDispatcher` has a `maxLoadFailures` mechanism (default 3) that auto-reverts after N consecutive Worker Loader failures. That counter handles **transient** failures: network errors, cold-start hiccups, isolate OOMs. These might succeed on retry.

A catalog mismatch is **deterministic** within a given DO lifetime: the set of registered capabilities does not change between turns. Retrying is pure waste. The design for failure mode is therefore:

- **`setActive` mismatch**: throws `CapabilityMismatchError`. Promotion doesn't happen. Pointer stays at previous value. Caller (workshop, admin, auto-revert) surfaces the error in its own shape.
- **Dispatch-time guard mismatch**: clears the pointer via `setActive(..., null, { skipCatalogCheck: true })`, broadcasts `bundle_disabled` with structured reason, returns `{ dispatched: false }`. Turn falls through to static brain.

Neither path touches `maxLoadFailures`. The two counters are explicitly orthogonal: `consecutiveFailures` resets on any pointer clear (catalog mismatch included), load-failure logic stays as-is.

### Alternative considered: soft-warn + continue

Raise a warning event, allow the turn to dispatch, let the bundle's tool calls fail naturally when they hit the missing service. Rejected:
1. Bundle tool errors are unstructured — operators see `TypeError` instead of "capability not bound."
2. The bundle wastes real LLM tokens trying to do work that cannot succeed.
3. "Continue with degraded capability" makes sense only when degradation is intentional — which is exactly what declaring requirements says it ISN'T.

### Alternative considered: graded retry (N=1)

A contrarian review suggested treating the first guard-detected mismatch as transient (don't disable; let the operator notice) and disabling only on the second consecutive mismatch. Rationale: a brief CF propagation race could resolve on retry.

Rejected for two reasons:
1. The propagation race is already covered by keeping `setActive` as the primary validation — isolates that call `setActive` have already loaded the new binding set.
2. Graded retry adds a counter (`consecutiveCatalogFailures`) that has to be distinguished from `consecutiveFailures`, with its own reset semantics. Complexity with no clear win; the narrow propagation-race window resolves on the next `/bundle/refresh` or deploy.

Operators who hit a false-positive mismatch during a propagation race call `/bundle/refresh` to re-validate, same as any other pointer-invalidation event.

## The client-facing error

`bundle_disabled` event today carries:

```ts
{
  type: "bundle_disabled",
  data: { rationale?: string; versionId?: string | null; sessionId?: string }
}
```

This proposal widens the payload additively:

```ts
{
  type: "bundle_disabled",
  data: {
    rationale?: string;
    versionId?: string | null;
    sessionId?: string;
    reason?: {
      code: "ERR_CAPABILITY_MISMATCH";
      missingIds: string[];
      versionId: string;
    };
  }
}
```

`rationale` remains the human-readable string; existing consumers reading only that see no change. `reason` is the structured form for new consumers. Future codes (`ERR_LOAD_FAILURE`, etc.) fit the same union without breaking.

## Input validation on declarations

The declaration is operator input (bundle author code executes in our toolchain at build time). A malicious or buggy bundle could declare ids that:

- Contain null bytes, control characters, or Unicode tricks (`"tavily\u200b-web-search"`).
- Exceed reasonable length (`"a".repeat(10000)`).
- Impersonate internal ids the SDK might use (`"__internal"`, `""`, `null`).
- Bloat metadata with thousands of entries (DoS vector on downstream consumers).

`defineBundleAgent` validates at build time:

- Each id: regex `/^[a-z][a-z0-9-]*[a-z0-9]$/`, length 2..64 chars.
- Total list: at most 64 entries.
- Duplicates are deduplicated at metadata write time, not rejected (forgiving for typos in hand-authored arrays).
- Null/undefined entries rejected with a clear error.

Validation errors throw at build time, not at validation time — the bundle author sees them when they run `workshop_build`, not later when operators try to deploy.

## Workshop advisory + deploy behavior

`workshop_build` runs in the workshop's host worker, which has its own capability set. For each declared id not present in the workshop's host, the tool appends a warning line to its text response. Advisory, not blocking — the workshop may be building for a different target deployment.

`workshop_deploy` passes `knownCapabilityIds: (env) => getBundleHostCapabilityIds()` to `setActive` by default, enforcing catalog validation at the workshop's own host. For cross-deployment promotions where the workshop's host isn't the target, the tool accepts `--skip-catalog-check` (or equivalent arg shape in the tool's input schema) that passes `skipCatalogCheck: true`. Operators who pass this flag take responsibility for the mismatch catching at dispatch time in the target deployment.

Default: strict. Opt-out: explicit.

## Interaction with unified-bundle-capability-token

The in-flight separate proposal for a unified capability token replaces per-service tokens (`__SPINE_TOKEN`, `__LLM_TOKEN`, `__TAVILY_TOKEN`) with a single "capability manifest token" whose payload enumerates the capabilities the bundle is authorized to invoke. That token's payload is derived from the declaration introduced here.

Ordering: this proposal must land first. The unified-token proposal reads `BundleMetadata.requiredCapabilities` and uses it to decide which per-service HKDF subkeys to pre-sign into the token. Without the declaration, token unification has no way to enumerate capabilities; with it, the derivation is mechanical.

This proposal explicitly does NOT design the token unification.

## Interaction with shape-2 capability rollouts

Each shape-2 capability (file-tools-as-service, vector-memory-as-service, etc.) is its own proposal. Those proposals land a new service entrypoint, a new bundle-side client, and a new subpath structure. They do not need to touch the catalog mechanism — they just start appearing as valid `id` values that bundles can declare, because they register a static `Capability` whose `id` flows through `getCachedCapabilities()`.

If a future capability ever ships as a pure service (no static `Capability` on the agent), its proposal introduces the `hostCapabilityIds` resolver on `BundleConfig` at the same time as the service. No current capability needs this, so v1 doesn't include it.

## What happens to bundles with no declaration

A bundle authored before this proposal lands (or one that doesn't populate `requiredCapabilities`) has `BundleMetadata.requiredCapabilities: undefined`. Validation in `setActive` short-circuits on empty/missing declarations: no requirements means nothing to validate means the pointer flips. Dispatch-time guard similarly short-circuits.

Current behavior (silent fail at tool-use time if a binding is missing) is unchanged for these bundles. Authors opt into catalog protection by declaring.

## Risks

1. **Bundle authors forget to declare.** Soft — they just don't get catalog protection. No regression relative to today. Documentation emphasizes the recommended pattern.

2. **Declaration drifts from the bundle's actual tool imports.** A bundle that declares `["tavily-web-search"]` but never imports `tavilyClient` wastes one array entry. A bundle that imports `tavilyClient` but forgets to declare risks catalog-mismatch at deploy time if the host happens to have Tavily unbound. Mitigation: workshop-side lint could flag import-vs-declaration drift. Not in this proposal; worth a follow-up.

3. **Capability id stability.** Renaming a capability id (e.g. `"tavily"` → `"tavily-web-search"`) breaks existing bundle declarations. General cost of string-matched identifiers. Mitigation: capability ids are stable API; renames require coordinated migration.

4. **`setActive` now has a parameter that both registries must honor.** `InMemoryBundleRegistry` and `D1BundleRegistry` both implement the same method; a mismatch in validation behavior between them would be a footgun. Mitigation: both implementations share a single `validateCatalog` helper defined in `bundle-registry/src/validate.ts`; tests cover both.

5. **Registry metadata lookups happen twice per pointer change** (once in `setActive`, once in bundle-config auto-rebuild). Both reads are D1 round-trips in the D1 registry. Mitigation: low frequency (only on pointer change), caching is a follow-up optimization. Per-turn cost is unchanged.

## Open questions punted to follow-ups

- **Typed bundle-side client surface.** `ctx.capabilities.tavily.search(...)`. Separate proposal; requires a type-augmentation registry pattern.
- **Unified capability token.** Separate proposal; consumes the declaration.
- **Workshop lint for declaration-vs-import drift.** Detect bundles that import `tavilyClient` without declaring `tavily-web-search`. Nice-to-have.
- **Capability version matching semantics.** Semver? Compatibility ranges? Host-exposed `CAPABILITY_VERSION` contract? When needed, introduces the `version` field with real semantics.
- **Service-only capabilities.** `hostCapabilityIds` resolver on `BundleConfig`. Added when the first service-only capability lands.
- **Shared `getVersion` cache** across auto-rebuild + catalog validation paths.
- **Cross-turn capability add/remove.** If a host operator changes the capability set mid-DO-lifetime, current design revalidates only on pointer change. Revisit if needed.
