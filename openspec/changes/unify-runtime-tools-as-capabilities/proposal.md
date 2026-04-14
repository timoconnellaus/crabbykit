## Why

Runtime-level tools (config, mode-manager, A2A client) bypass the capability system, creating two problems: (1) mode filtering can't uniformly exclude their tools or prompt sections — the system prompt inspection panel shows capability sections for filtered-out features, and the LLM sees prompt guidance for tools it can't call; (2) subagents inherit session-management tools (config_set, enter_mode) by default because there's no metadata to distinguish them from regular tools. Unifying all tool sources under the capability interface gives modes and subagent resolution a single filtering path.

## What Changes

- **BREAKING**: `collectAllTools()` no longer registers config, mode, or A2A client tools directly. They are contributed by internal capabilities instead.
- Add `inheritable` field to the `Capability` interface (default `true`). Capabilities with `inheritable: false` are excluded from the parent tool list passed to subagent resolution.
- Create three internal capabilities: `configCapability()` (config_get/set/schema tools + prompt section), `modeManagerCapability()` (enter_mode/exit_mode tools), `a2aClientCapability()` (call_agent/start_task/check_task/cancel_task tools).
- Config capability resolves late (after other capabilities contribute `configNamespaces`) to avoid the bootstrap ordering problem.
- `applyMode` no longer needs special-case logic to auto-derive dead capabilities from tool filtering — `capabilities: { deny: [...] }` on a mode works uniformly.
- Subagent tool resolution (`resolveSubagentSpawn`) strips non-inheritable capability tools before applying Mode filters.

## Capabilities

### New Capabilities
- `inheritable-capability-field`: The `inheritable` boolean on the Capability interface and its integration into subagent tool resolution
- `internal-config-capability`: Config tools (config_get/set/schema) promoted to a proper capability with prompt section, late-binding namespace aggregation, and `inheritable: false`
- `internal-mode-capability`: Mode tools (enter_mode/exit_mode) promoted to a proper capability, conditionally registered when modes are active, with `inheritable: false`
- `internal-a2a-client-capability`: A2A client tools promoted to a proper capability, conditionally registered when A2A is configured, with `inheritable: true`

### Modified Capabilities
- `subagent`: Subagent tool resolution must respect `inheritable` field when building the parent tool list passed to `resolveSubagentSpawn`

## Impact

- `packages/agent-runtime/src/agent-runtime.ts` — `collectAllTools()` simplified to baseTools + resolved.tools
- `packages/agent-runtime/src/capabilities/types.ts` — `Capability` interface gains `inheritable?: boolean`
- `packages/agent-runtime/src/capabilities/resolve.ts` — resolution tracks tool-to-capability source mapping
- `packages/agent-runtime/src/modes/apply-mode.ts` — remove auto-derive dead-cap logic, rely on uniform filtering
- `packages/subagent/src/resolve.ts` — filter non-inheritable tools before Mode filter
- `packages/agent-runtime/src/config/` — config tools wrapped in capability factory
- `packages/agent-runtime/src/modes/tools.ts` — mode tools wrapped in capability factory
- `examples/basic-agent/src/worker.ts` — plan mode can use `capabilities: { deny: ["config", "prompt-scheduler"] }` instead of large tool allow-list
- All existing tests for config, modes, A2A, and subagent resolution
