## Context

The host's config layer is three-tiered today:

1. **Per-capability config** (`Capability.configSchema` + `configDefault` + `hooks.onConfigChange`). Persisted under `config:capability:{id}` in DO storage. `config_set` (in `config/config-set.ts:55-118`) validates against the capability's TypeBox schema, fires `onConfigChange(oldCfg, newCfg, ctx)` on the capability if defined, persists to `ConfigStore`.
2. **Agent-level config namespaces** (`defineAgent({ config: { ns1: schema, ns2: schema } })`). Persisted under `config:agent:{ns}`. Each capability optionally declares `agentConfigMapping: (snapshot) => slice` to project the snapshot to its own slice; `applyAgentConfigSet` (`agent-runtime.ts:907-932`) validates, persists, fires `onAgentConfigChange(oldSlice, newSlice, ctx)` on every capability whose mapping produced a changed slice (`handleAgentConfigSet` at lines 934-982). UI bridge entry point is `capability_action { capabilityId: "agent-config", action: "set", data: { namespace, value } }`.
3. **Custom configNamespaces** (`Capability.configNamespaces(ctx) => ConfigNamespace[]`). Each `ConfigNamespace` has `id`, `description`, `schema`, optional `pattern` (regex for prefix-matched namespaces like `schedule:{id}`), `get(namespace)`, `set(namespace, value)`. `config_set` resolves a namespace lookup (`config/config-set.ts:162-180`); for non-pattern namespaces it validates against the schema, then calls `set()`.

`BundleCapability` today exposes only `configSchema?: TObject` marked `@deferred`. None of the three tiers are wired. Bundle authors writing a config-driven capability hit a wall: no schema in the UI's config form, no validation on `config_set`, no hook fires when config changes, no path to expose a custom namespace.

The substrate is already mostly bundle-friendly:
- TypeBox `TObject` IS plain JSON Schema with metadata. It serializes across the structured-clone boundary natively. Validation can run host-side against the deserialized schema.
- `BundleMetadata` already has `requiredCapabilities`, `lifecycleHooks`, `surfaces` as separate top-level fields. Adding three more fields (`capabilityConfigs`, `agentConfigSchemas`, `configNamespaces`) follows the established pattern.
- The host hook bus bridge from `bundle-runtime-surface` (Phase 0) already round-trips host-fired hooks into the bundle isolate via spine RPCs (`recordToolExecution`, `processBeforeInference`). Adding `spineFireBundleConfigChange` and `spineFireBundleAgentConfigChange` is the same pattern.
- The dispatch-time collision guard from `bundle-http-and-ui-surface` (`disableForRouteCollision`, etc.) is the established pattern for validation-failed-at-runtime; we extend it for two new dimensions.

**Stakeholders:** bundle authors building config-driven capabilities; host operators who need to know which agent-config namespaces a deployed bundle owns; UI authors whose config forms must show bundle-declared schemas.

## Goals / Non-Goals

**Goals:**
- All three config tiers (per-capability, agent-level, configNamespaces) work for bundles with the same UX as static — schema in `config_schema`, validation in `config_set`, hook fires on change, UI form generation works automatically.
- TypeBox schemas serialize at build-time into `BundleMetadata`; no runtime serialization decisions on the hot path.
- Functional parity test: a config-driven shape-2 capability (e.g. `tavily-web-search` with its config schema) consumed statically vs. declared in a bundle accepts the same `config_set` traffic, fires `onConfigChange` with the same payload, persists to the same `config:capability:{id}` storage shape.
- Host-side collision guards prevent and detect bundle-vs-static collisions for agent-config namespace ids and configNamespace ids; mirror the `bundle_disabled` flow with two new structured reason codes.
- Bundle hooks fire via the existing host-hook-bus bridge (extends `bundle-runtime-surface` Phase 0); same scope check, same budget tracker, same spine RPC discipline.
- Telemetry: every dispatch boundary emits structured `[BundleConfig]` logs.

**Non-Goals:**
- **Pattern-matched configNamespaces** (regex-based). One capability uses this today (`prompt-scheduler`'s `schedule:{id}`). Defer to a follow-up; pattern serialization across the isolate boundary is non-trivial (RegExp doesn't structured-clone reliably), and the v1 audience isn't asking for it.
- **`agentConfigMapping` as a function.** Functions cannot serialize across isolates. v1 uses a declarative `agentConfigPath: string` (dotted-path) that the host evaluates against the snapshot. Capabilities that need a computed slice can declare a derived agent namespace.
- **Cross-bundle / cross-version config migration.** A bundle author who renames a config field is responsible for migration; the framework does not auto-migrate `config:capability:{id}` payloads.
- **Live schema updates without redeployment.** Schemas are baked into bundle metadata at `workshop_build` time. Schema changes require a new bundle version.
- **Bundle declaring per-capability `configSchema` for an `id` already owned by a host static capability.** Build-time + promotion-time validators reject. Host owns the canonical schema for any id it registers; bundle cannot redefine.
- **Live config introspection from the bundle isolate** (e.g. bundle code calling `ctx.configStore.getCapabilityConfig`). Bundle reads its config slice via `ctx.agentConfig` (per-capability slice, populated on context construction). For runtime reads beyond that slice, bundle uses `kvStore` against the `config:*` keys it owns — but this is rare and not a v1 promised surface.

## Decisions

### Decision 1 — Schemas serialize as JSON Schema; one extraction at build time

**Context.** TypeBox `TObject` is a JavaScript object with the JSON Schema fields plus a `Symbol(TypeBox.Kind)` metadata key. The `Symbol` does not survive structured clone, BUT the JSON Schema fields do, and the host's `Value.Check(schema, value)` only needs the JSON Schema fields to validate. (TypeBox uses the `Kind` symbol as a fast-path optimization; it falls back to JSON-Schema-style validation when absent.)

**Decision.** `defineBundleAgent` walks `setup.capabilities(probeEnv)` once at build time, extracts each `BundleCapability.configSchema` (and `setup.config[ns]`, and each `configNamespaces[].schema`) by JSON-stringifying and re-parsing the schema (drops the `Kind` symbol). The resulting plain JSON Schemas are emitted into `BundleMetadata`. At runtime:
- The host reads the schemas from metadata and uses them as-is in the existing `Value.Check(schema, value)` calls. Validation works because TypeBox's runtime is JSON-Schema-compatible **for the supported `Kind` set** (see below).
- The `config_schema` tool returns the metadata schemas verbatim — UI form generators consume them as JSON Schema, which they already do for static schemas.
- No reverse-rehydration to TypeBox `TObject` is needed.

**Supported Kinds:** `Object`, `String`, `Number`, `Boolean`, `Array`, `Literal`, `Union`, `Optional`, `Recursive`, `Unsafe`. These survive JSON round-trip with full `Value.Check` fidelity.

**Rejected Kinds (build-time validator throws):** `Transform`, `Constructor`, `Function`. These carry runtime closures (`Decode`/`Encode` functions for Transform; constructor refs for Constructor; callable refs for Function) that cannot survive JSON-stringify+parse. A bundle author who declares `Type.Transform({...}, ..., { Decode })` would silently lose the decoder on the host side, with `Value.Decode` no-opping and the bundle never seeing the decoded shape. Better to reject at build time.

The validator walks the schema recursively (objects, array `items`, union `anyOf`) checking the `Kind` field at each node. Implementation: a 30-line tree-walk in `bundle-sdk/src/validate.ts`. Test cases: each rejected `Kind` produces a build-time error naming the path inside the schema; each supported `Kind` round-trips and validates identically pre/post serialization.

**Rationale.** Single extraction at build time, zero runtime serialization cost, no cross-isolate schema dispatch. The `Kind` symbol drop is invisible for the supported set; rejected `Kind`s throw loudly at build time rather than silently drop behavior at runtime.

**Alternative rejected.** "Send TypeBox `TObject` instances across the isolate via structured clone." Symbols don't survive; consumers would silently get reduced-fidelity schemas. Even if it worked, doing it on the hot path wastes cycles.

**Alternative rejected.** "Re-import TypeBox in the host and reconstruct `TObject` from the JSON Schema." Adds a TypeBox import cost on the host config path; produces an identical validation result; gains nothing.

### Decision 2 — `agentConfigMapping` becomes a declarative `agentConfigPath: string`

**Context.** Static `Capability.agentConfigMapping: (snapshot) => slice` is a function. Functions cannot cross the isolate boundary (no structured clone). The mapping must execute somewhere; the question is where and how it's declared.

**Decision.** `BundleCapability.agentConfigPath?: string` — a dotted-path string evaluated host-side against the agent-config snapshot. Examples:
- `"botConfig"` → returns `snapshot.botConfig`
- `"botConfig.rateLimit"` → returns `snapshot.botConfig?.rateLimit`
- absent → capability does not receive an agent-config slice (`ctx.agentConfig === undefined`)

A small evaluator (`evaluateAgentConfigPath(snapshot, path)`) lives in the runtime — splits on `.`, walks the snapshot, returns `undefined` on any miss. Safe-traversal: `evaluateAgentConfigPath({}, "a.b.c")` returns `undefined` rather than throwing. This intentionally diverges from a literal static `agentConfigMapping = (s) => s.a.b.c` which would throw `TypeError`. **Bundle authors MUST treat `ctx.agentConfig` as potentially `undefined` and branch accordingly** — same defensive contract as the static `agentConfigMapping` returning `undefined` (which most static caps already handle).

When the host detects a slice change (using the existing `sliceEqual` helper that JSON-stringify-compares via shallow shortcut on `===`), it fires `onAgentConfigChange` via the bridge with the new slice. `sliceEqual(undefined, undefined) === true` so when the path doesn't resolve on either side the hook is correctly skipped. The bundle never sees the full snapshot, only its declared slice — same defense-in-depth as static (where `agentConfigMapping` is run host-side).

**Rationale.** Path-based mappings cover ~all observed use cases (every static capability today either projects a single top-level field or no field at all). Declarative is serializable, easier to reason about, can be statically validated against the agent's declared schema (path must reach a defined property — caught at build time).

**Alternative rejected.** "Serialize the function as a string + eval host-side." Defeats the isolate boundary; security disaster.

**Alternative rejected.** "Always pass the full snapshot." Capability sees fields it shouldn't (other capabilities' slices). Breaks the existing principle that each capability gets only its slice. Also breaks the "fires only when MY slice changed" optimization.

**Alternative rejected.** "Skip the mapping entirely; bundle reads `kvStore` for `config:agent:{ns}` directly." Bundle would re-implement the snapshot/slice/change-detection plumbing in user code. Wrong layer.

### Decision 3 — Custom configNamespace `get`/`set` execute in the bundle via cross-isolate RPC

**Context.** `Capability.configNamespaces[].get(namespace)` and `set(namespace, value)` are functions called from `config_set`/`config_get` (`config-set.ts:172`). Functions can't cross isolates. For bundle-declared namespaces, the host's `config_set` resolves "this is a bundle namespace", then dispatches to the bundle.

**Decision.** Host's `config_set`/`config_get` extend their namespace lookup to also consult `version.metadata.configNamespaces`. On match against a bundle namespace:
1. Mint the unified `__BUNDLE_TOKEN`.
2. POST to `/config-namespace-set` (or `/config-namespace-get`) with envelope `{ namespace, value? }`.
3. Bundle SDK looks up the matching `BundleCapability.configNamespaces(ctx)` declaration, invokes the handler, returns `{ status: "ok", value? }` or `{ status: "error", message }`.

For `config_set`, validation against the namespace schema happens host-side BEFORE dispatch (so a bundle never sees an invalid value). For `config_get`, the host has no value to validate; it returns whatever the bundle handler returns.

Validation shapes:
- Exact-match namespace: validate against declared schema host-side. Bundle receives a known-valid value.
- Pattern-matched: deferred (Non-Goal). v1 supports only exact-match.

**Rationale.** Validates host-side (defense in depth); dispatches the handler call across the isolate; preserves the exact `set`/`get` semantics from static. Same RPC pattern as `/http` and `/action`.

### Decision 4 — Hook bridge for `onConfigChange` and `onAgentConfigChange` extends bundle-runtime-surface's pattern; hook fires BEFORE persist

**Context.** `bundle-runtime-surface` introduced `spineRecordToolExecution` and `spineProcessBeforeInference` as RPCs the bundle calls. We need two new methods, but in the OPPOSITE direction — the host fires INTO the bundle when its config change pipeline runs.

**Decision.** Two new RPCs added to the host's bundle dispatch surface (NOT to `SpineHost` — these are host→bundle, not bundle→host):

1. **`dispatchBundleConfigChange(capabilityId, oldCfg, newCfg, sessionId)`** in `agent-do.ts initBundleDispatch`. Mints token, decodes envelope, POSTs to bundle `/config-change` with `{ capabilityId, oldCfg, newCfg, sessionId }`. Bundle SDK looks up the matching `BundleCapability.hooks.onConfigChange`, invokes it.
2. **`dispatchBundleAgentConfigChange(capabilityId, oldSlice, newSlice, sessionId)`** — same shape with slice payloads.

**Hook ordering matches static exactly.** Static `config-set.ts:103-117` fires `onConfigChange(oldConfig, newConfig)` BEFORE `setCapabilityConfig` writes; if the hook throws, persistence does NOT happen and the tool returns an error. The bundle bridge follows the same order: dispatch → on `{status: "ok"}` → persist; on `{status: "error", message}` → tool returns error, no persist; on dispatch timeout → tool returns error, no persist (consistent fail-closed semantic). This preserves functional parity — bundle hooks can reject writes the same way static hooks can.

`AgentRuntime.handleAgentConfigSet` (existing) extends to also iterate bundle-declared capabilities (those with `agentConfigPath` instead of `agentConfigMapping`) and dispatch via `dispatchBundleAgentConfigChange` when the path-evaluated slice changed. Slice-equality check uses the existing `sliceEqual` helper from agent-runtime. **`handleAgentConfigSet` is the centralized agent-level dispatch — called from BOTH `config_set` tool AND `applyAgentConfigSet` (UI bridge `capability_action { capabilityId: "agent-config", ... }`)**, so wiring there covers both call paths.

`AgentRuntime`'s per-capability config_set handler (currently in `config/config-set.ts`) extends to also fire `dispatchBundleConfigChange` for bundle-declared capability ids — matching the static call site's pre-persist ordering.

**Note on direction asymmetry.** The existing host-hook-bus bridge from `bundle-runtime-surface` is bundle→host (bundle fires events that the host's hook chain processes). Config change is host→bundle (host's pipeline drives the change; bundle reacts). Different direction, different transport, no reuse possible. But same Worker Loader fetch pattern, same envelope shape, same scope discipline, same composeWorkerLoaderConfig helper.

**Rationale.** Reuses the existing dispatch infrastructure; isolates the bundle-side hook in the same isolate context as `onAlarm` etc.; preserves static-vs-bundle hook-ordering parity.

### Decision 5 — Validation layers + reserved tokens (capability-config collision is a SEPARATE check from `requiredCapabilities`)

**Context.** Need to prevent collisions across three new dimensions: per-capability config (id collision against host capability), agent-config namespaces (key collision against host agent-config + reserved tokens), configNamespaces (id collision against host namespaces + reserved tokens).

**Decision.** Three-layer validation matching the established pattern:

1. **Build-time** (`validate.ts` helpers):
   - `validateCapabilityConfigs`: each capability's `configDefault` (when set) MUST validate against its own `configSchema`. Walks the schema rejecting Transform/Constructor/Function `Kind`s (Decision 1).
   - `validateAgentConfigSchemas`: namespace ids in `setup.config` cannot match `session`, cannot start with `capability:`, cannot equal `agent-config`, `schedules`, `queue` (host built-in `capability_action` ids — verified against `agent-runtime.ts:1893-1937` switch). Cannot collide with the bundle's own `BundleCapability.id`s (would conflict with `capability:{id}` namespace shape). Cannot collide with the bundle's own `surfaces.actionCapabilityIds`.
   - `validateConfigNamespaces`: namespace ids cannot match `session`, `agent-config`, `schedules`, `queue`. Cannot match the bundle's own agent-config namespace ids. Cannot match the bundle's own capability ids. **Rejects** any namespace declaring a `pattern` field (Non-Goal — pattern-matched is deferred).
2. **Promotion-time** (`bundle-host` validators):
   - `validateBundleAgentConfigsAgainstKnownIds(declared, knownAgentConfigNamespaces)`: bundle agent-config namespace ids vs. host's currently-resolved `getAgentConfigSchema()` keys. Mismatch → `AgentConfigCollisionError` (`ERR_AGENT_CONFIG_COLLISION`). Pointer NOT flipped.
   - `validateBundleConfigNamespacesAgainstKnownIds(declared, knownConfigNamespaceIds)`: bundle configNamespace ids vs. host's `getConfigNamespaces().map(n => n.id)`. Mismatch → `ConfigNamespaceCollisionError` (`ERR_CONFIG_NAMESPACE_COLLISION`).
   - **`validateBundleCapabilityConfigsAgainstKnownIds(declared, knownCapabilityConfigIds)`** — explicitly **NOT** the same as `bundle-runtime-surface`'s `validateCatalogAgainstKnownIds`. That one checks the bundle's `requiredCapabilities` (ids the bundle NEEDS from the host). This new one checks the bundle's `capabilityConfigs.map(c => c.id)` (ids the bundle DECLARES with config schemas) against the host's REGISTERED capability id set. The two sets are orthogonal: a bundle can declare `capabilities: () => [{ id: "my-counter", configSchema, ... }]` with empty `requiredCapabilities` and the catalog check passes — but if the host also has a static `my-counter` capability, both sides write `config:capability:my-counter` and corrupt each other's data silently. New validator + new error code: `ERR_CAPABILITY_CONFIG_COLLISION`.
3. **Dispatch-time** (`agent-do.ts` cached guard):
   - Same checks against the running deployment's resolved sets, on first dispatch after a pointer change. Mismatch routes through `disableForAgentConfigCollision` / `disableForConfigNamespaceCollision` / `disableForCapabilityConfigCollision` with structured `bundle_disabled` reason. Does NOT increment `consecutiveFailures` (deterministic).

**Rationale.** Same three-layer pattern as catalog + routes + actions. The capability-config collision case looks like a duplicate of the catalog check at first glance but is a distinct dimension — fixing this conflation is a CRITICAL revision-driven correction.

### Decision 6 — `agentConfigPath` is validated against the bundle's own schemas at build time, against host schemas at dispatch time

**Context.** A bundle author writes `agentConfigPath: "botConfig.rateLimit"` but the bundle's declared agent-config schema has no `botConfig` namespace. Result: capability never receives a slice; silent failure. The previous draft of this decision tried to "warn but not throw" for cross-bundle paths — but `defineBundleAgent` runs INSIDE the bundle isolate at compile time, so a `console.warn` goes to a log nobody watches.

**Decision.** Two-layer validation:

1. **Build-time** (`validateAgentConfigPaths(capabilityConfigs, agentConfigSchemas)`) checks every bundle capability with `agentConfigPath` against the bundle's OWN `setup.config` schemas:
   - Path's first dotted segment must be a top-level namespace id present in `agentConfigSchemas`. If yes → the path resolves locally and we walk the rest of the path through the schema (each subsequent segment must be a declared property unless an enclosing schema sets `additionalProperties: true`, terminating the structural check).
   - If NO → the bundle author intends to target a host-declared namespace at runtime. Build-time defers this check (no host visible) but EMITS NOTHING — no console.warn (operator wouldn't see it anyway), no throw (might be legitimate cross-bundle). The path is recorded in metadata as-is and the dispatch-time guard handles it.

2. **Dispatch-time** (`validateAgentConfigPathsCached`) — runs on first dispatch after a pointer change. Walks every bundle capability's `agentConfigPath` and resolves it against the MERGED snapshot schemas (bundle's own + host's `getAgentConfigSchema()`). Unresolvable path → `ERR_AGENT_CONFIG_PATH_UNRESOLVABLE` via `disableForAgentConfigPathUnresolvable` (clears pointer, broadcasts `bundle_disabled` with structured reason: `{ code, capabilityId, path, knownNamespaces }`). Operator gets a precise diagnostic naming the typo or the missing host namespace.

**Rationale.** Build-time catches the high-confidence typo class (path doesn't resolve in the bundle's own schemas AND the bundle author didn't claim the path). Dispatch-time catches the cross-bundle-against-actual-host case with definitive evidence. Removes the "silent warning" footgun from the previous draft.

### Decision 7 — `BundleMetadata.capabilityConfigs` shape duplicates `BundleCapability.id`s — single source of truth

**Context.** `BundleMetadata.capabilityConfigs?: Array<{ id, schema, default? }>` lists per-capability schemas keyed by capability id. The bundle ALSO declares each capability via `setup.capabilities`. Two sources of truth for the id.

**Decision.** Metadata is the projection. `defineBundleAgent` derives `capabilityConfigs` exclusively from walking `setup.capabilities(probeEnv)` and collecting capabilities with non-empty `configSchema`. The metadata is read-only for downstream consumers; nothing edits it independently. If the bundle author somehow declares a config schema in metadata that doesn't appear in `setup.capabilities`, the build-time extraction simply doesn't emit it — the bundle's declared capability list is authoritative.

**Rationale.** Single source of truth (the capabilities list), metadata is the dispatch index. Same pattern as `surfaces` (extracted from capabilities) and `requiredCapabilities` (extracted from `setup.requiredCapabilities`).

### Decision 8 — Telemetry: reuse `[BundleDispatch]` prefix with structured `kind` discriminator

**Context.** `bundle-runtime-surface` and `bundle-http-and-ui-surface` both emit `[BundleDispatch]` logs. Introducing a separate `[BundleConfig]` prefix splits operator grep workflows for adjacent concerns (same dispatch infrastructure, same `composeWorkerLoaderConfig`, same token mint, same scope check, same timeout). The previous draft of this decision split the prefix gratuitously.

**Decision.** Reuse `[BundleDispatch]` everywhere. Each log entry carries a structured `kind` field discriminator. Concrete log points:

- `[BundleDispatch]` `kind: "config_change"` — `{ agentId, capabilityId, status, durationMs }` after `/config-change` dispatch.
- `[BundleDispatch]` `kind: "agent_config_change"` — `{ agentId, capabilityId, status, sliceChanged: boolean, durationMs }`.
- `[BundleDispatch]` `kind: "namespace_get"` — `{ namespace, status, durationMs }`.
- `[BundleDispatch]` `kind: "namespace_set"` — `{ namespace, status, durationMs }`.
- `[BundleDispatch]` `kind: "config_set_bundle_cap"` — `{ agentId, capabilityId, durationMs }` after host persists a bundle-declared per-capability config.
- `[BundleDispatch]` `kind: "config_set_bundle_ns"` — `{ agentId, namespace, durationMs }` after host persists a bundle-declared agent-config namespace.
- `[BundleDispatch]` `kind: "schema_extraction_error"` — `{ capabilityId, error }` when build-time schema extraction encounters an issue.
- `[BundleDispatch]` `kind: "agent_config_collision_disable"` — `{ versionId, collidingNamespaces }`.
- `[BundleDispatch]` `kind: "config_namespace_collision_disable"` — `{ versionId, collidingIds }`.
- `[BundleDispatch]` `kind: "capability_config_collision_disable"` — `{ versionId, collidingIds }`.
- `[BundleDispatch]` `kind: "agent_config_path_unresolvable_disable"` — `{ versionId, capabilityId, path, knownNamespaces }`.

**Rationale.** One prefix, one grep, structured discriminator. Operator UX matches established pattern.

### Decision 9 — Synthetic stand-in capabilities are exposed via a SEPARATE accessor, not merged into `getCachedCapabilities()`

**Context.** The previous draft proposed merging synthetic stand-in capabilities (carrying bundle-declared `configSchema` + `configDefault` only, no real `tools`/`promptSections`/`hooks`) into `getCachedCapabilities()` so the existing `config-set.ts:70` (`ctx.capabilities.find((c) => c.id === id)`) and `config-schema.ts:50` (`for (const cap of ctx.capabilities)`) would find them. **Problem (CRITICAL-1 from review):** `getCachedCapabilities()` is read by ~25 call sites — `resolveCapabilities`, prompt section assembly, hook iteration in `handleAgentConfigSet`, MCP merging, schedule enumeration, inspection panel rendering, capability-id list passing to every hook context. Stand-ins would leak as phantom capabilities into all of these.

**Decision.** Expose stand-ins via a SEPARATE accessor `getBundleCapabilityConfigStandIns(): Capability[]` on `AgentRuntime`, consumed ONLY by the three config tools. The tools' `ConfigContext.capabilities` field is then composed as `[...this.getCachedCapabilities(), ...this.getBundleCapabilityConfigStandIns()]` at the single call site that builds `ConfigContext` (`agent-runtime.ts:1745+`). Nowhere else.

The stand-ins still carry `id`, `name` (= id), `description` (`"Bundle-declared capability config"`), `configSchema`, `configDefault` — enough for `config_set` to find them via `ctx.capabilities.find` and for `config_schema` to surface them in the listing. They do NOT carry `tools`/`promptSections`/`hooks`/`schedules`/`mcpServers`/`httpHandlers`/`onAction` — none of those code paths are touched by config tools, so the absence is invisible.

**Cache invalidation (M5 from review):** the stand-in cache AND `cachedAgentConfigSchema` MUST be invalidated whenever `bundlePointerRefresher` fires. Otherwise a bundle promoted on a warm DO is invisible to the config tools until the next cold start. The invalidation is a one-line addition to `bundlePointerRefresher` and matches the existing `validatedVersionId = null` pattern at `agent-do.ts:757`.

**Rationale.** Honest separation of concerns. The static `Capability` interface promises a heavy contract (tools, hooks, full lifecycle); stand-ins promise a tiny one (config schema only). Forcing them through the wrong shape would create either real bugs (phantom capabilities in prompts) or a spreading marker (`__bundleStandIn?: true`) that every consumer would need to learn to ignore. Separate accessor keeps the contracts honest.

### Decision 10 — Data-orphan policy on collision-disable: refuse to load, do not auto-delete

**Context (M1 from review).** Sequence: bundle declares `agentConfigSchemas: { botConfig: schemaA }`, persists data under `config:agent:botConfig`, host redeploys with new static `botConfig` namespace using `schemaB`. Dispatch-time guard fires `ERR_AGENT_CONFIG_COLLISION` and disables the bundle. The persisted `config:agent:botConfig` value still exists in DO storage. What happens next?

- If `ensureAgentConfigLoaded` reads the value and stuffs it into the snapshot under the host's `schemaB`, the snapshot now contains a value that fails `Value.Check(schemaB, value)`. Subsequent `config_set` validates against `schemaB` and succeeds, but `config_get` returns the stale schema-A value (no validation on read). User-visible corruption.
- If we silently `Value.Create(schemaB)` and ignore the persisted value, the user's data vanishes invisibly. Operator has no signal.
- If we delete the key, the user's data is destroyed by the framework — unrecoverable if the operator decides to roll back the host change and re-promote the bundle.

**Decision.** `ensureAgentConfigLoaded` checks each persisted `config:agent:{ns}` value against the currently-active schema. On `Value.Check` failure:
- The snapshot value SHALL be `Value.Create(currentSchema)` (the default) so callers get a usable snapshot.
- An "orphan" entry is recorded in `config:agent:__orphans` (keyed by namespace, value: `{ persistedValue, recordedAt, schemaCheckFailed: true }`) so an operator script can introspect it.
- A structured warning log fires: `[BundleDispatch] kind: "agent_config_orphan_detected"` with `{ namespace, persistedShape: typeof persistedValue }`.
- The persisted value is NOT deleted. Operator chooses whether to roll back, migrate, or run `config_delete` (out of scope for this proposal but referenced).

**Rationale.** Refuses to silently corrupt OR silently destroy. Operator gets a definitive signal both in logs and in introspectable storage. Reversible via re-promote of the original bundle (the persisted value is still there).

This adds the `__orphans` reserved key under `config:agent:` — documented in CLAUDE.md as a framework-managed key.

## Risks / Trade-offs

- **[TypeBox `Kind` symbol drop on schema serialization]** → Mitigation: documented behavior; `Value.Check` works without `Kind` because TypeBox's runtime is JSON-Schema-compatible. Add a regression test that round-trips a representative schema (Object with nested Optional fields, Union, Literal, Array) through JSON.stringify + JSON.parse and confirms `Value.Check` produces identical pass/fail outcomes.

- **[`agentConfigPath` is less expressive than `agentConfigMapping`]** → Mitigation: 100% of static capability mappings observed today are pure projections (`(s) => s.foo` or `(s) => s.foo.bar`). The path syntax covers them. For the 0% that need transformation: declare a derived agent namespace and project from there. Document the workaround.

- **[Bundle author redefines a capability id the host already owns to override the schema]** → Mitigation: build-time + promotion-time + dispatch-time guards reject. Same defense as `bundle-runtime-surface` capability catalog.

- **[`config_set` from UI for a bundle-declared agent-config namespace blocks until bundle dispatch returns]** → Mitigation: bundle hook timeout for config dispatches uses a SEPARATE config-tighter knob `BundleConfig.configHookTimeoutMs` defaulting to **5 000 ms** (not the 30 000 ms `httpDispatchTimeoutMs` used for HTTP request forwarding). 30s hooks would be a surprising UX hang; config UX expects sub-second. Bundle author whose hook legitimately needs longer can override the knob.

- **[Hook ordering BEFORE persist means bundle exception aborts the write]** → Static behaves the same way (`config-set.ts:109-113`). Documented as feature, not bug — bundle hook can refuse a write the same way static can.

- **[Hook bus loop via reentry]** → A bundle's `onConfigChange` calls `kvStore.put` against a `config:capability:{id}` key directly. That doesn't fire `config_set`'s validation pipeline (kv writes don't), so no loop. But a bundle handler that calls `spine.broadcast({...})` with a `capability_action` payload could in principle re-enter. Mitigation: the existing `hook_after_tool` budget pattern bounds total per-turn hook fires; same bound applies. Document the constraint.

- **[Bundle schema changes between deploys breaking persisted config]** → Mitigation: framework does not auto-migrate. Bundle author who renames `botConfig.rate` → `botConfig.rateLimit` ships their own migration (read old key in onConfigChange, write new shape, delete old). Document in the bundle authoring guide.

- **[Many bundle-declared agent-config namespaces inflate the agent-config UI]** → Bundle author concern, not framework concern. The UI shows whatever the schema declares.

- **[Nested-path performance]** → `evaluateAgentConfigPath` is a tight string-split + property walk. Cost is negligible vs. the surrounding `Value.Check` call. No optimization needed.
