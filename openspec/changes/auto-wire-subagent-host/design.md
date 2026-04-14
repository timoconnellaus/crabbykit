## Context

The `add-agent-modes` change unified `SubagentProfile` → `Mode` and added `defineAgent({ subagentModes })`. The design explicitly deferred auto-wiring: "gated on the existing subagent capability registration (unchanged)." This means consumers must manually add `subagentCapability()` to their capabilities list, passing a `SubagentHost` implementation, `getParentTools` callback, and `getSystemPrompt` callback. In practice, no consumer has done this — `subagentModes` in basic-agent is dead config.

The runtime already has all the building blocks:
- `sessionStore.create()` for child sessions
- `ensureAgent()` + `handlePrompt()` for running the LLM loop
- `handleSteer()` for injecting messages mid-turn
- `sessionAgents.get(sid)?.abort()` for aborting
- `transport.broadcastToSession()` for broadcasting

## Goals / Non-Goals

**Goals:**
- `defineAgent({ subagentModes: () => [explorer()] })` works out of the box — subagent tools appear without any capability wiring
- The runtime implements `SubagentHost` internally, delegating to existing methods
- Parent tool list passed to subagents comes from `collectAllTools()` for the current context
- Consumers who need custom host behavior can still use `subagentCapability()` directly

**Non-Goals:**
- Changing the `SubagentHost` interface or `packages/subagent` package
- Adding `inheritable` filtering to `getParentTools` (tracked in `unify-runtime-tools-as-capabilities` change)
- Auto-wiring the subagent capability as a proper `Capability` object — the tools are registered inline in `collectAllTools()`, matching the pattern used by config and mode tools

## Decisions

### 1. Implement SubagentHost as private methods on AgentRuntime

Each `SubagentHost` method maps to existing runtime internals:

| SubagentHost method | Runtime delegation |
|---|---|
| `createSubagentSession` | `this.sessionStore.create({ source: "subagent", ... })` |
| `runSubagentBlocking` | Create agent via `ensureAgent` pattern, await `agent_end` event |
| `startSubagentAsync` | Same as blocking but don't await — fire `onComplete` on `agent_end` |
| `isSessionStreaming` | `this.sessionAgents.has(sessionId)` |
| `steerSession` | `this.handleSteer(sessionId, text)` |
| `promptSession` | `this.handlePrompt(sessionId, text)` |
| `abortSession` | `this.sessionAgents.get(sessionId)?.abort()` |
| `broadcastToSession` | `this.transport.broadcastToSession(sessionId, message)` |

The implementation is a private `asSubagentHost(): SubagentHost` method that returns an object closing over `this`. This avoids making `AgentRuntime` formally implement the interface (which would expose the methods publicly).

**Why private?** SubagentHost methods are internal plumbing. Consumers don't interact with them — they just set `subagentModes` and get tools.

### 2. Register subagent tools in collectAllTools when subagentModes is non-empty

Pattern matches mode tools:
```
if (this.getSubagentModes().length > 0) {
  const host = this.asSubagentHost();
  const deps = { getHost: () => host, getModes: () => this.getSubagentModes(), ... };
  subagentTools.push(createCallSubagentTool(deps), createStartSubagentTool(deps), ...);
}
```

The tool factories are imported from `packages/subagent` — we reuse them, not duplicate them.

**Why not register as a Capability?** Consistent with config tools and mode tools, which are also inline in `collectAllTools()`. If we later promote all runtime tools to capabilities (per `unify-runtime-tools-as-capabilities`), subagent tools move with them.

### 3. getParentTools returns collectAllTools for current context

The callback returns the same tool list the parent session has. Mode filtering happens downstream in `resolveSubagentSpawn()` via the subagent Mode's allow/deny list.

### 4. getSystemPrompt returns the current assembled prompt

The callback calls `assembleAllSections()` + `toPromptString()` with the current mode context, so the subagent's system prompt override receives the parent's actual prompt (including any active mode modifications).

### 5. PendingSubagentStore uses CapabilityStorage-compatible KV

The subagent tools need a `PendingSubagentStore` for tracking async subagents. Since we're not going through the capability system, we create a storage adapter directly from `this.kvStore` with a `"subagent"` namespace prefix.

### 6. Consumer subagentCapability takes precedence

If a consumer explicitly adds `subagentCapability()` to their capabilities list AND has `subagentModes`, the consumer's capability wins. The auto-wiring checks whether any capability with `id: "subagent"` is already registered and skips if so. This prevents double-registration and lets consumers override behavior.

### 7. Prompt section for auto-wired subagents

The auto-wired path registers a prompt section listing available subagent modes with descriptions and guidance on blocking vs non-blocking usage. This matches the manual `subagentCapability`'s prompt section behavior.

### 8. Orphan detection on reconnect

The manual `subagentCapability` has an `onConnect` hook that detects orphaned async subagents after DO hibernation. The auto-wired path must replicate this — register equivalent lifecycle handling that checks `PendingSubagentStore` on connection and broadcasts `subagent_orphaned` for any subagents whose sessions are no longer streaming.

## Risks / Trade-offs

**[Risk] `runSubagentBlocking` is non-trivial** → `ensureAgent` is fire-and-forget (creates the agent, subscribes to events, returns void). The blocking implementation must create a child agent, call `handlePrompt`, subscribe to `agent_end` on the child's event stream, extract the final assistant message from session store, and resolve. This is a new internal method, not a simple delegation.

**[Risk] `resolvedCapabilitiesCache` shared mutable state** → On `agent_end`, the runtime nulls out `resolvedCapabilitiesCache` and `capabilitiesCache` (lines 2057-2061). If a child session ends while the parent is mid-turn, this invalidates the parent's caches. Mitigation: scope cache invalidation to the specific session that ended, not globally. The `sessionAgents` map already tracks per-session agents, so the cleanup handler should check whether the ending session owns the cache before invalidating.

**[Risk] `getSystemPrompt` timing** → During `collectAllTools`, the system prompt hasn't been assembled yet (it happens after, at line 2033). The `getSystemPrompt` callback must be truly lazy — a closure that reads the assembled prompt at tool execution time, not at registration time. Eagerly evaluating it would produce an empty string.

**[Risk] Circular tool resolution — subagent tools calling collectAllTools** → Not actually circular. `getParentTools` is called lazily (when the tool executes), not at registration time. By execution time, `collectAllTools` has already completed for the parent session.

**[Risk] Subagents get config/mode tools via getParentTools** → Known issue, tracked in `unify-runtime-tools-as-capabilities`. For now, Mode allow-lists in subagent modes (like explorer's) filter them out effectively. The explorer mode typically uses `tools: { allow: [...] }` which only includes read-only tools.
