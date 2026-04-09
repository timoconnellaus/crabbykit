## Context

CLAW agents run as Durable Objects with per-session Agent instances (`sessionAgents` map), an immutable append-log session store (DO SQLite), and a WebSocket transport for real-time streaming. The A2A client capability already implements two delegation modes: `call_agent` (blocking) and `start_task` (non-blocking with push notification callback). When a non-blocking A2A task completes, the callback handler uses a dual-path delivery: steer if the parent agent is streaming, or start a new prompt if idle (`agent-do.ts:2218-2243`).

The capability system provides the extension model — tools, hooks, prompt sections, HTTP handlers — all scoped with persistent KV storage. Capabilities are stateless factories that receive `AgentContext`.

There is no mechanism for spawning child agent instances within the same DO, and no structured task tracking beyond the A2A `PendingTaskStore` (which tracks in-flight cross-DO tasks, not work decomposition).

## Goals / Non-Goals

**Goals:**
- DAG-based task store with dependency graph and computed ready-work queries, stored in DO SQLite
- Same-DO subagent spawning with blocking and non-blocking modes, mirroring A2A's proven patterns
- Session ownership model: creating session has full CRUD, other sessions read-only
- Subagent profiles with model override (OpenRouter model ID) and tool allowlists
- One pre-built explorer profile; consumer-defined profiles via `getSubagentProfiles()`
- Real-time UI streaming of subagent activity and task mutations
- Task breadcrumb showing active task path from epic root to current leaf

**Non-Goals:**
- Workflow templates / molecules / wisps (future skills system concern)
- Session modes (switching agent behavior within a session — separate feature)
- Cross-DO subagents (use existing A2A/fleet for that)
- Task assignment/claiming by arbitrary sessions (ownership is set at creation)
- Gantt charts, time estimation, or project management features

## Decisions

### 1. Task store uses DO SQLite with dedicated tables (not session entries)

Tasks are relational (dependency graph, hierarchy, status queries) rather than append-only. The session store's append-log model is wrong for mutable task state. A dedicated `TaskStore` with `tasks` and `task_deps` tables in the same DO SQLite database provides efficient graph queries.

**Alternative considered:** Custom session entries with `customType: "task"`. Rejected because tasks need UPDATE semantics (status changes), cross-session visibility, and graph queries (ready-work computation) — all of which fight the append-only entry model.

### 2. Subagent execution reuses the A2A dual-path callback pattern

The non-blocking subagent completion handler mirrors `agent-do.ts:2218-2243` exactly: check if parent agent is streaming → steer, else → prompt. This is proven, handles hibernation correctly, and the code paths already exist.

**Alternative considered:** Custom event bus / pub-sub within the DO. Rejected because the steer-or-prompt pattern already handles both cases (agent busy vs idle) and is battle-tested in the A2A callback handler.

### 3. Subagent profiles are defined at the AgentDO level, not as capabilities

A new `getSubagentProfiles()` method on AgentDO (alongside `getTools()`, `getCapabilities()`, etc.) lets consumers register profiles. Pre-built profiles like `explorer()` are composable functions that return a `SubagentProfile`.

**Alternative considered:** Each profile as a separate capability package. Rejected because profiles are lightweight configuration (system prompt + tool filter + model ID), not full capabilities with storage/hooks/handlers. Making them capabilities adds ceremony without value. The `subagent` capability reads profiles from `getSubagentProfiles()` at runtime.

### 4. Model override is just an OpenRouter model ID string

All CLAW inference goes through OpenRouter. Subagent profiles specify `model?: string` (e.g., `"google/gemini-2.5-flash"`). Provider and API key are inherited from the parent's `getConfig()`. No need to duplicate auth configuration per subagent.

### 5. Session ownership: immutable `owner_session` field, subagents inherit parent authority

Each task has an immutable `owner_session` set at creation. Only that session (and its subagent child sessions) can mutate the task. All other sessions see tasks read-only. This prevents cross-conversation interference while allowing full graph visibility.

Subagent sessions inherit write authority from their parent session. The subagent capability tracks parent-child session relationships and passes authority through to the `TaskStore` write checks.

### 6. Pre-built explorer profile uses parent's tools filtered to read-only

The explorer subagent gets a filtered subset of the parent's resolved tools — only tools that don't mutate state (file reads, search, listing). The filter is by tool name pattern, not a hardcoded list, so it works with consumer-defined tools too. The consumer can override the filter via profile options.

### 7. PendingSubagentStore mirrors PendingTaskStore for hibernation survival

In-flight non-blocking subagents are tracked in `CapabilityStorage` (KV), same as A2A's `PendingTaskStore`. This survives DO hibernation. On wake, the subagent capability can detect orphaned pending subagents and report them as failed.

### 8. Transport uses new message types for subagent and task events

- `subagent_event`: Wraps child agent's `AgentEvent` with subagent metadata (profile ID, task ID, child session ID). Forwarded to parent session's WebSocket connections.
- `task_event`: Broadcast on task mutations (create, update, close, dep add/remove). Includes the full task object and change type.

These are additive to the existing `ServerMessage` discriminated union.

## Risks / Trade-offs

**[Risk] Same-DO subagents compete for compute time** → Durable Objects are single-threaded. Multiple concurrent Agent instances share the event loop. Mitigation: subagent profiles should prefer fast/cheap models for exploration tasks. The blocking `call_subagent` mode is explicitly sequential. Non-blocking mode interleaves via event loop cooperation (Agent uses async/await throughout).

**[Risk] Subagent session proliferation** → Each subagent gets its own session, potentially creating many sessions per interaction. Mitigation: subagent sessions are marked with a `source: "subagent"` field and can be filtered from session lists. Consider auto-cleanup of completed subagent sessions after a retention period.

**[Risk] Task dependency cycles** → Malformed dependency graphs could create deadlocks where no task is ever ready. Mitigation: cycle detection on `task_dep_add` — reject edges that would create a cycle in the blocking dependency subgraph.

**[Risk] Orphaned subagents after DO hibernation** → If a DO hibernates while a non-blocking subagent is running, the child Agent instance is lost but PendingSubagentStore still has the record. Mitigation: on wake, check for orphaned pending subagents and mark them as failed. The parent session receives a notification.

**[Trade-off] Task store is DO-scoped, not global** → Tasks don't span multiple DOs/agents. This is intentional — cross-agent coordination uses A2A. But it means a "project" view across agents would need a separate aggregation layer. Acceptable for now.
