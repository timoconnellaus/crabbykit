## Context

CLAW's existing config system has three layers:

1. **Per-capability config** (`configSchema` / `configDefault` / `onConfigChange`): each capability declares its own TypeBox schema, the runtime persists values in `ConfigStore` under `capability:{id}`, and the `config_set` tool validates + writes + fires `onConfigChange`. This is the "automatic" path — capabilities own their config shape.

2. **Custom config namespaces** (`configNamespaces`): capabilities or consumers contribute `ConfigNamespace` objects with their own `get`/`set` implementations. The `config_set` tool routes to these for non-capability namespaces. Used for things like schedule management where the storage model differs.

3. **`ConfigStore`**: DO SQLite-backed key-value store for capability config persistence. Currently only used by the `capability:{id}` path.

All three layers work, but the consumer has no unified view of "what can the agent configure?" and no way to add custom agent-level config (e.g. personality, behaviour mode, model preferences) without subclassing `AgentDO` and implementing `getConfigNamespaces()`.

The `defineAgent` API — the blessed path for new agents — currently has no `config` slot at all (noted in the source: "There is no `configNamespaces` slot here").

## Goals / Non-Goals

**Goals:**
- Add a `config` field to `defineAgent` that accepts a typed config schema and makes it available to the agent via the existing config tools
- Let consumers map agent-level config into capabilities via explicit mapping functions so capabilities receive their relevant config slice
- Broadcast agent config to the UI so it can render generic config controls from the schema
- Preserve full backward compatibility with existing `configSchema` / `configDefault` / `configNamespaces` / `onConfigChange` patterns

**Non-Goals:**
- Replacing or deprecating the existing per-capability config system. Both coexist — agent-level config is a new layer on top.
- Auto-generating UI components from TypeBox schemas. The UI gains `useAgentConfig()` for data access; rendering is up to the consumer's UI layer (though generic rendering from TypeBox is possible, it's not in scope).
- Dynamic capability registration/deregistration at runtime. Config can tune capability behaviour, not add/remove capabilities.
- Model or prompt switching via config. While a consumer *could* define a config namespace for model preferences and wire it through `getConfig()`, the runtime doesn't auto-apply config changes to the inference model or system prompt. That's a future concern (and a potential bridge to bundles).

## Decisions

### 1. Agent config is a flat record of typed namespaces

**Decision:** The `config` field on `defineAgent` is `Record<string, TObject>` — a flat map of namespace names to TypeBox object schemas. Each key becomes a config namespace.

```ts
defineAgent({
  config: {
    search: TavilyConfigSchema,
    personality: Type.Object({
      tone: Type.Union([Type.Literal('formal'), Type.Literal('casual')]),
      verbosity: Type.Integer({ minimum: 1, maximum: 5 }),
    }),
  },
})
```

**Alternatives considered:**
- Nested/hierarchical config tree. Rejected: adds complexity to the config_set path (dot-path resolution, partial updates) for no clear benefit. Flat namespaces are what the existing config tools already understand.
- Single schema for the entire agent config. Rejected: loses the namespace boundary that lets capabilities own their slice and lets `config_set` target a specific namespace.

**Rationale:** Matches the existing `ConfigNamespace` model exactly. Each key maps 1:1 to a namespace the agent can `config_get("search")` or `config_set("search", {...})`. No new concepts.

### 2. Explicit mapping via capability factory parameter

**Decision:** Capability factories gain an optional `config` parameter — a function `(agentConfig) => capSlice` that the consumer provides at `defineAgent` time.

```ts
capabilities: [
  tavilyWebSearch({
    apiKey: env.TAVILY_API_KEY,
    config: (c) => c.search,
  }),
]
```

The runtime calls this function during capability resolution, passing the current agent config. The result is injected into the capability's context as `context.agentConfig`. The capability can read it in `tools()`, `promptSections()`, and hooks.

**Alternatives considered:**
- Convention-based auto-mapping (capability ID matches config namespace key). Rejected: implicit, fragile if capability IDs change, doesn't allow consumers to reshape config.
- Runtime injection by capability ID. Rejected: couples the agent config schema to capability IDs, limiting consumer flexibility.

**Rationale:** The consumer controls the mapping. Capabilities don't need to know the shape of the agent config — they just receive their slice. This is explicit, composable, and type-safe.

### 3. Agent config stored in ConfigStore under `agent:{namespace}` keys

**Decision:** Agent-level config is persisted in the existing `ConfigStore` using keys prefixed with `agent:` (e.g. `agent:search`, `agent:personality`). This reuses the DO SQLite-backed store without new infrastructure.

**Alternatives considered:**
- Separate storage (new table, new KV namespace). Rejected: unnecessary complexity when ConfigStore already exists.
- Storing in `CapabilityStorage`. Rejected: CapabilityStorage is per-capability, scoped by capability ID. Agent config is agent-level.

**Rationale:** ConfigStore is the existing persistence layer for capability config. Adding `agent:` prefixed keys is the natural extension.

### 4. Config broadcast reuses `capability_state` with well-known ID

**Decision:** The runtime broadcasts agent config changes as `capability_state` messages with `capabilityId: "agent-config"`. On connect, the full config is broadcast as a `"sync"` event. On change, only the updated namespace is broadcast as an `"update"` event.

**Alternatives considered:**
- New transport message type `agent_config`. Rejected: adds a new discriminated union variant to the transport protocol for something that's structurally identical to `capability_state`.

**Rationale:** Reuses existing infrastructure. The `useAgentConfig()` hook subscribes to `"agent-config"` via the existing `subscribe(capabilityId, handler)` mechanism.

### 5. Config changes trigger `onAgentConfigChange` on mapped capabilities

**Decision:** When `config_set` updates an agent-level namespace, the runtime calls `onAgentConfigChange(oldSlice, newSlice, ctx)` on every capability that declared a `config` mapping and whose mapped slice actually changed. This is a new optional hook on the `Capability` interface, separate from `onConfigChange` (which fires for `capability:{id}` namespace changes).

**Alternatives considered:**
- Reuse `onConfigChange`. Rejected: `onConfigChange` is for the capability's own config, not for agent-level config. Overloading it creates ambiguity.
- No hook, just re-resolve capabilities. Rejected: re-resolving capabilities is expensive and disrupts in-flight state.

**Rationale:** Capabilities that care about config changes opt in via the hook. Capabilities that just read config at tool-execution time don't need the hook — they read `context.agentConfig` on each call and get the latest.

### 6. Defaults from schema

**Decision:** TypeBox schemas support `default` annotations on fields (e.g. `Type.Integer({ default: 5 })`). When no config has been set for a namespace, the runtime uses `Value.Create(schema)` to generate a default instance. This means agent config always has a value — no null checks needed in capabilities.

**Rationale:** TypeBox already supports this. No custom defaulting logic needed.

## Risks / Trade-offs

- **Two config systems coexist.** Agent-level config (`config` on `defineAgent`) and per-capability config (`configSchema` / `configDefault`) are both active. Consumers might be confused about which to use. Mitigation: documentation should be clear that agent-level config is for consumer-controlled, agent-manageable settings, while per-capability config is for capability-internal state. Over time, capabilities should migrate to exporting schemas and using the agent-level path.
- **Mapping function runs at resolve time.** If the agent config changes mid-session, the mapping function doesn't automatically re-run for already-resolved capabilities. Capabilities that need live config should read `context.agentConfig` in their tools or implement `onAgentConfigChange`. Mitigation: document that `context.agentConfig` always returns the latest value; the mapping function is for initial injection and type narrowing.
- **TypeBox schema size in transport.** Broadcasting TypeBox schemas to the client for generic UI rendering adds payload size. Mitigation: schemas are small (JSON objects describing types); the broadcast is per-connect, not per-message.

## Reference Migration Strategy

Five capabilities migrate inside this change to prove the pattern. Selection criteria: each one exercises a *distinct shape* in the config-vs-binding-vs-secret variation space, so any later migration is a mechanical clone of one of these five.

| Reference | Shape it proves |
|---|---|
| `heartbeat` | Pure-closure case — every option becomes runtime-mutable |
| `tavily-web-search` | Secret + tunables coexist — apiKey stays in closure, rest move to schema |
| `doom-loop-detection` | Existing dead `configSchema`/`configDefault` resurrected via mapping path; doubles as latent-bug fix |
| `tool-output-truncation` | Trivial single-field migration (template for any one-knob capability) |
| `channel-telegram` | Coexistence with capability-owned `CapabilityStorage` — accounts stay in capability storage, rate-limit policy moves to agent-level config |

Tier-A capabilities deferred to follow-up work (sandbox, browserbase, vector-memory, r2-storage, compaction-summary) are mechanical clones of these patterns. They are deferred so this change stays scoped and reviewable; the precedent is set, the consumer-facing API is locked, and the follow-up is a sweep, not a design exercise.

Tier-B capabilities (task-tracker, subagent, batch-tool, agent-storage, vibe-coder, skills, prompt-scheduler) hold only bindings, callbacks, or already-runtime state (`CapabilityStorage` / schedule store / D1 registry). They are explicitly out of scope and require no migration.

### Backward-compat shim for migrated capabilities

Each migrated capability keeps its existing constructor parameters as deprecated fallbacks for one release. Resolution order at capability construction time:

```
context.agentConfig (mapped slice) ─┐
                                    ├─▶ Effective config
constructor option (deprecated) ────┤
                                    │
schema default (Value.Create) ──────┘
```

Consumers who don't pass `config` to `defineAgent` see no behaviour change. Consumers who pass both get the mapped value (mapping wins over closure), with a one-time console warning on construction. Removed in the release after.

## Open Questions

1. **Should `config` on `defineAgent` support a function of `env` / `setup`?** Like other `defineAgent` fields, config schemas might want to vary by environment (e.g. different defaults in dev vs prod). Leaning yes for consistency.
2. **Should capabilities be able to declare "required config" that fails agent startup if not mapped?** Currently the mapping is optional. A capability could export a schema and document that it requires config, but there's no runtime enforcement. Probably not worth the complexity for v1.
3. **`compaction-summary` migration timing.** Moving `provider`/`modelId` to runtime config is the bridge to `add-bundle-brain-override`: it lets a deployment swap the summarizer model without redeploying, which validates the demand argument for the full bundle infrastructure. Cost: it is the most invasive of the tier-A migrations because the LLM client constructor moves out of the factory closure into per-call resolution. **Decision pending** — include here as the headline migration, or defer to the brain-override change so the demand-validation argument lives there. Currently captured under tasks 9.5 (deferred).
4. **`doom-loop-detection` dead `configSchema` — fix in this change or split out?** The capability declares `configSchema`/`configDefault` but reads from the closure, so the declared schema never affects behaviour. This is a latent bug independent of the agent-config work. Including the fix inside this change muddies the "purely additive" framing. Splitting it out adds a tiny standalone PR but keeps this change clean. **Currently captured inside this change** (task 6.3) because the migration *is* the fix — splitting would require landing the bug fix, then immediately rewriting it during migration.
