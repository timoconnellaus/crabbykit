## Context

Today `collectAllTools()` assembles the agent's tool surface from four separate sources: base tools (from `getTools()`), config tools (created inline), A2A client tools (created inline), mode tools (created inline), and capability tools (from `resolved.tools`). Only capability tools carry source metadata (capability ID), so mode filtering and subagent tool resolution can't reason about the others uniformly.

This creates two concrete bugs:
1. The system prompt inspection panel shows prompt sections for capabilities whose tools are all filtered by the active mode (e.g., bundle-workshop in plan mode), because auto-derivation of "dead capabilities" can only work for tools that went through the capability system.
2. Subagents inherit session-management tools (config_set, enter_mode) by default because there's no metadata distinguishing them from regular tools.

The fix we already applied (auto-excluding capability sections when all tools are filtered) works for capabilities with `tools()`, but fails for capabilities that contribute tools indirectly via `configNamespaces` (prompt-scheduler, channel-telegram, skills) — those tools are runtime-level `config_set`/`config_get` shared across all config-contributing capabilities.

## Goals / Non-Goals

**Goals:**
- Single tool registration path: all tools come through capabilities or `getTools()` (base tools)
- Mode filtering works uniformly via `capabilities: { deny: [...] }` and `tools: { deny/allow: [...] }` — no special cases
- Subagent tool resolution automatically excludes session-management tools without Mode authors needing to remember them
- System prompt inspection accurately reflects what the LLM sees under any mode

**Non-Goals:**
- Changing the Capability interface beyond adding `inheritable` — no new lifecycle hooks or resolution phases
- Making config tools optional per-agent — they remain always-on (but now filterable by modes)
- Bundle dispatch mode awareness (remains a v1.1 follow-up)
- Changing how `getTools()` (base/consumer tools) works — these remain outside the capability system

## Decisions

### 1. Internal capabilities are factory functions, not classes

Config, mode-manager, and A2A client tools become capability factory functions (`configCapability()`, `modeManagerCapability()`, `a2aClientCapability()`) following the same pattern as existing capabilities like `promptScheduler()` or `tavilyWebSearch()`. They return `Capability` objects.

**Why not classes?** No existing capability uses a class — the factory pattern is the established convention. Internal capabilities don't need inheritance or instance state.

**Alternative considered:** Adding source metadata to tools without promoting them to capabilities. Rejected because it creates a parallel tracking mechanism and doesn't solve the `configNamespaces` problem.

### 2. Config capability uses late-binding namespace aggregation

The bootstrap problem: config tools need namespaces from all capabilities, but capabilities are resolved together. Solution: `configCapability()` accepts a `getNamespaces` callback that the runtime provides at resolution time. The capability's `tools()` factory calls `getNamespaces()` lazily (at tool-list-build time, not at registration time).

```
Resolution order (unchanged):
  1. resolveCapabilities() — resolves all capabilities including config
  2. collectAllTools() — calls cap.tools(context) which triggers getNamespaces()
```

The callback returns `ConfigNamespace[]` aggregated from all capabilities' `configNamespaces` plus the consumer's `getConfigNamespaces()`. This is the same aggregation `collectAllTools()` does today, just moved behind the callback.

**Why a callback?** Config capability is registered at `defineAgent` time (before other capabilities are known). The callback defers namespace collection to tool-build time when all capabilities are resolved. This avoids changing the resolution order or adding a second resolution pass.

**Alternative considered:** Two-phase capability resolution (resolve non-config first, then config). Rejected as unnecessary complexity — the callback achieves the same result within the existing single-pass resolution.

### 3. `inheritable` defaults to `true`, opt-out per capability

Adding `inheritable?: boolean` to the `Capability` interface (default `true`). Capabilities with `inheritable: false` have their tools stripped from the parent tool list before subagent Mode filtering runs.

Default assignments:
- `configCapability()` → `inheritable: false` (subagents should not mutate agent config)
- `modeManagerCapability()` → `inheritable: false` (subagents should not switch modes)
- `a2aClientCapability()` → `inheritable: true` (subagents may delegate to peers)
- `promptScheduler()` → `inheritable: false` (subagents should not create schedules)
- `bundleWorkshop()` → `inheritable: false` (subagents should not deploy bundles)
- All other existing capabilities → `inheritable: true` (default, no change needed)

**Why opt-out?** Most capabilities (r2-storage, sandbox, web-search, browserbase) are genuinely useful in subagents. Only session-management capabilities need exclusion.

**Alternative considered:** A `scope: "session" | "agent"` enum. Rejected as over-abstract — `inheritable` is a simple boolean that directly expresses the question "should subagents get this?"

### 4. Subagent resolution filters by inheritable before Mode filtering

In `resolveSubagentSpawn()`, the parent tool list is first filtered to remove tools from non-inheritable capabilities, then the Mode's allow/deny filter runs on the remainder. This means Mode authors never need to deny session-management tools — they're already gone.

This requires the parent tool list to carry capability-source metadata. The simplest approach: `collectAllTools()` returns tools tagged with their source capability ID (or `null` for base tools). The subagent resolution path reads this tag.

### 5. Remove the auto-derive dead-cap logic from applyMode

The logic we added earlier (checking if ALL of a capability's tools were filtered and auto-excluding its sections) becomes unnecessary once config/modes/a2a are proper capabilities. Mode authors can explicitly deny capabilities via `capabilities: { deny: ["config", "prompt-scheduler"] }` and it just works. Remove the implicit derivation to keep the mental model simple: tools filtering filters tools, capabilities filtering filters capabilities and their sections.

**Why remove?** The auto-derive approach is a heuristic that can produce surprising results (e.g., a capability with one denied tool and one non-denied tool keeps its section, but a capability with all tools denied loses it). Explicit is better than implicit.

## Risks / Trade-offs

**[Risk] Breaking change for consumers who inspect `collectAllTools` output** → Mitigation: `collectAllTools` is private. The public API (`resolveToolsForSession`) already returns the flat tool list; its shape doesn't change.

**[Risk] Config capability must not appear in the inspection panel as user-removable** → Mitigation: Internal capabilities are registered by the runtime, not by the consumer. They appear in prompt sections like any capability but can't be removed from `defineAgent.capabilities`. The runtime auto-injects them.

**[Risk] Tool source tagging adds a field to every tool object** → Mitigation: Use a WeakMap or a wrapper rather than mutating the AgentTool type. The tag is internal to the runtime and not exposed to capability authors.

**[Risk] `inheritable: false` on prompt-scheduler means subagents can't create schedules** → This is the desired behavior. If a future use case needs it, the consumer can override `inheritable: true` on their instance.
