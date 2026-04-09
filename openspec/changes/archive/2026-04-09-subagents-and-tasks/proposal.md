## Why

CLAW agents can delegate work to other agents via the A2A protocol (cross-DO) and fleet system, but there's no way for an agent to spawn lightweight child agents within the same Durable Object for parallel subtask execution. There's also no structured task tracking — agents have no way to decompose work into a dependency graph, compute what's ready, or coordinate multi-step plans across subagents. OpenCode demonstrates both patterns (subagent spawning + task management) effectively; we need equivalents that fit CLAW's distributed Durable Object architecture.

## What Changes

- **New `task-tracker` capability package** — DAG-based task management stored in DO SQLite. Tasks have status, priority, type, hierarchy (parent-child), and a dependency graph with blocking/non-blocking edge types. Computed `ready()` query returns tasks whose blocking dependencies are all closed. Tasks are DO-scoped (persist across sessions), with session-based ownership: the session that creates a task has full CRUD; all other sessions get read-only access. Subagent sessions inherit write access from their parent session.

- **New `subagent` capability package** — Spawn child agent instances within the same DO. Two execution modes mirroring the A2A client pattern: `call_subagent` (blocking, awaits result) and `start_subagent` (non-blocking, returns immediately, result arrives via steer-or-prompt dual-path callback). Subagent profiles define system prompt, tool allowlist, and OpenRouter model override. One pre-built profile: `explorer` (read-only tools, fast model, codebase search). Consumers define additional profiles via capability options.

- **New transport message types** — `subagent_event` (forwarded child agent activity for live UI streaming) and `task_event` (task mutations broadcast for live UI updates).

- **New `agent-ui` components** — `TaskTreePanel` (collapsible DAG view with status indicators), `TaskBreadcrumb` (active task path from root to current leaf), `SubagentCard` (live subagent activity with status and breadcrumb).

- **New `SubagentProfile` interface on AgentDO** — `getSubagentProfiles()` method for consumers to register profiles. Pre-built profiles are composable functions that accept model overrides.

## Capabilities

### New Capabilities
- `task-tracker`: DAG-based task management with dependency graph, ready-work computation, session ownership model, and real-time transport events
- `subagent`: Same-DO child agent spawning with blocking/non-blocking execution modes, profile system, steer-or-prompt result delivery, and live activity streaming
- `subagent-explorer`: Pre-built explorer subagent profile — read-only tools optimized for codebase search with configurable model override
- `task-tracker-ui`: TaskTreePanel, TaskBreadcrumb components for agent-ui
- `subagent-ui`: SubagentCard component with live activity streaming for agent-ui

### Modified Capabilities
<!-- No existing spec-level requirement changes. Implementation touches agent-do.ts (new getSubagentProfiles method, subagent session management) and transport types (new message types), but these are additive. -->

## Impact

- **agent-runtime**: New `getSubagentProfiles()` protected method on AgentDO. New transport message types (`subagent_event`, `task_event`). Subagent session lifecycle management in `sessionAgents` map. New `PendingSubagentStore` (mirrors A2A's `PendingTaskStore`).
- **agent-ui**: New components (TaskTreePanel, TaskBreadcrumb, SubagentCard). `useAgentChat` hook extended to handle `subagent_event` and `task_event` message types.
- **agent-core**: No changes — subagents use existing `Agent` class, steering, and event subscription.
- **New packages**: `packages/task-tracker`, `packages/subagent`, `packages/subagent-explorer`.
- **Dependencies**: No new external dependencies. Task store uses DO SQLite (same as session store). Subagent execution reuses agent-core's Agent class and agent-do's steer/prompt infrastructure.
