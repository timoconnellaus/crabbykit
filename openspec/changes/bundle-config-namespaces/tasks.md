## 1. Bundle SDK types + build-time validation

- [x] 1.1 Promote `BundleCapability.configSchema` from `@deferred` JSDoc to active. Add `configDefault?: Record<string, unknown>`. Add `agentConfigPath?: string`. Document each in JSDoc; document the safe-traversal semantic of `agentConfigPath` (returns `undefined` on miss; bundle handler must branch).
- [x] 1.2 Add `BundleConfigNamespace` type (id, description, schema, get, set — NO `pattern` field) and `BundleCapability.configNamespaces?: (ctx: BundleContext) => BundleConfigNamespace[]`.
- [x] 1.3 Add `BundleAgentSetup.config?: Record<string, TObject>`.
- [x] 1.4 Add `BundleCapabilityHooks.onConfigChange?` and `onAgentConfigChange?`. Same shape as static.
- [x] 1.5 Add three new top-level fields to `BundleMetadata`: `capabilityConfigs?: Array<{ id: string; schema: object; default?: Record<string, unknown> }>`, `agentConfigSchemas?: Record<string, object>`, `configNamespaces?: Array<{ id: string; description: string; schema: object }>`.
- [x] 1.6 Add `BundleConfigChangeEvent` and `BundleAgentConfigChangeEvent` types in `bundle-sdk/src/types.ts`.
- [x] 1.7 Add `validateCapabilityConfigs(capabilityConfigs)` to `bundle-sdk/src/validate.ts`: each `configDefault` (when present) MUST validate against the same capability's `configSchema`. Reject schema kinds Transform/Constructor/Function via a recursive walker (descends `properties`, `items`, `anyOf`).
- [x] 1.8 Add `validateAgentConfigSchemas(schemas, capabilityIds, actionCapabilityIds)`: rejects ids equal to `session`, `agent-config`, `schedules`, `queue`, starting with `capability:`, colliding with bundle's own capability ids, colliding with bundle's own `surfaces.actionCapabilityIds`. Same Transform/Constructor/Function walker on each schema.
- [x] 1.9 Add `validateConfigNamespaces(namespaces, agentNamespaceIds, capabilityIds)`: rejects ids equal to `session`, `agent-config`, `schedules`, `queue`, equal to bundle's own agent-config namespace ids, equal to bundle's own capability ids. Reject any namespace declaring a `pattern` field with a "deferred — see proposal Non-Goals" message. Same Transform/Constructor/Function walker on each schema.
- [x] 1.10 Add `validateAgentConfigPaths(capabilityConfigs, agentConfigSchemas)`: for every capability with `agentConfigPath`, the first dotted segment must match a top-level namespace in the bundle's own `agentConfigSchemas` OR be left for the dispatch-time guard (no warning, no throw). Subsequent segments validated against the schema's `properties` chain (terminate at `additionalProperties: true`).
- [x] 1.11 Add `validateBundleCapabilityConfigsAgainstBundleCaps(capabilityConfigs, bundleCapIds)`: every entry in `capabilityConfigs` must correspond to a `BundleCapability.id` in `setup.capabilities(probeEnv)`. Build-time sanity check.
- [x] 1.12 Add `evaluateAgentConfigPath(snapshot, path)` helper in a shared util location: pure function, splits `"a.b.c"`, walks the snapshot, returns `undefined` on any miss. Used at runtime AND at build-time validation.
- [x] 1.13 Unit tests for each new validator in `__tests__/validate-config*.test.ts`. Schema kind rejection (`__tests__/validate-schema-kind.test.ts`) — Transform/Constructor/Function each throw with a message naming the path inside the schema. Schema serialization round-trip regression (`__tests__/schema-serialization.test.ts`) — Object + Optional + Union + Literal + Array + Recursive + Unsafe round-trip and `Value.Check` produces identical results pre/post.

## 2. Bundle SDK build-time metadata extraction

- [x] 2.1 In `defineBundleAgent`, extend the existing probe-env capability walk to ALSO collect:
  - Each capability's `configSchema` + `configDefault` → `capabilityConfigs[]`.
  - Each capability's `configNamespaces(probeCtx)` declarations → `configNamespaces[]` (id + description + schema only; get/set stay in code). **Wrap the `configNamespaces(probeCtx)` invocation in try/catch** — on throw, raise `BundleMetadataExtractionError` naming the offending capability id, mirroring the existing `extractBundleSurfaces` pattern from `bundle-http-and-ui-surface`.
- [x] 2.2 Extract `setup.config` directly into `agentConfigSchemas` (no probe-env needed; static record).
- [x] 2.3 Serialize all schemas via `JSON.parse(JSON.stringify(schema))` to drop the TypeBox `Kind` symbol before writing into metadata.
- [x] 2.4 Run all five validators (`validateCapabilityConfigs`, `validateAgentConfigSchemas`, `validateConfigNamespaces`, `validateAgentConfigPaths`, `validateBundleCapabilityConfigsAgainstBundleCaps`) BEFORE writing into metadata. Validation failures throw with descriptive messages.
- [x] 2.5 Update `defineBundleAgent`'s metadata-emission logic: emit each new field independently when non-empty; omit when empty (legacy bundle byte-compatibility).
- [x] 2.6 Unit test `__tests__/define-config-metadata.test.ts`: bundle declaring all three tiers round-trips into metadata; reserved-token namespace throws; cross-collision (capability id == namespace id) throws; bundle declaring no config emits no new fields; `configNamespaces(probeCtx)` that throws raises `BundleMetadataExtractionError`.

## 3. Bundle SDK request/response endpoints

- [x] 3.1 Add `handleConfigChange(request, env, setup)` to `define.ts`: verifies `__BUNDLE_TOKEN`, parses `{ capabilityId, oldCfg, newCfg, sessionId }`, looks up `BundleCapability.hooks.onConfigChange`, returns `{ status: "noop" }` when absent, invokes handler, returns `{ status: "ok" }` on success or `{ status: "error", message }` on exception.
- [x] 3.2 Add `handleAgentConfigChange(request, env, setup)` to `define.ts`: parses `{ capabilityId, oldSlice, newSlice, sessionId }`, invokes `hooks.onAgentConfigChange`, same return shape.
- [x] 3.3 Add `handleConfigNamespaceGet(request, env, setup)` to `define.ts`: parses `{ namespace }`, finds matching `BundleConfigNamespace`, calls `get(namespace)`, returns `{ status: "ok", value }` or `{ status: "error", message }`.
- [x] 3.4 Add `handleConfigNamespaceSet(request, env, setup)` to `define.ts`: parses `{ namespace, value }`, calls `set(namespace, value)`, returns `{ status: "ok", display? }` (where `display?: string` matches the static `set` return type) or `{ status: "error", message }`.
- [x] 3.5 Wire all four endpoints into the `define.ts` fetch handler switch.
- [x] 3.6 Construct `BundleHookContext` for `/config-change` and `/agent-config-change` invocations (mirrors `bundle-runtime-surface`'s hook context — capabilityId, agentId, sessionId, kvStore, channel, spine, publicUrl, emitCost, agentConfig if `agentConfigPath` is set).
- [x] 3.7 Unit tests `__tests__/config-endpoints.test.ts`: each endpoint round-trips a representative payload, returns `noop` when handler absent, returns `error` on handler exception, surfaces `display` string from `set` handler.

## 4. AgentRuntime integration — separate accessor + cache invalidation + hook ordering

- [x] 4.1 Extend `AgentRuntime.getCachedAgentConfigSchema()` to merge static `getAgentConfigSchema()` with the active bundle's `agentConfigSchemas` from metadata. Host wins on key conflict (defense-in-depth — promotion-time guard rejects collisions; this catches the dispatch-time-narrow window before the guard fires).
- [x] 4.2 Add a NEW separate accessor `getBundleCapabilityConfigStandIns(): Capability[]` on `AgentRuntime`. Returns synthetic stand-in entries from the active bundle's `capabilityConfigs` metadata: `{ id, name: id, description: "Bundle-declared capability config", configSchema, configDefault }` and NOTHING ELSE. Caches the result; cache cleared by `bundlePointerRefresher`.
- [x] 4.3 **Do NOT** modify `getCachedCapabilities()` to include stand-ins. The single call site that builds `ConfigContext` (`agent-runtime.ts:1745+`) composes `ConfigContext.capabilities` as `[...this.getCachedCapabilities(), ...this.getBundleCapabilityConfigStandIns()]`. Audit every other consumer of `getCachedCapabilities()` (resolveCapabilities, prompt section assembly, hook iteration, MCP merging, schedule enumeration, inspection panel) and verify NONE see stand-ins.
- [x] 4.4 Extend `AgentRuntime.getConfigNamespaces()` to also include proxies for bundle-declared `configNamespaces`. Each proxy: `{ id, description, schema, get: (ns) => bundleConfigNamespaceDispatcher.get(ns), set: (ns, val) => bundleConfigNamespaceDispatcher.set(ns, val) }`. The proxy `set` returns `string | void` matching the static `ConfigNamespace.set` contract. The host's existing `config-set.ts:166-170` validates `value` against the proxy's `schema` BEFORE calling `set` — verify by reading the existing path.
- [x] 4.5 Extend `bundlePointerRefresher` (in `agent-do.ts:753-761`) to ALSO invalidate `cachedAgentConfigSchema` AND the new `getBundleCapabilityConfigStandIns()` cache. One-line addition matching the existing `validatedVersionId = null` pattern.
- [x] 4.6 In `config/config-set.ts`, after the existing static `cap.hooks.onConfigChange` block (lines 84-114), check whether the capability id is bundle-declared (via `runtime.getBundleCapabilityConfigStandIns().some(c => c.id === id)`). If yes, dispatch through `runtime.bundleConfigChangeDispatcher?.(id, oldCfg, newCfg, sessionId)` BEFORE calling `setCapabilityConfig`. On `{ok: false, error}` return, return `toolResult.error(error)` and DO NOT persist (matches static fail-closed ordering).
- [x] 4.7 In `agent-runtime.ts handleAgentConfigSet`, after the existing static-capability iteration, ALSO iterate bundle-declared capabilities (via `getBundleCapabilityConfigStandIns()` plus reading `agentConfigPath` from metadata). For each one whose `evaluateAgentConfigPath(prior, path)` differs from `evaluateAgentConfigPath(current, path)`, dispatch through `runtime.bundleAgentConfigChangeDispatcher?.(id, oldSlice, newSlice, sessionId)`. Agent-level dispatch is fire-and-await; errors caught + logged; matches static `handleAgentConfigSet` semantics where capability hook errors don't reverse persistence.
- [x] 4.8 Extend `ensureAgentConfigLoaded` (`agent-runtime.ts:984-992`) to validate each persisted `config:agent:{ns}` value against the currently-active schema via `Value.Check`. On mismatch: set snapshot to `Value.Create(currentSchema)`, write orphan record to `config:agent:__orphans` (`{ persistedValue, recordedAt: ISO8601, schemaCheckFailed: true }`), emit `[BundleDispatch] kind: "agent_config_orphan_detected"` log. Do NOT delete the persisted value.
- [x] 4.9 Unit tests `__tests__/runtime-config-merge.test.ts`: schema merge precedence, stand-ins NOT in `getCachedCapabilities()`, stand-ins ARE in `ConfigContext.capabilities`, stand-in cache invalidates on `bundlePointerRefresher`, namespace proxies dispatch via the installed dispatcher with `string | void` return type. `__tests__/ensure-agent-config-orphan.test.ts`: schema mismatch records orphan + emits log + does not delete value.

## 5. Bundle-host promotion-time validators (three SEPARATE collision dimensions)

- [x] 5.1 Add `validateBundleAgentConfigsAgainstKnownIds(declared, known)` to `bundle-host/src/validate-config.ts`: returns `{ valid: true }` or `{ valid: false, collidingNamespaces: [...] }`.
- [x] 5.2 Add `validateBundleConfigNamespacesAgainstKnownIds(declared, known)`: returns `{ valid: true }` or `{ valid: false, collidingIds: [...] }`.
- [x] 5.3 Add `validateBundleCapabilityConfigsAgainstKnownIds(declared, known)`: bundle's `capabilityConfigs.map(c => c.id)` vs. host's REGISTERED capability id set. **Distinct** from `bundle-runtime-surface`'s `validateCatalogAgainstKnownIds` (which checks `requiredCapabilities`). Returns `{ valid: true }` or `{ valid: false, collidingIds: [...] }`.
- [x] 5.4 Add `AgentConfigCollisionError` (`code: "ERR_AGENT_CONFIG_COLLISION"`), `ConfigNamespaceCollisionError` (`code: "ERR_CONFIG_NAMESPACE_COLLISION"`), `CapabilityConfigCollisionError` (`code: "ERR_CAPABILITY_CONFIG_COLLISION"`) classes to bundle-host. Re-export from `bundle-host/src/index.ts` (matches the `RouteCollisionError` re-export pattern from `bundle-http-and-ui-surface`).
- [x] 5.5 Extend `BundleRegistry.setActive` signature with `knownAgentConfigNamespaces?: string[]`, `knownConfigNamespaceIds?: string[]`, AND `knownCapabilityConfigIds?: string[]`. When each is provided AND the version's metadata declares the corresponding bundle field, run the validator; throw on collision; pointer NOT flipped.
- [x] 5.6 Workshop `workshop_deploy` tool reads host's resolved schemas/namespaces/capability ids (via existing accessors) and forwards as the new `setActive` parameters. Cross-deployment promotions explicitly pass `undefined` for all three.
- [x] 5.7 Unit tests `__tests__/validate-bundle-config-collisions.test.ts`: each validator's pass/fail cases, error code shape. Cross-deployment promotion (all three `known*` undefined) succeeds without throwing.

## 6. AgentDO — install dispatchers and dispatch-time guards

- [x] 6.1 In `initBundleDispatch`, install `runtime.bundleConfigChangeDispatcher` (returns `Promise<{ok: boolean; error?: string}>` so the static `config-set.ts` call site can fail-closed), `bundleAgentConfigChangeDispatcher` (returns `Promise<void>`, errors logged), and `bundleConfigNamespaceDispatcher` (`.get` and `.set`; `.set` returns `Promise<string | void>`).
- [x] 6.2 Each dispatcher checks the active bundle pointer first; returns immediately when `null` or when the relevant metadata field is empty. Uses the shared `composeWorkerLoaderConfig` and envelope helpers from `bundle-host/src/serialization.ts`.
- [x] 6.3 Add `BundleConfig.configHookTimeoutMs?: number` knob (default **5 000 ms**, NOT the 30 000 ms `httpDispatchTimeoutMs`). Each dispatcher applies it per dispatch.
- [x] 6.4 Each dispatcher emits structured logs with `[BundleDispatch]` prefix and the appropriate `kind` discriminator (Decision 8) — no separate `[BundleConfig]` prefix.
- [x] 6.5 Extend the existing dispatch-time `validateRoutesAndActionsCached` (or add a sibling `validateConfigDeclarationsCached`) to also check declared `agentConfigSchemas` against `getAgentConfigSchema()` keys (host-only, exclude bundle-merged), declared `configNamespaces` against `getConfigNamespaces()` ids (host-only), declared `capabilityConfigs.id`s against `getResolvedCapabilityIds()` (host capabilities), and declared `agentConfigPath` first segments against the merged schema set (bundle's own + host's). Cache results alongside the route+action cache keyed by `validatedVersionId`.
- [x] 6.6 Add four new disable helpers — `disableForAgentConfigCollision`, `disableForConfigNamespaceCollision`, `disableForCapabilityConfigCollision`, `disableForAgentConfigPathUnresolvable` — each clears the pointer with `skipCatalogCheck: true`, broadcasts `bundle_disabled` with structured reason (codes per Decision 5 + Decision 6), resets failure counter, does NOT increment `consecutiveFailures`.
- [x] 6.7 Hook the new guards into BOTH `bundlePromptHandler` (the `/turn` dispatch path) AND every new dispatcher path so a stale pointer is caught on the next config tool invocation.

## 7. Telemetry (unified [BundleDispatch] prefix)

- [x] 7.1 Add `[BundleDispatch] kind: "config_change"` log on `/config-change` dispatch (agentId, capabilityId, status, durationMs).
- [x] 7.2 Add `[BundleDispatch] kind: "agent_config_change"` log on `/agent-config-change` dispatch (agentId, capabilityId, status, sliceChanged, durationMs).
- [x] 7.3 Add `[BundleDispatch] kind: "namespace_get"` and `kind: "namespace_set"` logs on namespace dispatches.
- [x] 7.4 Add `[BundleDispatch] kind: "config_set_bundle_cap"` log on host persistence after a bundle-cap config set (agentId, capabilityId, durationMs).
- [x] 7.5 Add `[BundleDispatch] kind: "config_set_bundle_ns"` log on host persistence after a bundle-ns agent-config set (agentId, namespace, durationMs).
- [x] 7.6 Add `[BundleDispatch] kind: "schema_extraction_error"` log when build-time probe walk fails.
- [x] 7.7 Add `[BundleDispatch] kind: "agent_config_collision_disable" | "config_namespace_collision_disable" | "capability_config_collision_disable" | "agent_config_path_unresolvable_disable"` logs from dispatch-time guards.
- [x] 7.8 Add `[BundleDispatch] kind: "agent_config_orphan_detected"` log from `ensureAgentConfigLoaded`.

## 8. Tests — host dispatch unit

- [ ] 8.1 `bundle-host/src/__tests__/dispatch-config-change.test.ts`: stub bundle isolate; assert envelope shape, `noop` on absent handler, `error` on bundle exception, fail-closed on `{ok:false}` (host SKIPS persistence), log emission with `kind: "config_change"`.
- [ ] 8.2 `dispatch-agent-config-change.test.ts`: same shape for agent-config; sliceChanged: false skips dispatch; agent-level errors are caught + logged but persistence proceeds.
- [ ] 8.3 `dispatch-config-namespace.test.ts`: round-trips `get` and `set`; surfaces `display` string from set return; returns error on bundle exception; verifies `string | void` return type contract.
- [ ] 8.4 `agent-config-collision-guard.test.ts`: dispatch-time guard fires `ERR_AGENT_CONFIG_COLLISION`, broadcasts `bundle_disabled`, clears pointer.
- [ ] 8.5 `config-namespace-collision-guard.test.ts`: same for namespace collision.
- [ ] 8.6 `capability-config-collision-guard.test.ts`: same for capability-config collision (the new dimension distinct from `requiredCapabilities` catalog check).
- [ ] 8.7 `agent-config-path-unresolvable-guard.test.ts`: dispatch-time guard fires `ERR_AGENT_CONFIG_PATH_UNRESOLVABLE`, broadcasts `bundle_disabled` with capability id + path + known namespaces, clears pointer.
- [ ] 8.8 `agent-runtime/src/__tests__/runtime-config-merge.test.ts`: merged schema set surfaces in `getCachedAgentConfigSchema`, stand-ins NOT in `getCachedCapabilities`, stand-ins ARE in `ConfigContext.capabilities`, namespace proxies dispatch correctly.
- [ ] 8.9 `agent-runtime/src/__tests__/ensure-agent-config-orphan.test.ts`: schema mismatch records orphan + emits log + does not delete value.
- [ ] 8.10 `bundle-pointer-refresher-cache.test.ts`: refresher invalidates `cachedAgentConfigSchema` AND stand-in cache.

## 9. Tests — integration

- [ ] 9.1 `bundle-config-per-capability.test.ts`: bundle with `configSchema` + `onConfigChange`; agent calls `config_set { namespace: "capability:bundle-cap", value }`; bundle's hook fires BEFORE persist; on `{status:"ok"}` value persists; on `{status:"error"}` value does NOT persist and tool returns error. Both paths covered.
- [ ] 9.2 `bundle-config-default.test.ts`: bundle declares `configDefault`; `config_get` returns the default WITHOUT dispatching to the bundle isolate (assert via spy on the dispatcher).
- [ ] 9.3 `bundle-config-agent-level.test.ts`: bundle declares `setup.config: { botConfig }` AND a capability with `agentConfigPath: "botConfig"` + `onAgentConfigChange`; agent calls `config_set { namespace: "botConfig", value }`; bundle's hook fires with the right slice; UI bridge `capability_action { capabilityId: "agent-config", action: "set" }` works equivalently.
- [ ] 9.4 `bundle-config-agent-level-undefined-slice.test.ts`: bundle capability with `agentConfigPath: "missing.field"`, snapshot is `{}`; verify `ctx.agentConfig === undefined` is delivered to the bundle handler without throwing (safe-traversal contract).
- [ ] 9.5 `bundle-config-namespace.test.ts`: bundle declares custom `configNamespaces`; round-trips via the bridge; validation rejects malformed values host-side BEFORE dispatch (assert dispatcher not called on validation failure).
- [ ] 9.6 `bundle-config-shape-2-parity.test.ts`: pick `tavily-web-search` (config-driven shape-2 capability). Run the same `config_set` twice — once against static, once against the bundle-declared form. Assert identical persistence and identical `onConfigChange` payload.
- [ ] 9.7 `bundle-config-collision-e2e.test.ts`: promote a bundle with `agentConfigSchemas: { x }`; redeploy host with static `x` agent-config namespace; first dispatch detects collision, broadcasts `bundle_disabled`, falls back. Then verify persisted value flagged as orphan via `config:agent:__orphans` read.
- [ ] 9.8 `bundle-config-warm-do-promotion.test.ts`: warm DO with bundle pointer null; `applyAgentConfigSet` for a static-only namespace works; promote bundle declaring new namespace; refresher invalidates caches; subsequent `applyAgentConfigSet` for the bundle-declared namespace works without cold restart.
- [ ] 9.9 `bundle-config-telemetry.test.ts`: capture logger calls during a representative bundle config flow; assert each `[BundleDispatch] kind: "..."` entry was emitted with the expected fields.
- [ ] 9.10 `bundle-config-cross-deployment.test.ts`: `setActive` called with all three `known*` undefined — promotion succeeds without throwing; subsequent dispatch-time guards catch any mismatch.

## 10. Examples + docs

- [x] 10.1 Extend `examples/bundle-agent-phase2/bundle-src/index.ts` to declare:
  - One capability with `configSchema` + `configDefault` + `onConfigChange`.
  - One agent-level config namespace via `setup.config: { botConfig }` and a capability with `agentConfigPath: "botConfig"` + `onAgentConfigChange`.
  - One custom `configNamespaces` entry (small key-value store backed by `kvStore`).
  Exercise all three via the example UI's config form.
- [x] 10.2 Update `CLAUDE.md` "Bundle brain override" section: three new metadata fields, `agentConfigPath` declarative-mapping replacement (with safe-traversal note), validation dimensions, four new `bundle_disabled` reason codes (`ERR_AGENT_CONFIG_COLLISION`, `ERR_CONFIG_NAMESPACE_COLLISION`, `ERR_CAPABILITY_CONFIG_COLLISION`, `ERR_AGENT_CONFIG_PATH_UNRESOLVABLE`), schema-serialization note (TypeBox `Kind` symbol drop + Transform/Constructor/Function rejection), `__orphans` reserved key under `config:agent:`, hook ordering matches static (BEFORE persist), `configHookTimeoutMs` knob (5s default).
- [x] 10.3 Update `packages/runtime/bundle-sdk/README.md` with new field examples; document `agentConfigPath` syntax + safe-traversal; document the v1 deferral on pattern-matched namespaces; document bundle-author migration responsibility on schema changes; document the dual-API state for `agentConfigMapping` (static function) vs `agentConfigPath` (bundle declarative).
- [x] 10.4 Add a "Bundle config" section to the bundle authoring guide target. For now, add to `bundle-sdk/README.md`.

## 11. Verification

- [x] 11.1 Run `bun run lint` and `bun run typecheck` at repo root — must pass.
- [x] 11.2 Run `bun run test` at repo root — must pass.
- [x] 11.3 Manually exercise via the basic-agent example: deploy a bundle from task 10.1; open the agent UI, edit each config tier through the form, confirm persistence and hook fires through the example's debug panel + logs.
- [x] 11.4 Confirm `examples/bundle-agent-phase2/bundle-src/index.ts` builds via `workshop_build` without validation errors.
