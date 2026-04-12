## Why

CLAW's capability config system today works but has two limitations: (1) each capability internally decides what's configurable and owns its own storage — there's no unified, schema-typed surface that the agent or consumer can see or control, and (2) consumers can't customise which config fields are exposed to the agent or add their own non-capability config without subclassing AgentDO and implementing `getConfigNamespaces()`. We want a single `config` field on `defineAgent` that gives consumers an explicitly typed, composable configuration surface — one the agent can modify via tools and the UI can render generically from the schema.

This is also the prerequisite for `add-bundle-brain-override`. If runtime brain changes can be expressed as config mutations against a typed schema, many use cases (prompt/model swapping, capability tuning, per-deployment variants) are covered without a second runtime. Validating demand here gates whether the full bundle infrastructure is worth building.

## What Changes

- **`defineAgent` gains an optional `config` field.** Accepts a flat record of TypeBox schemas keyed by namespace name. Each key becomes a config namespace the agent can read/write via the existing `config_get` / `config_set` / `config_schema` tools, validated against the schema. Custom consumer config (e.g. `personality`, `behaviour`) sits alongside capability config in the same typed surface.
- **Capabilities export their config schemas.** Capabilities that want agent-manageable config export a TypeBox schema (e.g. `TavilyConfigSchema`). Consumers import these and map them into `defineAgent`'s `config` field via an explicit mapping function on the capability factory. Capabilities that don't export a schema are unaffected.
- **Explicit mapping from agent config to capability config.** Each capability factory gains an optional `config` parameter — a function `(agentConfig) => capabilityConfig` that receives the agent-level config and returns the slice the capability needs. The runtime calls this mapping at resolve time and injects the result into the capability's context. This replaces per-capability `CapabilityStorage` reads for mapped config.
- **Agent-level config stored in `ConfigStore`.** The runtime persists agent-level config using the existing `ConfigStore` infrastructure. Mutations via `config_set` validate against the TypeBox schema, persist, and trigger a new `onAgentConfigChange` hook on capabilities that declared a mapping — so capabilities react to config changes without polling.
- **New `useAgentConfig()` client hook.** Reads the agent-level config from a new `agent_config` capability state broadcast. The UI can render config controls generically from the TypeBox schema (type, constraints, defaults are all introspectable). Existing capability-specific UI hooks (`useTelegramChannel`, `useSchedules`) continue to work unchanged.
- **Transport: `capability_state` with well-known `capabilityId: "agent-config"`.** Reuses the existing `capability_state` message type rather than introducing a new transport message. The runtime broadcasts the full agent config on connect and on change.

## Capabilities

### New Capabilities

- `agent-config`: the `config` field on `defineAgent`, the agent-level config store, the mapping pipeline from agent config to capability config, the `onAgentConfigChange` lifecycle hook, the `useAgentConfig()` client hook, and the `capability_state` broadcast for `agent-config`.

### Modified Capabilities

- `agent-runtime-core`: `AgentSetup` gains the optional `config` field. The config tool trio (`config_get` / `config_set` / `config_schema`) gains awareness of agent-level namespaces alongside the existing `capability:{id}` and custom namespace patterns. Capability resolution injects mapped config into capability context.
- `define-agent-factory`: the `defineAgent` options type gains the `config` field and the capability `config` mapping parameter.

## Reference Migrations (in this change)

To prove the pattern across the variation space and give consumers concrete templates, five capabilities are migrated as part of this change. Each was picked because it exercises a distinct shape:

1. **`heartbeat`** — pure-closure case. Every option (`every`, `timezone`, `sessionPrefix`, `retention`, `prompt`, `enabled`) is operator-tunable today but baked into the factory closure. Proves the "pure closure → fully runtime" path.
2. **`tavily-web-search`** — secret-plus-tunables coexistence. `tavilyApiKey` stays in the closure (secret, not config); `maxResults`, `userAgent`, `maxFetchSize`, `searchDefaults` move to schema.
3. **`doom-loop-detection`** — already declares `configSchema`/`configDefault` but reads `threshold`/`lookbackWindow`/`allowRepeatTools` from the closure, so its declared schema is dead. Migration resurrects the existing schema via the new mapping path. Doubles as a latent-bug fix.
4. **`tool-output-truncation`** — one-field trivial case (`maxTokens`). Demonstrates the minimum viable migration footprint.
5. **`channel-telegram`** — coexistence with capability-owned `CapabilityStorage`. Account list stays in `CapabilityStorage` (per the existing reference pattern); `perSenderRateLimit` and `perAccountRateLimit` move to agent-level config schema.

The remaining tier-A capabilities — `sandbox`, `browserbase`, `vector-memory`, `r2-storage`, `compaction-summary` — are mechanical clones of the patterns above and are deferred to a follow-up to keep this change scoped. They are tracked in a follow-up bullet at the end of `tasks.md`.

Tier-B capabilities (`task-tracker`, `subagent`, `batch-tool`, `agent-storage`, `vibe-coder`, `skills`, `prompt-scheduler`) hold only bindings, callbacks, or already-runtime state and are NOT in scope.

## Impact

- **Modified packages**:
  - `packages/agent-runtime` — gains the `config` field on `AgentSetup` / `defineAgent`, the config mapping pipeline in capability resolution, the `onAgentConfigChange` hook dispatch, and the `agent-config` broadcast. All additive. Agents that omit `config` see no change.
  - `packages/agent-runtime` client — gains `useAgentConfig()` hook.
  - `packages/heartbeat` — exports `HeartbeatConfigSchema`, accepts `config` mapping parameter, reads runtime-mutable fields from `context.agentConfig`.
  - `packages/tavily-web-search` — exports `TavilyConfigSchema` (excluding `tavilyApiKey`), accepts `config` mapping parameter.
  - `packages/doom-loop-detection` — exports `DoomLoopConfigSchema`, switches from closure-captured tunables to mapped agent config, retires the dead `configSchema`/`configDefault` declaration.
  - `packages/tool-output-truncation` — exports `ToolOutputTruncationConfigSchema`, accepts `config` mapping parameter.
  - `packages/channel-telegram` — exports `TelegramRateLimitSchema`, accepts `config` mapping parameter for rate limits, leaves the account `CapabilityStorage` flow untouched.
- **Capability packages that opt in later**: each can export a `ConfigSchema` and document it. No capability is *required* to change — opt-in per capability.
- **No new packages**. Runtime plumbing lives entirely within `packages/agent-runtime`.
- **No new wrangler bindings**. Uses existing `ConfigStore` (DO SQLite-backed).
- **No breaking changes**. Existing `configSchema` / `configDefault` / `configNamespaces` / `onConfigChange` on capabilities continue to work as-is. The agent-level config is a new layer on top, not a replacement. Reference-migration capabilities keep their old constructor parameters as fallbacks for one release so consumers that don't pass `config` see no behaviour change.
- **Example update**: `examples/basic-agent` demonstrates agent-level config with a personality schema **and** wires the migrated `heartbeat` + `tavily-web-search` capabilities through it end-to-end.
