## Why

`defineAgent({ subagentModes: () => [...] })` is dead config today. The field declares available subagent modes, but without manually wiring `subagentCapability()` (passing a `SubagentHost`, `getParentTools`, `getSystemPrompt`), no subagent tools are registered. The runtime already has all the primitives needed to implement `SubagentHost` — session creation, LLM loop, steer/abort, broadcast — so the wiring should be automatic.

## What Changes

- **Implement `SubagentHost` on `AgentRuntime`** — expose `createSubagentSession`, `runSubagentBlocking`, `startSubagentAsync`, `isSessionStreaming`, `steerSession`, `promptSession`, `abortSession`, and `broadcastToSession` methods that delegate to existing runtime internals.
- **Auto-register subagent tools when `getSubagentModes()` is non-empty** — in `collectAllTools()`, when `getSubagentModes().length > 0`, create and register `call_subagent`, `start_subagent`, `check_subagent`, `cancel_subagent` tools using the runtime as the host. No consumer wiring needed.
- **`getParentTools` returns the current session's tool list** — the auto-wired callback calls `collectAllTools()` for the current session context, giving subagents access to the parent's resolved tools (which Mode filtering then scopes down).

## Capabilities

### New Capabilities
- `auto-wire-subagent`: Auto-registration of subagent tools when `subagentModes` is non-empty, including `SubagentHost` implementation on `AgentRuntime`

### Modified Capabilities
- `subagent`: The existing `subagentCapability()` factory remains available for consumers who need manual control, but is no longer required for basic usage

## Impact

- `packages/agent-runtime/src/agent-runtime.ts` — implement `SubagentHost` interface, register subagent tools in `collectAllTools()`
- `packages/agent-runtime/src/define-agent.ts` — no changes needed (already forwards `subagentModes`)
- `examples/basic-agent/src/worker.ts` — subagent tools now work out of the box (currently `subagentModes` is dead config)
- `packages/subagent/` — no changes to the package itself; it remains the standalone capability option
