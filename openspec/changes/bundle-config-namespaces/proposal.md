## Why

The bundle authoring API today has no path to declare typed configuration. Static `Capability` exposes three layers — per-capability `configSchema` + `configDefault` + `onConfigChange`, agent-level `config` namespaces declared on `defineAgent` (with `agentConfigMapping` + `onAgentConfigChange` per capability), and capability-contributed `configNamespaces` (exact or pattern-matched custom namespaces with their own `get`/`set`). The bundle SDK has a `BundleCapability.configSchema?` field that's marked `@deferred — no consumer in v2`, and nothing else.

This blocks any bundle author trying to ship a config-driven capability the way every shape-2 capability ships today (telegram channel rate-limit policy, doom-loop-detection thresholds, tool-output-truncation cap, tavily search defaults, heartbeat cron). Without bundle-declared config:
- The end-user cannot edit the bundle's per-capability config from the agent UI
- The bundle cannot react to agent-level config changes the host already has wired up
- The bundle cannot expose its own config namespace with custom storage semantics (e.g. "telegram-accounts" pattern-matched)

This change closes the gap. Bundles get the same three-layer config model as static — schemas serialize across the isolate boundary as JSON Schema (TypeBox is JSON-Schema-compatible by design), validation runs host-side against the serialized schemas, and config-mutation hooks fire via the existing host-hook-bus bridge.

## What Changes

### Per-capability config (Phase A)
- Promote `BundleCapability.configSchema` from `@deferred` to active. Add `configDefault?: Record<string, unknown>` matching the static shape.
- Bundle author writes `BundleCapability { id: "my-cap", configSchema: Type.Object({...}), configDefault: {...}, hooks: { onConfigChange?: async (oldCfg, newCfg, ctx) => ... } }`.
- `defineBundleAgent` walks `setup.capabilities(probeEnv)` at build time, extracts each capability's `configSchema` (TypeBox `TObject` is serializable JSON Schema with caveats; see Decision 1) and `configDefault`, emits them into a NEW top-level field `BundleMetadata.capabilityConfigs?: Array<{ id, schema, default? }>`.
- Host reads `BundleMetadata.capabilityConfigs` at dispatch time, makes them available to the existing `config_get`/`config_set`/`config_schema` tools via a NEW separate accessor `getBundleCapabilityConfigStandIns()` consumed ONLY by the config tools — **NOT merged into `getCachedCapabilities()`**, which would leak phantom capabilities into prompt resolution, hook iteration, MCP merging, and the inspection panel.
- When `config_set` writes a bundle-declared per-capability config, the host fires the bundle's `onConfigChange` via a new dispatch RPC. **Hook fires BEFORE the `ConfigStore` write** (matches static `config-set.ts:103-117` ordering exactly — hook can throw to reject the write). Persistence happens only after the hook returns successfully.

### Agent-level config (Phase B)
- Add `BundleAgentSetup.config?: Record<string, TObject>` matching the shape of `defineAgent`'s `config` field. Bundles can declare top-level agent config namespaces.
- `defineBundleAgent` extracts and emits into a NEW top-level field `BundleMetadata.agentConfigSchemas?: Record<string, TObject>`.
- Host merges `BundleMetadata.agentConfigSchemas` with its own `getAgentConfigSchema()` at runtime construction. Validation, persistence (`config:agent:{ns}` ConfigStore key), and broadcast all reuse the existing host pipeline. UI form generation works automatically.
- Add `BundleCapability.agentConfigPath?: string` — a dotted-path string (e.g. `"botConfig.rateLimit"`) the host evaluates against the agent-config snapshot to derive the capability's mapped slice. Replaces the `agentConfigMapping: (snapshot) => slice` function from static (functions cannot serialize across isolate; declarative paths can). When omitted, the capability does not receive an agent-config slice.
- Add `BundleCapabilityHooks.onAgentConfigChange?: (oldSlice, newSlice, ctx) => Promise<void>`. Host fires via the same spine-bridge pattern after `applyAgentConfigSet` succeeds and the slice changed.

### Capability-contributed configNamespaces (Phase C)
- Add `BundleCapability.configNamespaces?: (ctx: BundleContext) => BundleConfigNamespace[]`.
- `BundleConfigNamespace` shape mirrors static `ConfigNamespace` minus `pattern` for v1 (regex doesn't trivially serialize; defer pattern-matched namespaces to a follow-up — pattern-matched is rare; only `prompt-scheduler`'s `schedule:{id}` uses it).
- `get` and `set` are bundle-side functions invoked via cross-isolate RPC: host's existing `config_set`/`config_get` find a matching bundle-declared namespace, mint the unified `__BUNDLE_TOKEN`, POST to a new `/config-namespace-get` or `/config-namespace-set` endpoint on the bundle, the bundle SDK looks up the declared namespace and invokes its handler.
- `defineBundleAgent` extracts namespace shapes (id + description + schema + flag indicating whether get/set are declared) at build time into `BundleMetadata.configNamespaces?: Array<{ id, description, schema }>`. Host fast-skips dispatch when nothing is declared.

### Build-time validation
- `validateCapabilityConfigs(capabilityConfigs)` — rejects capabilities whose `configDefault` doesn't validate against the declared `configSchema`. Also rejects schemas containing TypeBox `Kind: "Transform"`, `Kind: "Constructor"`, or `Kind: "Function"` constructs — these carry runtime closures (`Decode`/`Encode` functions) that silently drop on JSON-stringify+parse, so the schema would round-trip with lost behavior. Plain Object/String/Number/Boolean/Array/Literal/Union/Optional/Recursive/Unsafe schemas pass.
- `validateAgentConfigSchemas(schemas)` — rejects namespace ids that collide with reserved tokens. **Reserved tokens (verified against `agent-runtime.ts handleCapabilityAction`):** `session`, anything matching `/^capability:/` prefix, `agent-config`, `schedules`, `queue` (the three host built-in `capability_action` ids — would route both `config_set` AND `capability_action` ambiguously). Also rejects collisions against the bundle's own `BundleCapability.id`s (would conflict with `capability:{id}` namespace shape) and against the bundle's own `surfaces.actionCapabilityIds`.
- `validateConfigNamespaces(namespaces)` — rejects ids equal to `session`, `agent-config`, `schedules`, `queue`, ids overlapping with declared agent-level namespaces, ids overlapping with the bundle's own capability ids. Also rejects any namespace declaring a `pattern` field (regex-based, deferred — Non-Goal).
- `validateBundleCapabilityConfigsAgainstBundleCaps` — every entry in `capabilityConfigs` must correspond to a `BundleCapability.id` in `setup.capabilities(probeEnv)`. Build-time sanity check.

### Promotion-time validation
- `BundleRegistry.setActive` extends with three new optional parameters: `knownAgentConfigNamespaces?: string[]`, `knownConfigNamespaceIds?: string[]`, AND `knownCapabilityConfigIds?: string[]`. The third is **distinct** from `bundle-runtime-surface`'s `knownCapabilityIds` (which gates `requiredCapabilities`); this one gates the bundle's own `capabilityConfigs.id` set against host-registered capability ids — a bundle CANNOT declare a `configSchema` for an id the host already owns (would create silent dual-write to `config:capability:{id}`). Mismatch → `ERR_CAPABILITY_CONFIG_COLLISION`. Other two collisions: `ERR_AGENT_CONFIG_COLLISION`, `ERR_CONFIG_NAMESPACE_COLLISION`. Pointer NOT flipped on any collision.

### Dispatch-time guards
- Mirror the `bundle-http-and-ui-surface` pattern: `validateRoutesAndActionsCached` extends to also check the three new collision dimensions. On dispatch-time collision, `disableForAgentConfigCollision` / `disableForConfigNamespaceCollision` / `disableForCapabilityConfigCollision` clear the pointer with structured `bundle_disabled` reason.
- **Cache invalidation**: `bundlePointerRefresher` MUST invalidate `cachedAgentConfigSchema` and the new bundle-stand-in cache. Otherwise a bundle promoted after a DO is warm sees its agent-config namespaces invisible to `applyAgentConfigSet` until the next cold start.
- **Data-orphan policy on collision-disable**: when the dispatch-time guard fires `ERR_AGENT_CONFIG_COLLISION`, the bundle's persisted `config:agent:{ns}` value for the colliding namespace is left in place but flagged as "orphan" — `ensureAgentConfigLoaded` SHALL refuse to load it under the host's new schema (would otherwise inject a value that fails the new schema's `Value.Check`). The orphan persists until the operator either re-promotes a compatible bundle or explicitly deletes the key. Documented in CLAUDE.md.

### Hook-bridge spine RPCs (extends bundle-runtime-surface's host hook bus)
- Add `spineFireBundleConfigChange(caller, capabilityId, oldCfg, newCfg)` to `SpineHost`. Routes to the active bundle's `/config-change` endpoint; bundle SDK looks up the matching `BundleCapability` and invokes `hooks.onConfigChange`. Required scope: `"spine"`.
- Add `spineFireBundleAgentConfigChange(caller, capabilityId, oldSlice, newSlice)` to `SpineHost`. Same shape for agent-level changes.
- Both bridge methods wrapped in budget categories `hook_config_change` (cap 50) and `hook_agent_config_change` (cap 50). Mirrors `hook_after_tool` budget pattern.

### Telemetry
- Reuses the existing `[BundleDispatch]` log prefix from `bundle-http-and-ui-surface` and `bundle-runtime-surface` — operators grep ONE prefix for all bundle dispatch traffic. Each log entry carries a structured `kind` field discriminator: `kind: "config_change" | "agent_config_change" | "namespace_get" | "namespace_set" | "schema_extraction_error" | "config_collision_disable"`. No new prefix introduced.

### NOT in scope (deferred)
- **Pattern-matched `configNamespaces`** (regex-based, like `schedule:{id}`). Defer to a follow-up; only `prompt-scheduler` uses this today. **Migration consequence:** `prompt-scheduler` cannot be ported to a bundle until pattern-matched namespaces ship in v1.1. Bundles that need per-resource namespaces must instead declare a single namespace with structured value (e.g. `{ schedules: { [id]: {...} } }`).
- **Live-mutating `agentConfigMapping` as a function.** v1 uses dotted-path strings (`agentConfigPath`). The 1% of cases needing transformation can declare a derived namespace and project. Static `Capability.agentConfigMapping` continues as the function form for static caps — two-API state is deliberate (function for static = power-user escape hatch; path for bundle = serializable). Documented asymmetry, not a parity break.
- **Streaming config updates from outside the agent** (e.g. propagating a remote credential rotation into `agentConfigSnapshot` without a UI write). Out of scope; existing host pattern is the same.
- **Bundle declaring `configSchema` on the same capability id as a host static capability.** Build-time + promotion-time + dispatch-time guards reject (Decision 5 + new `ERR_CAPABILITY_CONFIG_COLLISION`).
- **Per-capability config UI bridge.** Today, per-capability config (`config:capability:{id}`) is mutated only via the `config_set` agent tool; UI's `useAgentConfig()` targets agent-level namespaces only. The bundle's `onConfigChange` therefore fires only on tool-driven mutations. If a future per-capability config UI surface lands, it MUST funnel through a single host accessor that dispatches the bundle hook — documented as a constraint to the future proposal author.

## Capabilities

### New Capabilities

- `bundle-config-namespaces`: bundle-side authoring API + host-side wiring + spine-bridge hooks that let bundle capabilities declare per-capability config schemas, agent-level config namespaces, and custom configNamespaces with the same semantic shape as static `Capability`. Schemas serialize as JSON Schema across the isolate. Validation runs host-side. Hooks fire via the same host-hook-bus bridge `bundle-runtime-surface` introduced for `beforeInference` / `afterToolExecution`.

### Modified Capabilities

_None._ All additions are new metadata fields and new spine-bridge methods — neither collides with existing spec requirements (separate from `bundle-runtime-surface`'s `lifecycleHooks` shape; separate from `bundle-http-and-ui-surface`'s `surfaces` shape).

## Impact

- **`packages/runtime/bundle-sdk/src/types.ts`** — extend `BundleCapability` with `configDefault?`, `agentConfigPath?`, `configNamespaces?`; add `BundleConfigNamespace`, `BundleConfigChangeEvent`, `BundleAgentConfigChangeEvent` types; add `BundleAgentSetup.config?: Record<string, TObject>`; add `BundleCapabilityHooks.onConfigChange` and `onAgentConfigChange`; add `BundleMetadata.capabilityConfigs?`, `agentConfigSchemas?`, `configNamespaces?` top-level fields.
- **`packages/runtime/bundle-sdk/src/define.ts`** — add build-time metadata extraction for the three new fields; add `/config-change`, `/agent-config-change`, `/config-namespace-get`, `/config-namespace-set` endpoint handlers.
- **`packages/runtime/bundle-sdk/src/validate.ts`** — add `validateCapabilityConfigs`, `validateAgentConfigSchemas`, `validateConfigNamespaces`. JSON Schema validity check (TypeBox `Value.Check` against the schema's own `TSchema` meta).
- **`packages/runtime/bundle-sdk/src/runtime.ts`** — surface bundle-declared configs to the dispatcher; resolve `agentConfigPath` slices on demand using a small dotted-path evaluator.
- **`packages/runtime/agent-runtime/src/agent-runtime.ts`** —
  - `getCachedAgentConfigSchema` merges static schemas with the active bundle's declared schemas.
  - `getCachedCapabilities()` merges static capabilities with synthetic stand-ins that surface bundle-declared `configSchema` / `configDefault` to the config tools.
  - `getConfigNamespaces()` merges static namespaces with bundle-declared ones (host installs proxies that dispatch via spine-bridge to the bundle).
  - `applyAgentConfigSet` and `handleAgentConfigSet` extend to also dispatch `onAgentConfigChange` to bundle capabilities via the bridge.
- **`packages/runtime/agent-runtime/src/agent-do.ts`** — extend `initBundleDispatch` with installers for the three new dispatch paths (`dispatchConfigChange`, `dispatchAgentConfigChange`, `dispatchConfigNamespace`); extend `validateRoutesAndActionsCached` (or add `validateConfigDeclarations`) to also check agent-config + config-namespace collisions.
- **`packages/runtime/bundle-host/src/`** — `validateBundleAgentConfigsAgainstKnownIds`, `validateBundleConfigNamespacesAgainstKnownIds`, `AgentConfigCollisionError`, `ConfigNamespaceCollisionError`. Reuse the `composeWorkerLoaderConfig` shared helper.
- **`packages/runtime/bundle-host/src/spine-host.ts`** + **`spine-service.ts`** — add the two new bridge methods `spineFireBundleConfigChange` and `spineFireBundleAgentConfigChange`. Budget categories added.
- **`examples/bundle-agent-phase2/`** — extend the example bundle to declare a per-capability config schema and an agent-level config namespace, exercise both via the example UI's config form.
- **CLAUDE.md** — under the bundle-brain section, document: the three new metadata fields, the `agentConfigPath` declarative-mapping replacement for `agentConfigMapping`, the validation dimensions, the new `bundle_disabled` reason codes (`ERR_AGENT_CONFIG_COLLISION`, `ERR_CONFIG_NAMESPACE_COLLISION`).
- **Spec corpus** — new `bundle-config-namespaces` capability spec under `openspec/specs/`. No deltas (all ADDED).
