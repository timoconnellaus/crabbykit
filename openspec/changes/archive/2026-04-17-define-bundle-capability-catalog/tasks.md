## 1. Phase 1 — Preflight

- [x] 1.1 Confirm `split-agent-bundle-host-and-sdk` has landed. `packages/runtime/bundle-sdk/`, `packages/runtime/bundle-host/`, and `packages/runtime/bundle-registry/` all exist; `BundleAgentSetup` is exported from `bundle-sdk`; `BundleDispatcher` + `InMemoryBundleRegistry` are exported from `bundle-host`; `D1BundleRegistry` is exported from `bundle-registry`.
- [x] 1.2 Confirm `BundleRegistry` interface is defined at `packages/runtime/agent-runtime/src/bundle-config.ts:52-72`. `bundle-host` and `bundle-registry` both re-export it; no fork.
- [x] 1.3 Confirm `BundleMetadata.capabilityIds` is a vestigial field with no non-sanitizer readers. Grep pattern: `grep -rn 'meta\.capabilityIds\|metadata\.capabilityIds' packages/` — expect only sanitizer code in `bundle-registry/src/d1-registry.ts:323` and `bundle-sdk/src/types.ts:110` / `bundle-registry/src/types.ts:38`. Any `capabilityIds` hits outside those three files are the unrelated `CapabilityHookContext.capabilityIds` (defined at `agent-runtime/src/capabilities/types.ts:24`).
- [x] 1.4 Run `bun run typecheck && bun run lint && bun run test` from repo root — clean baseline.

## 2. Phase 2 — Declaration types + build-time input validation in `bundle-sdk`

Single-commit phase. All edits inside `packages/runtime/bundle-sdk/`.

- [x] 2.1 Add `BundleCapabilityRequirement` interface to `packages/runtime/bundle-sdk/src/types.ts`:
  ```ts
  export interface BundleCapabilityRequirement {
    /** Capability id, must match a host-registered capability's id.
     *  Kebab-case, 2..64 chars. */
    id: string;
  }
  ```
- [x] 2.2 Add `requiredCapabilities?: BundleCapabilityRequirement[]` to `BundleAgentSetup<TEnv>`. Doc-comment the build-time-vs-runtime phase distinction relative to the existing `capabilities` factory (build-time-static vs env-dependent-runtime-constructed).
- [x] 2.3 Add `requiredCapabilities?: BundleCapabilityRequirement[]` to `BundleMetadata`. Do NOT touch or repurpose `BundleMetadata.capabilityIds` — its sanitizer surface and invariants are unchanged.
- [x] 2.4 **No work in Phase 2.** `CapabilityMismatchError` is declared in `agent-runtime` in Phase 4.1, and `bundle-sdk` will re-export it in Phase 4.12. Phase 2 does not touch the error class. Rationale noted here for reader context: `CapabilityMismatchError` is thrown by `BundleRegistry.setActive`, which is owned by agent-runtime; putting the class there keeps declaration and usage in one package and avoids adding a `bundle-sdk` dependency edge to `bundle-registry`.
- [x] 2.5 Add a `validateRequirements(raw: unknown): BundleCapabilityRequirement[]` helper in `packages/runtime/bundle-sdk/src/validate.ts`:
  - Accept `undefined` → return `[]`.
  - Each entry must be an object with `id: string`.
  - `id` must match `/^[a-z][a-z0-9-]*[a-z0-9]$/` and be 2..64 characters.
  - Total list capped at 64 entries.
  - Deduplicate by id (keep first occurrence) — silent, not an error.
  - Null/undefined/non-object/non-string-id entries rejected with a clear error naming the offending entry index.
- [x] 2.6 Update `packages/runtime/bundle-sdk/src/define.ts` (`defineBundleAgent`) to call `validateRequirements(setup.requiredCapabilities)` and write the result into `BundleMetadata.requiredCapabilities`. The bundle's `/metadata` HTTP handler surfaces the resulting records so host-side tooling can inspect declarations without instantiating the isolate.
- [x] 2.7 Export `BundleCapabilityRequirement` and `validateRequirements` from `packages/runtime/bundle-sdk/src/index.ts`. (The `CapabilityMismatchError` re-export from agent-runtime is added in Phase 4.12 once the class exists; Phase 2 does not touch it.)
- [x] 2.8 Unit tests in `packages/runtime/bundle-sdk/src/__tests__/requirements.test.ts`:
  - Valid declaration round-trips through `/metadata`.
  - Empty / undefined declaration yields `undefined` in metadata.
  - Invalid id charset throws at build time, error names the offending entry.
  - Over-length id throws.
  - Over-count list throws.
  - Duplicates deduplicate silently (keep first).
  - Null / non-string / non-object ids throw.
- [x] 2.9 `cd packages/runtime/bundle-sdk && bun run typecheck && bun run test` — PASS.
- [x] 2.10 Commit: "feat(bundle-sdk): introduce requiredCapabilities declaration with input validation"

## 3. Phase 3 — Host capability id enumeration + `AgentDO` wiring

Single-commit phase. All edits inside `packages/runtime/agent-runtime/`.

- [x] 3.1 Add a public method `getBundleHostCapabilityIds(): string[]` to `packages/runtime/agent-runtime/src/agent-runtime.ts`. Implementation: `Array.from(new Set(this.getCachedCapabilities().map(c => c.id)))`.
- [x] 3.2 Add a delegating method of the same name to `packages/runtime/agent-runtime/src/agent-do.ts` that forwards to `this.runtime.getBundleHostCapabilityIds()`.
- [x] 3.3 Unit test in `packages/runtime/agent-runtime/src/__tests__/capability-ids.test.ts`: returns every registered capability id, deduplicated, in registration order.
- [x] 3.4 `cd packages/runtime/agent-runtime && bun run typecheck && bun run test` — PASS.
- [x] 3.5 Commit: "feat(agent-runtime): expose host capability ids for bundle catalog validation"

## 4. Phase 4 — Atomic registry contract widening + caller migration

**This phase lands as a single commit.** Interface widening and every in-tree caller migration happen together so the tree never passes through a state where `setActive` demands `knownCapabilityIds` but callers haven't been updated. Explicit-over-implicit: no back-compat shim, no silent fallback.

Changes span five packages. Do them in this order to minimize tooling-level thrash, but commit together.

- [x] 4.1 **Interface widening + error class** (`packages/runtime/agent-runtime/src/bundle-config.ts`): (a) promote the inline `{ rationale?: string; sessionId?: string }` option type on `BundleRegistry.setActive` into a named `SetActiveOptions` interface. Add `knownCapabilityIds?: string[]` and `skipCatalogCheck?: boolean`. Export the interface. (b) Declare `CapabilityMismatchError extends Error` in the same file (or a sibling `errors.ts` in agent-runtime). Shape: `{ missingIds: string[]; versionId: string }` with `name = "CapabilityMismatchError"` and `code = "ERR_CAPABILITY_MISMATCH"`. Export it. The `setActive` method signature becomes `setActive(agentId, versionId, options?: SetActiveOptions): Promise<void>` and its documented throw is `CapabilityMismatchError`.

- [x] 4.2 **Re-export** `SetActiveOptions` as a type-only re-export (`export type { SetActiveOptions } from "@claw-for-cloudflare/agent-runtime"`) from `packages/runtime/bundle-registry/src/index.ts` and `packages/runtime/bundle-host/src/index.ts` so consumers in either package can import from either barrel, matching the existing pattern for `BundleRegistry`. Type-only is required because the direction rules in `scripts/check-package-deps.ts` allow type imports across every bucket boundary; value imports between sibling runtime packages are subject to the same rules.

- [x] 4.3 **Collapse the duplicate option type.** `packages/runtime/bundle-registry/src/types.ts:98-101` currently declares its own `SetActiveOpts` interface that is actively used by `D1BundleRegistry.setActive` (`d1-registry.ts:18,92`), re-exported from `bundle-registry/src/index.ts:12`, and imported by `agent-workshop/src/__tests__/test-helpers.ts:7,69`. In the same commit that introduces `SetActiveOptions` to `bundle-config.ts`:
  - Delete the local `SetActiveOpts` declaration from `bundle-registry/src/types.ts:98-101`.
  - Update `d1-registry.ts:18,92` to import and use `SetActiveOptions` instead.
  - Update `agent-workshop/src/__tests__/test-helpers.ts:7,69` to import and use `SetActiveOptions` instead.
  - Update `bundle-registry/src/index.ts:12` to re-export `SetActiveOptions` (as per 4.2) instead of the removed `SetActiveOpts`.
  - After the edits, `grep -rn 'SetActiveOpts\b' packages/` returns zero hits.

- [x] 4.4 **Shared validation helper** at `packages/runtime/bundle-registry/src/validate.ts`:
  ```ts
  export function validateCatalogAgainstKnownIds(
    required: BundleCapabilityRequirement[] | undefined,
    knownIds: ReadonlySet<string>,
  ): { valid: true } | { valid: false; missingIds: string[] };
  ```
  Empty/undefined `required` → `{ valid: true }`. Else compute `missing = required.filter(r => !knownIds.has(r.id))` deduplicated. `valid` iff `missing.length === 0`.
  Export from `bundle-registry/src/index.ts`; re-export from `bundle-host/src/index.ts`.

- [x] 4.5 **`D1BundleRegistry.setActive`** at `packages/runtime/bundle-registry/src/d1-registry.ts`:
  - Accept the new `SetActiveOptions` shape.
  - If `versionId === null` OR `options?.skipCatalogCheck === true`, skip validation and flip the pointer.
  - Else require `options.knownCapabilityIds !== undefined`. Missing → `throw new TypeError("BundleRegistry.setActive: knownCapabilityIds is required when skipCatalogCheck is not true")`.
  - Read `getVersion(versionId).metadata.requiredCapabilities`. Run `validateCatalogAgainstKnownIds`. If invalid, `throw new CapabilityMismatchError({ missingIds, versionId })`.
  - Validation runs BEFORE the D1 batch transaction so an invalid promotion leaves no partial commit.

- [x] 4.6 **`InMemoryBundleRegistry.setActive`** at `packages/runtime/bundle-host/src/in-memory-registry.ts` — same contract as 4.5. Validation runs before the `pointers.set` mutation.

- [x] 4.7 **Migrate `bundle-host/src/dispatcher.ts`**: `disable()` and `autoRevert()` both clear to `null`. Pass `skipCatalogCheck: true` explicitly to make the clearing intent self-documenting.

- [x] 4.8 **Migrate `bundle-host/src/bundle-builder.ts`**: auto-rebuild promotes a newly-built version. It already holds an `AgentDO`-like context; accept a `getHostCapabilityIds` callback at constructor/function level and pass `knownCapabilityIds: getHostCapabilityIds()` to every `setActive` call.

- [x] 4.9 **Migrate `agent-workshop` callers** in `packages/runtime/agent-workshop/src/index.ts`:
  - `workshop_deploy` (line 534): pass `knownCapabilityIds: getBundleHostCapabilityIds()` + propagate the tool's optional `skipCatalogCheck` boolean input (tool schema widened in Phase 6).
  - `workshop_disable` (line 577) and any other clear-path: pass `skipCatalogCheck: true`.
  - `workshop_rollback` and any promote-to-previous path: pass `knownCapabilityIds`.

- [x] 4.10 **Migrate `bundle-host` auto-revert call-site wiring**: `BundleDispatcher` constructor gains a `getHostCapabilityIds: () => string[]` callback parameter. `AgentDO._initBundleDispatch` wires it to `this.runtime.getBundleHostCapabilityIds`. (This field is also consumed by Phase 5; introduce here so the same commit can migrate all callers.)

- [x] 4.11 **Migrate every test caller** — systematic audit via `grep -rn '\.setActive\b' packages/ --include='*.ts'`. Every call site that passes a non-null `versionId` either gets explicit `knownCapabilityIds` (and optionally a test capability list) or explicit `skipCatalogCheck: true`. Known sites at the time of writing:
  - `packages/runtime/bundle-registry/src/__tests__/d1-batch-atomicity.test.ts:139,178`
  - `packages/runtime/bundle-registry/src/__tests__/d1-registry.test.ts:131,150,151,161,162,178,179,191,192,203,216,217,229,245,252,294,295`
  - `packages/runtime/bundle-host/src/__tests__/` — every `InMemoryBundleRegistry.setActive` call
  - `packages/runtime/agent-runtime/test/integration/bundle-spine-bridge.test.ts:97,123`
  - `packages/runtime/agent-runtime/test/integration/bundle-dispatch.test.ts:129,149,164,175,182,196,229,252,262,269,294,311,339...` (audit entire file)
  - `packages/runtime/agent-workshop/src/__tests__/test-helpers.ts:7,69` — already covered in 4.3 (same file), but verify the replacement helpers that forward to `setActive` also propagate `knownCapabilityIds` / `skipCatalogCheck` correctly.
  - `packages/runtime/agent-workshop/src/__tests__/` — audit all other `*.test.ts` files in the directory.
  - Any new test helper files added by prior proposals. Check for `mock.*setActive` and spy/stub setups.

- [x] 4.12 **Error class identity — single source of truth.** `CapabilityMismatchError` is DECLARED exactly once, in `packages/runtime/agent-runtime/src/bundle-config.ts` (Phase 4.1). `bundle-sdk/src/index.ts`, `bundle-registry/src/index.ts`, and `bundle-host/src/index.ts` each RE-EXPORT the class using `export { CapabilityMismatchError } from "@claw-for-cloudflare/agent-runtime"` (value re-export, not `export type`). A single class identity means `error instanceof CapabilityMismatchError` works regardless of which barrel the consumer imports from. The `code === "ERR_CAPABILITY_MISMATCH"` field survives structured-clone boundaries even when class identity is lost (documented in the test in 4.13).

- [x] 4.13 Unit tests in `packages/runtime/bundle-registry/src/__tests__/set-active-validation.test.ts` AND `packages/runtime/bundle-host/src/__tests__/in-memory-set-active-validation.test.ts` (parallel suites, one per implementation):
  - Valid `setActive` with matching ids flips the pointer.
  - `setActive` with mismatching ids throws `CapabilityMismatchError`; pointer unchanged; `missingIds` lists the right ids.
  - `setActive(agentId, null, {skipCatalogCheck: true})` clears without reading metadata.
  - `setActive(agentId, null)` (no options) clears without reading metadata — null always short-circuits.
  - `setActive(agentId, "v1", {})` with no `knownCapabilityIds` and no `skipCatalogCheck` throws `TypeError`.
  - `setActive` on a legacy metadata row (`requiredCapabilities === undefined`) passes validation with any `knownCapabilityIds`.
  - Duplicate required ids do NOT produce duplicate missing ids in the error.
  - `skipCatalogCheck: true` wins over missing `knownCapabilityIds` — no TypeError thrown.
  - `CapabilityMismatchError` round-trips across a structured-clone boundary with `code === "ERR_CAPABILITY_MISMATCH"` preserved (class identity is lost; code must survive).

- [x] 4.14 `bun run typecheck && bun run lint && bun run test` from repo root — PASS. Tree is green.

- [x] 4.15 Commit: "feat(bundle): validate capability catalog on setActive + migrate all callers"

## 5. Phase 5 — Dispatch-time guard + `bundle_disabled` event widening

Single-commit phase. Edits in `packages/runtime/bundle-host/` and `packages/runtime/agent-runtime/` (for event type widening).

- [x] 5.1 `BundleDispatcher` in `packages/runtime/bundle-host/src/dispatcher.ts`: add `validatedVersionId: string | null` private field (init `null`). The `getHostCapabilityIds` constructor callback was added in Phase 4.10; Phase 5 uses it but does not re-declare it.

- [x] 5.2 Add private `validateCatalogCached(versionId)`:
  - Returns `{ valid: true }` if `versionId === this.validatedVersionId`.
  - Else reads `this.registry.getVersion(versionId)`. Missing version or missing `metadata.requiredCapabilities` → `{ valid: true }`.
  - Else runs `validateCatalogAgainstKnownIds(meta.requiredCapabilities, new Set(this.getHostCapabilityIds()))`.
  - On valid: caches `this.validatedVersionId = versionId`.
  - On invalid: returns the result without caching.

- [x] 5.3 Add guard at the top of `dispatchTurn` (before any Worker Loader invocation):
  ```ts
  if (this.state.activeVersionId && this.state.activeVersionId !== this.validatedVersionId) {
    const result = await this.validateCatalogCached(this.state.activeVersionId);
    if (!result.valid) {
      await this.disableForCatalogMismatch(result, this.state.activeVersionId, ctxStorage, sessionId);
      return { dispatched: false, reason: `catalog mismatch: ${result.missingIds.join(", ")}` };
    }
  }
  ```

- [x] 5.4 Implement `disableForCatalogMismatch(result, versionId, ctxStorage, sessionId?)`:
  - Build human rationale: `catalog mismatch: missing [${result.missingIds.join(", ")}] declared by version '${versionId}'`.
  - Call `this.registry.setActive(this.agentId, null, { skipCatalogCheck: true, rationale, sessionId })`.
  - Write `null` to `ctxStorage.activeBundleVersionId`.
  - Reset: `state.activeVersionId = null`, `state.consecutiveFailures = 0`, `validatedVersionId = null`.
  - Broadcast `bundle_disabled` event with `{ rationale, versionId, sessionId, reason: { code: "ERR_CAPABILITY_MISMATCH", missingIds: result.missingIds, versionId } }`.

- [x] 5.5 Reset `validatedVersionId = null` in `refreshPointer` BEFORE the new pointer is resolved. Same in `hasActiveBundle` when the cached id differs from the registry. Purpose: a new version forces revalidation.

- [x] 5.6 **Cold-start + host-redeploy coverage**: when the DO cold-starts, `hasActiveBundle` reads the cached `ctx.storage.activeBundleVersionId`. The dispatcher's `validatedVersionId` starts `null`. If the cached pointer is non-null and the host capability set has changed since it was last validated (different deploy), the first `dispatchTurn` triggers the guard because `activeVersionId !== validatedVersionId` (= `null`). The integration test for this scenario lives at Phase 6.1 Scenario K.

- [x] 5.7 Widen the `bundle_disabled` event type. Locate it in `packages/runtime/agent-runtime/src/` (search `bundle_disabled` — likely `events.ts` or `transport/` messages). Extend `data` with optional `reason?: { code: "ERR_CAPABILITY_MISMATCH"; missingIds: string[]; versionId: string }`. Future codes can be added to the union without breaking consumers. Keep `rationale` unchanged.

- [x] 5.8 Structured log on catalog-mismatch disable — add a `console.warn` or structured-log call in `disableForCatalogMismatch` naming `agentId`, `versionId`, `missingIds`. Security-adjacent gate; operators need grep-able evidence in production logs.

- [x] 5.9 `cd packages/runtime/bundle-host && bun run typecheck && bun run test` — PASS.
- [x] 5.10 `cd packages/runtime/agent-runtime && bun run typecheck && bun run test` — PASS.
- [x] 5.11 Commit: "feat(bundle-host): dispatch-time catalog guard + structured bundle_disabled reason"

## 6. Phase 6 — Integration tests

Single-commit phase covering end-to-end scenarios in `packages/runtime/agent-runtime/test/integration/`.

- [x] 6.1 New file `bundle-capability-catalog.test.ts` with scenarios:
  - **A: setActive with matching catalog** — promotion succeeds, pointer flips.
  - **B: setActive with missing id throws** — promotion rejected, `CapabilityMismatchError` surfaced, pointer unchanged.
  - **C: setActive with skipCatalogCheck: true** — promotion succeeds regardless of mismatch.
  - **D: clearing to null skips validation** — `setActive(agentId, null)` never reads metadata.
  - **E: dispatch-time guard catches out-of-band mutation** — test mutates pointer via `InMemoryBundleRegistry.setActiveSync` (bypasses validation). Next `dispatchTurn` validates and disables. `bundle_disabled` event fires with structured `reason`.
  - **F: empty declaration** — bundle with `requiredCapabilities: []`, validation passes regardless of host capabilities.
  - **G: legacy bundle (no declaration field)** — older metadata row, validation passes.
  - **H: validation cached** — after a successful dispatch, second turn against the same version does NOT re-read metadata (spy/counter on registry stub).
  - **I: revalidation after pointer change** — promote new version with different requirements, `refreshPointer` triggers revalidation.
  - **J: consecutive-failure counter untouched by catalog mismatch** — prior Worker Loader failures do not combine with catalog failures.
  - **K: cold-start with stale cached pointer** — DO starts with `ctx.storage.activeBundleVersionId = "v-old"` while the host's registered capability set no longer satisfies v-old's declaration. First `dispatchTurn` triggers the guard, disables, falls back to static.
- [x] 6.2 `cd packages/runtime/agent-runtime && bun run test` — PASS.
- [x] 6.3 Commit: "test(bundle): integration coverage for capability catalog + cold-start + guard cache"

## 7. Phase 7 — Workshop integration + docs

- [x] 7.1 `packages/runtime/agent-workshop/src/tools/build.ts` (or wherever `workshop_build` tool is defined): after metadata extraction, compare `metadata.requiredCapabilities` against the workshop host's `getBundleHostCapabilityIds()`. For each missing id, append an advisory warning line to the tool's text response. Do NOT block the build. Acknowledge the limitation in the tool description: the workshop host's capability set may differ from the target deployment, so the warning is advisory-only.
- [x] 7.2 `workshop_deploy` tool input schema widened with `skipCatalogCheck?: boolean` (default `false`). When `true`, the tool passes `skipCatalogCheck: true` to `setActive`. Tool description notes that with `skipCatalogCheck: true` the promotion succeeds locally but the target deployment's dispatch-time guard will disable on first dispatch if catalog doesn't match — operators take responsibility for coordinating.
- [x] 7.3 `workshop_deploy` default path: pass `knownCapabilityIds: getBundleHostCapabilityIds()`. On `CapabilityMismatchError` the tool surfaces the error with the missing ids clearly named.
- [x] 7.4 Workshop test: deploy with mismatched catalog throws unless `skipCatalogCheck: true`; advisory warning appears on `workshop_build` output when workshop host lacks a declared capability; `skipCatalogCheck: true` deploy succeeds but tool response includes an advisory line warning about dispatch-time validation on the target.
- [x] 7.5 Update `CLAUDE.md` "Bundle brain override" section: describe the catalog declaration, the two validation locations (registry + dispatch guard), and the `skipCatalogCheck` escape hatch.
- [x] 7.6 Update `README.md` `defineBundleAgent` example to include `requiredCapabilities: [{ id: "tavily-web-search" }]` so the canonical example demonstrates catalog usage.
- [x] 7.7 Update `packages/runtime/bundle-sdk/README.md` (if present) with the declaration surface.
- [x] 7.8 Add one-line migration note to `CLAUDE.md` or the bundle authoring docs: "Bundles published before this change have `requiredCapabilities: undefined` and bypass catalog validation. Re-publish with an explicit declaration to opt into validation."
- [x] 7.9 Commit: "feat(agent-workshop): catalog advisory + skipCatalogCheck deploy flag + docs"

## 8. Phase 8 — Final verification

- [x] 8.1 Clean install: `rm -rf node_modules packages/*/*/node_modules && bun install`.
- [x] 8.2 `bun run typecheck` — PASS.
- [x] 8.3 `bun run lint` — PASS (dependency-direction check clean).
- [x] 8.4 `bun run test` — PASS across bundle-sdk, bundle-registry, bundle-host, agent-runtime integration, agent-workshop.
- [x] 8.5 Coverage thresholds on agent-runtime and bundle-host unchanged or better.
- [x] 8.6 Manual smoke test on `examples/basic-agent`:
  - Publish a bundle version with a deliberately-missing declared capability → `workshop_deploy` fails with `CapabilityMismatchError` naming the missing id.
  - `workshop_deploy` with `skipCatalogCheck: true` → promotion succeeds, first `dispatchTurn` sees the mismatch via guard, falls back to static, broadcasts `bundle_disabled` with structured `reason`.
  - Add the binding to `wrangler.jsonc`, restart, re-promote → validation passes, bundle dispatches normally.
  - Cold-start: stop the dev server, remove a binding, restart. Observe the guard disables the cached bundle on first dispatch after cold start.
- [x] 8.7 Grep confirmations:
  - `grep -rn "ERR_CAPABILITY_MISMATCH" packages/` — hits appear in dispatcher, event types, tests, docs; zero orphans.
  - `grep -rn "requiredCapabilities" packages/` — hits span bundle-sdk types, define.ts, bundle-registry validate, bundle-host dispatcher, workshop build+deploy, integration tests.
  - `grep -rn "skipCatalogCheck" packages/` — hits include registry implementations, dispatcher disable/autoRevert, workshop deploy tool, tests.
  - `grep -rn "SetActiveOpts\b" packages/` — zero hits (orphan was deleted in 4.3).
