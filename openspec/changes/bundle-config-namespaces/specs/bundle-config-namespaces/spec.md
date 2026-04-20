## ADDED Requirements

### Requirement: BundleCapability SHALL support configSchema, configDefault, and onConfigChange

`BundleCapability` SHALL accept:
- `configSchema?: TObject` — TypeBox schema for per-capability configuration. Promoted from `@deferred` to active.
- `configDefault?: Record<string, unknown>` — default value matching `configSchema`. Returned by `config_get` when no value is persisted.
- `hooks.onConfigChange?: (oldConfig: Record<string, unknown>, newConfig: Record<string, unknown>, ctx: BundleHookContext) => Promise<void>` — fires after the host's `config_set` validates and persists a new value.

The host SHALL store bundle-declared capability configs under the existing `config:capability:{id}` ConfigStore key — same shape as static.

#### Scenario: Bundle declares per-capability config and config_set succeeds

- **WHEN** the host receives `config_set { namespace: "capability:my-bundle-cap", value: {...} }` and the active bundle declares `BundleCapability { id: "my-bundle-cap", configSchema, hooks.onConfigChange }`
- **THEN** the host SHALL validate against `configSchema`, persist to `config:capability:my-bundle-cap`, and fire the bundle's `onConfigChange` via the spine bridge with `(oldCfg, newCfg, ctx)`

#### Scenario: config_get returns configDefault when nothing is persisted

- **WHEN** the host receives `config_get { namespace: "capability:my-bundle-cap" }`, no value is persisted, and the bundle declared `configDefault: { foo: "bar" }`
- **THEN** the host SHALL return `{ foo: "bar" }` from the synthetic stand-in's `configDefault` field (resolved via `getBundleCapabilityConfigStandIns()`) without dispatching to the bundle isolate

### Requirement: BundleAgentSetup SHALL support agent-level config schemas

`BundleAgentSetup` SHALL accept `config?: Record<string, TObject>` matching the shape of `defineAgent`'s `config` field. Each top-level key declares an agent-level config namespace whose value persists under `config:agent:{namespace}`.

`BundleCapability` SHALL accept `agentConfigPath?: string` — a dotted-path expression evaluated host-side against the agent-config snapshot to derive the capability's mapped slice. When omitted, `ctx.agentConfig` is `undefined`.

`BundleCapabilityHooks` SHALL accept `onAgentConfigChange?: (oldSlice: unknown, newSlice: unknown, ctx: BundleHookContext) => Promise<void>` — fires after `applyAgentConfigSet` succeeds AND the path-evaluated slice changed.

The host SHALL merge bundle-declared agent-config schemas with its own `getAgentConfigSchema()` at runtime construction. Both contribute to `config_schema` output and to the `capability_action { capabilityId: "agent-config", action: "set" }` UI bridge.

#### Scenario: Bundle declares agent-config namespace and config_set succeeds

- **WHEN** the active bundle declares `setup.config: { botConfig: Type.Object({ rateLimit: Type.Number() }) }` and the host receives `config_set { namespace: "botConfig", value: { rateLimit: 10 } }`
- **THEN** the host SHALL validate against the bundle's schema, persist to `config:agent:botConfig`, update `agentConfigSnapshot`, and fire `onAgentConfigChange` on every bundle capability whose `agentConfigPath` resolves to a slice that changed

#### Scenario: agentConfigPath projection delivers a slice

- **WHEN** the agent-config snapshot is `{ botConfig: { rateLimit: 10 } }` and a bundle capability declares `agentConfigPath: "botConfig"`
- **THEN** the capability's `BundleHookContext.agentConfig` SHALL equal `{ rateLimit: 10 }`

#### Scenario: agentConfigPath unresolvable returns undefined (safe-traversal)

- **WHEN** the snapshot is `{}` and the path is `"botConfig.rateLimit"`
- **THEN** `evaluateAgentConfigPath({}, "botConfig.rateLimit")` SHALL return `undefined` without throwing AND `ctx.agentConfig` SHALL equal `undefined`. **Bundle authors MUST handle `ctx.agentConfig === undefined` defensively** — same defensive contract as static `agentConfigMapping` returning `undefined`.

### Requirement: BundleCapability SHALL support custom configNamespaces with cross-isolate get/set

`BundleCapability` SHALL accept `configNamespaces?: (ctx: BundleContext) => BundleConfigNamespace[]`. Each `BundleConfigNamespace` SHALL be `{ id: string; description: string; schema: TObject; get: (namespace: string) => Promise<unknown>; set: (namespace: string, value: unknown) => Promise<string | void> }`.

Pattern-matched namespaces (regex-based, like static `ConfigNamespace.pattern`) are NOT supported in v1 (Non-Goal — defer).

The host's `config_set`/`config_get` tools SHALL extend their namespace lookup to also consult `version.metadata.configNamespaces`. On match:
- For `config_set`: validate against the declared schema host-side; on success, mint `__BUNDLE_TOKEN`, POST to `/config-namespace-set` with `{ namespace, value }`; surface bundle's response.
- For `config_get`: mint token, POST to `/config-namespace-get` with `{ namespace }`; return bundle's `value`.

#### Scenario: Bundle config namespace get round-trips

- **WHEN** the bundle declares `configNamespaces: () => [{ id: "telegram-accounts", schema, get, set }]` and the host receives `config_get { namespace: "telegram-accounts" }`
- **THEN** the host SHALL dispatch to the bundle's `/config-namespace-get`, return the bundle's value

#### Scenario: Bundle config namespace set validates host-side before dispatch

- **WHEN** the host receives `config_set { namespace: "telegram-accounts", value: {...invalid...} }` and the bundle's declared schema rejects the value
- **THEN** the host SHALL return a validation error from `config_set` and SHALL NOT dispatch to the bundle

### Requirement: defineBundleAgent SHALL emit BundleMetadata.capabilityConfigs, agentConfigSchemas, configNamespaces

`defineBundleAgent` SHALL emit three NEW top-level metadata fields:
- `capabilityConfigs?: Array<{ id: string; schema: object; default?: Record<string, unknown> }>` — derived from walking `setup.capabilities(probeEnv)` and collecting capabilities with non-empty `configSchema`. Schemas serialized via JSON.stringify+parse to drop the TypeBox `Kind` symbol.
- `agentConfigSchemas?: Record<string, object>` — derived from `setup.config`, schemas similarly serialized.
- `configNamespaces?: Array<{ id: string; description: string; schema: object }>` — derived from each capability's `configNamespaces(probeCtx)` declaration. Note: only the metadata projection is emitted; the `get`/`set` handlers stay in the bundle code.

Each field SHALL be omitted when empty so legacy bundles remain byte-identical in their metadata payload.

#### Scenario: Bundle declares one capability config, one agent namespace, one custom namespace

- **WHEN** a bundle declares `BundleCapability { id: "x", configSchema, configNamespaces: () => [{ id: "y", ... }] }` AND `setup.config: { z: schema }`
- **THEN** the metadata SHALL contain `capabilityConfigs: [{ id: "x", schema, ... }]`, `agentConfigSchemas: { z: schema }`, `configNamespaces: [{ id: "y", description, schema }]`

#### Scenario: Schema serialization drops the TypeBox Kind symbol

- **WHEN** `defineBundleAgent` extracts a TypeBox schema with the `Kind` symbol set
- **THEN** the metadata SHALL contain the schema as plain JSON (no symbols), AND host-side `Value.Check(schema, value)` SHALL produce the same pass/fail outcome as against the original `TObject`

### Requirement: defineBundleAgent SHALL reject reserved tokens and intra-bundle collisions at build time

The bundle SDK's `validateAgentConfigSchemas`, `validateConfigNamespaces`, `validateCapabilityConfigs`, `validateAgentConfigPaths` helpers SHALL reject:
- An agent-config namespace id equal to `session`, starting with `capability:`, OR equal to any of `agent-config`, `schedules`, `queue` (host built-in `capability_action` ids — verified against `agent-runtime.ts handleCapabilityAction` switch).
- An agent-config namespace id colliding with one of the bundle's own `BundleCapability.id`s (would conflict with `capability:{id}` namespace shape).
- An agent-config namespace id colliding with one of the bundle's own `surfaces.actionCapabilityIds` (would route both `config_set` and `capability_action` ambiguously).
- A `configNamespaces[].id` equal to `session`, `agent-config`, `schedules`, `queue`, equal to one of the bundle's own agent-config namespace ids, or equal to one of the bundle's own capability ids.
- A `configNamespaces[]` entry declaring a `pattern` field (regex-based, deferred to a follow-up).
- A `BundleCapability.configDefault` that does not validate against the same capability's `configSchema`.
- A `BundleCapability.configSchema` whose JSON shape contains a TypeBox `Kind` value of `Transform`, `Constructor`, or `Function` (these carry runtime closures that silently drop on JSON serialization). The walk recurses into `properties`, `items`, `anyOf`. The same check applies to `setup.config[ns]` schemas and to `configNamespaces[].schema`.
- A `BundleCapability.agentConfigPath` whose first segment does not match a top-level namespace in the bundle's own `setup.config`. (Build-time emits no warning for cross-bundle paths — they may target host-declared namespaces; the dispatch-time guard catches truly unresolvable paths with `ERR_AGENT_CONFIG_PATH_UNRESOLVABLE`.)

Validation failures SHALL throw at `defineBundleAgent` evaluation time with a descriptive error naming the offending capability id and the offending entry.

#### Scenario: Bundle declares an agent-config namespace named "session"

- **WHEN** a bundle declares `setup.config: { session: schema }`
- **THEN** `defineBundleAgent` SHALL throw with a message naming `session` as a reserved token

#### Scenario: Bundle declares configNamespace id matching a capability id

- **WHEN** a bundle declares `BundleCapability { id: "files", configNamespaces: () => [{ id: "files", ... }] }`
- **THEN** `defineBundleAgent` SHALL throw with a message naming the collision

#### Scenario: Bundle's configDefault doesn't validate against configSchema

- **WHEN** a bundle declares `configSchema: Type.Object({ count: Type.Number() })` AND `configDefault: { count: "ten" }`
- **THEN** `defineBundleAgent` SHALL throw with a validation error naming the capability id

#### Scenario: agentConfigPath first segment doesn't resolve in the bundle's own schemas (and no host namespace)

- **WHEN** a bundle declares `setup.config: { botConfig: ... }` AND a capability with `agentConfigPath: "missingNs.field"` AND there is also no host-declared `missingNs` namespace at dispatch time
- **THEN** the dispatch-time guard SHALL fire `ERR_AGENT_CONFIG_PATH_UNRESOLVABLE`, clear the bundle pointer, broadcast `bundle_disabled` with `reason: { code, capabilityId, path, knownNamespaces }`, and fall back to static. Build-time does NOT throw — the path may legitimately target a host namespace.

#### Scenario: configSchema declares a TypeBox Transform Kind

- **WHEN** a capability's `configSchema` is `Type.Transform(Type.String(), { Decode: (s) => parseInt(s) })`
- **THEN** `defineBundleAgent` SHALL throw naming the capability id and the offending Kind (`Transform`)

#### Scenario: configNamespaces declares a pattern field

- **WHEN** a bundle declares `configNamespaces: () => [{ id: "schedule", pattern: /^schedule:/, ... }]`
- **THEN** `defineBundleAgent` SHALL throw naming the namespace id and the deferred-feature note

### Requirement: BundleRegistry.setActive SHALL validate bundle config schemas against host registered surfaces (three separate dimensions)

`BundleRegistry.setActive` SHALL accept three additional optional parameters: `knownAgentConfigNamespaces?: string[]`, `knownConfigNamespaceIds?: string[]`, AND `knownCapabilityConfigIds?: string[]`. When each is provided AND the version's metadata declares the corresponding bundle field, the registry SHALL run the matching validator and throw on collision:
- `validateBundleAgentConfigsAgainstKnownIds` → `AgentConfigCollisionError` (`code: "ERR_AGENT_CONFIG_COLLISION"`)
- `validateBundleConfigNamespacesAgainstKnownIds` → `ConfigNamespaceCollisionError` (`code: "ERR_CONFIG_NAMESPACE_COLLISION"`)
- `validateBundleCapabilityConfigsAgainstKnownIds` → `CapabilityConfigCollisionError` (`code: "ERR_CAPABILITY_CONFIG_COLLISION"`)

The active pointer SHALL NOT be flipped on any collision.

The `knownCapabilityConfigIds` check is **distinct** from `bundle-runtime-surface`'s `knownCapabilityIds` (which validates `requiredCapabilities`). The new check validates the bundle's own `capabilityConfigs.id` set against the host's registered capability id set — a bundle CANNOT declare `configSchema` for an id the host already owns (would create silent dual-write to `config:capability:{id}`).

#### Scenario: Bundle agent-config namespace collides with a host-declared one

- **WHEN** the bundle declares `agentConfigSchemas: { tavily: schema }` and the host already declares `tavily` in `getAgentConfigSchema()`
- **THEN** `setActive` SHALL throw with `code: "ERR_AGENT_CONFIG_COLLISION"` and the active pointer SHALL remain unchanged

#### Scenario: Bundle configNamespace collides with a host-registered consumer namespace

- **WHEN** the bundle declares `configNamespaces: [{ id: "telegram-accounts" }]` and the host registers a consumer namespace with the same id
- **THEN** `setActive` SHALL throw with `code: "ERR_CONFIG_NAMESPACE_COLLISION"` and the active pointer SHALL remain unchanged

#### Scenario: Bundle capability-config id collides with a host-registered capability id

- **WHEN** the bundle declares `capabilities: () => [{ id: "my-counter", configSchema, ... }]` AND the host has a static capability registered with `id: "my-counter"`
- **THEN** `setActive` SHALL throw with `code: "ERR_CAPABILITY_CONFIG_COLLISION"` and the active pointer SHALL remain unchanged

#### Scenario: Cross-deployment promotion explicitly skips checks

- **WHEN** `setActive` is called with `knownAgentConfigNamespaces: undefined` AND `knownConfigNamespaceIds: undefined` AND `knownCapabilityConfigIds: undefined`
- **THEN** the registry SHALL skip the corresponding validations and proceed with the promotion

### Requirement: AgentRuntime SHALL merge bundle-declared config schemas into the config tools (separate accessor for stand-ins)

`AgentRuntime`'s `getCachedAgentConfigSchema()` SHALL return the union of static `getAgentConfigSchema()` and the active bundle's `agentConfigSchemas`. On key conflict, the host's entry wins in the merged map AND the next bundle dispatch attempt SHALL fire the dispatch-time guard `ERR_AGENT_CONFIG_COLLISION` (which clears the pointer with `bundle_disabled`). Cache invalidation: `cachedAgentConfigSchema` SHALL be invalidated whenever `bundlePointerRefresher` fires.

`AgentRuntime` SHALL expose a NEW separate accessor `getBundleCapabilityConfigStandIns(): Capability[]` returning synthetic stand-in entries for bundle-declared `capabilityConfigs`. Each stand-in SHALL carry `id`, `name` (= id), `description` (`"Bundle-declared capability config"`), `configSchema`, `configDefault` and SHALL NOT carry `tools`/`promptSections`/`hooks`/`schedules`/`mcpServers`/`httpHandlers`/`onAction`. The stand-in cache SHALL be invalidated whenever `bundlePointerRefresher` fires.

`AgentRuntime` SHALL NOT merge bundle stand-ins into `getCachedCapabilities()` — they are visible ONLY through `getBundleCapabilityConfigStandIns()`. The single call site that builds `ConfigContext` (in the agent-runtime tool-surface assembly path) SHALL compose `ConfigContext.capabilities` as `[...this.getCachedCapabilities(), ...this.getBundleCapabilityConfigStandIns()]` so the config tools can resolve stand-ins via `ctx.capabilities.find`. Nowhere else (prompt resolution, hook iteration, MCP merging, schedule enumeration, inspection panel) shall see the stand-ins.

`AgentRuntime`'s `getConfigNamespaces()` SHALL return the union of static namespaces and proxies for bundle-declared `configNamespaces`. Each proxy's `get`/`set` dispatches through the bridge to the bundle. The proxies' `set` SHALL return `string | void` matching the static `ConfigNamespace.set` contract.

#### Scenario: config_schema returns merged schema set

- **WHEN** the host has static agent-config namespace `tavily`, the bundle declares `botConfig`, both have unique ids
- **THEN** the `config_schema` tool's full listing SHALL include both, and `config_schema { namespace: "botConfig" }` SHALL return the bundle's schema

#### Scenario: config_set on a bundle capability dispatches the change hook through the bridge BEFORE persist

- **WHEN** the host receives `config_set { namespace: "capability:bundle-cap", value }` and bundle declares `bundle-cap` with `onConfigChange`
- **THEN** the host SHALL FIRST dispatch to the bundle's `/config-change` endpoint; on `{status: "ok"}` THEN persist via `ConfigStore`. On `{status: "error"}` or dispatch timeout the host SHALL return an error from `config_set` and SHALL NOT persist (matches static `config-set.ts:103-117` ordering).

#### Scenario: Stand-ins are NOT visible to non-config consumers

- **WHEN** a bundle declares `capabilityConfigs: [{ id: "x", schema, ... }]` and the host invokes `getCachedCapabilities()` (e.g. for prompt section assembly)
- **THEN** the returned array SHALL NOT contain a stand-in for `x` — only `getBundleCapabilityConfigStandIns()` returns it

#### Scenario: Bundle promotion on a warm DO surfaces in agent-config

- **WHEN** a bundle is promoted while a DO is warm (cached agent-config schema already populated for the static-only set)
- **THEN** `bundlePointerRefresher` SHALL invalidate `cachedAgentConfigSchema` AND the stand-in cache so subsequent `applyAgentConfigSet` and `config_set` calls see the bundle's new namespaces and stand-ins

### Requirement: AgentDO SHALL install dispatch paths for /config-change, /agent-config-change, /config-namespace-get, /config-namespace-set

`initBundleDispatch` SHALL install three new dispatchers on the runtime:
- `bundleConfigChangeDispatcher?: (capabilityId, oldCfg, newCfg, sessionId) => Promise<{ ok: boolean; error?: string }>` — POSTs to bundle `/config-change`. **Fired BEFORE the host's `ConfigStore` persistence**, mirroring static `config-set.ts:103-117` ordering. Returns `{ok: false, error}` when bundle handler errors or dispatch times out — host returns the error from `config_set` and SKIPS persistence.
- `bundleAgentConfigChangeDispatcher?: (capabilityId, oldSlice, newSlice, sessionId) => Promise<void>` — POSTs to bundle `/agent-config-change`. Fired from `handleAgentConfigSet` for each bundle capability with a path-evaluated slice change. Agent-level dispatch is fire-and-await (errors logged, snapshot already mutated; matches static `handleAgentConfigSet` semantics where capability hook errors are caught + logged but don't reverse the persistence).
- `bundleConfigNamespaceDispatcher?: { get: (namespace) => Promise<unknown>; set: (namespace, value) => Promise<string | void> }` — POSTs to `/config-namespace-get` or `/config-namespace-set`. Used by the proxy installed in `getConfigNamespaces()`. The `set` return type matches the static `ConfigNamespace.set` contract (`string | void`).

Each dispatcher mints the unified `__BUNDLE_TOKEN`, decodes the envelope via `composeWorkerLoaderConfig`, and applies the new `BundleConfig.configHookTimeoutMs` per dispatch (default **5 000 ms** — config UX expects sub-second; SEPARATE from the 30-000-ms `httpDispatchTimeoutMs` used for HTTP request forwarding). Emits structured `[BundleDispatch]` logs with `kind` discriminator (Decision 8).

#### Scenario: onConfigChange dispatch error rejects the write

- **WHEN** the bundle's `/config-change` handler returns `{ status: "error", message: "validation failed" }` OR exceeds `configHookTimeoutMs`
- **THEN** the dispatcher SHALL emit `[BundleDispatch] kind: "config_change"` log with `status: "error"`, AND the host's `config_set` tool SHALL return that error to the agent, AND the host SHALL NOT persist the value to `ConfigStore` (matches static behavior — hook can refuse a write)

### Requirement: Bundle SDK SHALL serve /config-change, /agent-config-change, /config-namespace-get, /config-namespace-set endpoints

The bundle SDK's fetch handler SHALL serve four new POST endpoints, each verifying `__BUNDLE_TOKEN` and parsing a JSON envelope:
- `/config-change` — `{ capabilityId, oldCfg, newCfg, sessionId }`. Looks up matching `BundleCapability.hooks.onConfigChange`, invokes it. Returns `{ status: "ok" }` or `{ status: "noop" }` (no handler) or `{ status: "error", message }`.
- `/agent-config-change` — `{ capabilityId, oldSlice, newSlice, sessionId }`. Same shape with `onAgentConfigChange`.
- `/config-namespace-get` — `{ namespace }`. Looks up matching `BundleConfigNamespace`, calls `get(namespace)`. Returns `{ status: "ok", value }` or `{ status: "error", message }`.
- `/config-namespace-set` — `{ namespace, value }`. Calls `set(namespace, value)`. Returns `{ status: "ok", display? }` or `{ status: "error", message }`.

#### Scenario: /config-change with a bundle that has no onConfigChange handler

- **WHEN** POST `/config-change` arrives for a capability whose `hooks.onConfigChange` is undefined
- **THEN** the SDK SHALL respond `200` with `{ status: "noop" }`

#### Scenario: /config-namespace-get returns the bundle's value

- **WHEN** POST `/config-namespace-get { namespace: "telegram-accounts" }` arrives and the bundle's `get` returns `[{ id: "a" }]`
- **THEN** the SDK SHALL respond with `{ status: "ok", value: [{ id: "a" }] }`

### Requirement: Dispatch-time guards SHALL fire bundle_disabled with structured reason on agent-config / config-namespace collision

When the host's currently-resolved agent-config schema set OR consumer-namespace set differs from the bundle's metadata declaration (newly-deployed host static config, out-of-band registry write, cold start with stale pointer), the dispatch-time guard SHALL detect the collision on the next bundle dispatch attempt.

On detection:
- `disableForAgentConfigCollision` clears the pointer with `skipCatalogCheck: true`, broadcasts `bundle_disabled` with `reason: { code: "ERR_AGENT_CONFIG_COLLISION", collidingNamespaces: [...], versionId }`, falls back to static.
- `disableForConfigNamespaceCollision` clears the pointer, broadcasts `reason: { code: "ERR_CONFIG_NAMESPACE_COLLISION", collidingIds: [...], versionId }`.

Neither guard SHALL increment `consecutiveFailures` (deterministic mismatch).

#### Scenario: Host newly declares an agent-config namespace shadowing a bundle's

- **WHEN** an already-promoted bundle declares `agentConfigSchemas: { botConfig: ... }` and the host is redeployed with a static `botConfig` agent-config namespace
- **THEN** the next bundle dispatch attempt SHALL detect the collision, clear the pointer, broadcast `bundle_disabled` with `ERR_AGENT_CONFIG_COLLISION`, and fall back to static

### Requirement: Functional parity with static shape-2 capability config

A config-driven shape-2 capability consumed statically vs. declared in a bundle SHALL accept the same `config_set` traffic, fire `onConfigChange` with the same payload, and persist to the same `config:capability:{id}` storage shape.

#### Scenario: Tavily config round-trips both ways

- **WHEN** a regression test consumes `tavily-web-search` once via static `defineAgent({ capabilities: () => [tavily(...)] })` (which has `configSchema` for `defaultDepth`/`maxResults`) and once via a bundle declaring `BundleCapability { id: "tavily-web-search", configSchema, hooks.onConfigChange, ... }`
- **THEN** both flows SHALL accept the same `config_set { namespace: "capability:tavily-web-search", value: { defaultDepth: "advanced" } }`, fire `onConfigChange` with the same `(oldCfg, newCfg)`, and persist to the same key

### Requirement: Telemetry SHALL log every config dispatch boundary with [BundleDispatch] prefix and structured kind

The host SHALL emit structured logs with the `[BundleDispatch]` prefix and a structured `kind` field discriminator at:
- `kind: "config_change"` — `{ agentId, capabilityId, status, durationMs }` after the bridge dispatch.
- `kind: "agent_config_change"` — `{ agentId, capabilityId, status, sliceChanged: boolean, durationMs }`.
- `kind: "namespace_get" | "namespace_set"` — `{ namespace, status, durationMs }`.
- `kind: "config_set_bundle_cap"` — `{ agentId, capabilityId, durationMs }` after persistence.
- `kind: "config_set_bundle_ns"` — `{ agentId, namespace, durationMs }` after persistence.
- `kind: "schema_extraction_error"` — `{ capabilityId, error }` from the build-time probe walk.
- `kind: "agent_config_collision_disable" | "config_namespace_collision_disable" | "capability_config_collision_disable" | "agent_config_path_unresolvable_disable"` — `{ versionId, collidingIds | path | knownNamespaces }` from dispatch-time guards.

#### Scenario: Successful config_set on a bundle agent-config namespace logs

- **WHEN** the host persists a successful `config_set` against a bundle-declared agent-config namespace
- **THEN** the host SHALL emit `[BundleDispatch] kind: "config_set_bundle_ns"` with `{ agentId, namespace, durationMs }`

#### Scenario: Tests assert log shape

- **WHEN** an integration test exercises each dispatch path
- **THEN** it SHALL capture the logger calls and assert the corresponding `[BundleDispatch] kind: "..."` entry was emitted with the expected fields

### Requirement: ensureAgentConfigLoaded SHALL detect schema-incompatible persisted values and record orphans

When `ensureAgentConfigLoaded` reads a persisted `config:agent:{ns}` value and `Value.Check(currentSchema, persistedValue)` returns `false`:
- The snapshot value SHALL be set to `Value.Create(currentSchema)` (the schema's default) so callers get a usable snapshot.
- The persisted value SHALL NOT be deleted.
- An orphan record SHALL be written to `config:agent:__orphans` keyed by namespace: `{ persistedValue, recordedAt: ISO8601 string, schemaCheckFailed: true }`.
- A structured warning log SHALL fire: `[BundleDispatch] kind: "agent_config_orphan_detected"` with `{ namespace, persistedShape: typeof persistedValue }`.

This handles the case where a bundle declared an agent-config namespace, persisted data, and was later disabled by collision with a host-declared namespace using a different schema. The persisted data is preserved so the operator can roll back the host change and re-promote the bundle, OR explicitly migrate.

The `__orphans` reserved key SHALL be documented in CLAUDE.md as a framework-managed agent-config storage key.

#### Scenario: Orphan detected on schema mismatch

- **WHEN** a previously-persisted `config:agent:botConfig` value `{x: 1}` no longer validates against the currently-active `botConfig` schema (e.g. host took over the namespace with a different schema after disabling the bundle)
- **THEN** `ensureAgentConfigLoaded` SHALL set `agentConfigSnapshot.botConfig` to the current schema's default, write `{ persistedValue: {x:1}, recordedAt, schemaCheckFailed: true }` to `config:agent:__orphans`, AND emit `[BundleDispatch] kind: "agent_config_orphan_detected"` log

### Requirement: Dispatch-time guard SHALL detect unresolvable agentConfigPath

When `validateAgentConfigPathsCached` runs on first dispatch after a pointer change AND a bundle capability's `agentConfigPath` first segment doesn't resolve in EITHER the bundle's own `agentConfigSchemas` OR the host's currently-resolved `getAgentConfigSchema()`, the dispatch-time guard SHALL fire `ERR_AGENT_CONFIG_PATH_UNRESOLVABLE` via `disableForAgentConfigPathUnresolvable`.

The disable handler clears the bundle pointer with `skipCatalogCheck: true`, broadcasts `bundle_disabled` with `reason: { code: "ERR_AGENT_CONFIG_PATH_UNRESOLVABLE", capabilityId, path, knownNamespaces, versionId }`, falls back to static, and does NOT increment `consecutiveFailures`.

#### Scenario: Bundle capability path doesn't resolve in either bundle or host schemas

- **WHEN** a bundle capability declares `agentConfigPath: "missing.field"` and neither the bundle's own `setup.config` nor the host's `getAgentConfigSchema()` declares a top-level `missing` namespace
- **THEN** the next bundle dispatch attempt SHALL fire `ERR_AGENT_CONFIG_PATH_UNRESOLVABLE`, broadcast `bundle_disabled` with structured reason naming the capability + path + known namespaces, and fall back to static

### Requirement: Bundle authoring guide SHALL document the v1 limits and workarounds

The bundle authoring guide SHALL document:
- The three config tiers and their bundle-side equivalents (`configSchema` + `configDefault`, `setup.config` + `agentConfigPath`, `configNamespaces`).
- The `agentConfigPath` declarative-mapping replacement for `agentConfigMapping` and the project-then-derive workaround for non-projection mappings.
- The reserved-token list for agent-config namespaces (`session`, `capability:*`).
- Pattern-matched `configNamespaces` are not supported in v1; document the deferral.
- Schema serialization drops the TypeBox `Kind` symbol; explain the `Value.Check` compatibility note.
- Bundle is responsible for its own config migrations across schema changes; framework does not auto-migrate.

#### Scenario: Bundle author reads the config section before adding a config-driven capability

- **WHEN** a bundle author opens the bundle authoring guide for the config surface
- **THEN** they SHALL find worked examples for all three config tiers, the reserved-token list, the `agentConfigPath` syntax, and the v1 deferrals
