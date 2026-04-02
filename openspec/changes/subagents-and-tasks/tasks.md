## 1. Task Tracker — Core Store

- [ ] 1.1 Create `packages/task-tracker` package with package.json, tsconfig, biome config
- [ ] 1.2 Implement `TaskStore` with SQLite schema (tasks table, task_deps table) and migration on init
- [ ] 1.3 Implement task CRUD: create (with owner_session, parent_id), update (status, priority, description), close (with reason + timestamp)
- [ ] 1.4 Implement dependency graph: add/remove edges, cycle detection on blocking subgraph
- [ ] 1.5 Implement ready-work query: tasks where all blocking deps are closed
- [ ] 1.6 Implement tree query: recursive hierarchy from any root task
- [ ] 1.7 Implement session ownership authorization: owner + subagent child sessions can write, all others read-only
- [ ] 1.8 Write integration tests for TaskStore (CRUD, deps, ready computation, cycle detection, ownership)

## 2. Task Tracker — Capability & Tools

- [ ] 2.1 Implement task-tracker capability (id, tools, promptSections)
- [ ] 2.2 Implement tools: task_create, task_update, task_close, task_ready, task_tree, task_dep_add
- [ ] 2.3 Add `task_event` to ServerMessage discriminated union in transport types
- [ ] 2.4 Wire TaskStore into AgentDO — initialize alongside SessionStore, pass to capability context
- [ ] 2.5 Broadcast task_event on mutations via transport
- [ ] 2.6 Write tests for task tools (create with deps, ready computation, ownership rejection)

## 3. Subagent — Profile System

- [ ] 3.1 Create `packages/subagent` package with package.json, tsconfig, biome config
- [ ] 3.2 Define `SubagentProfile` interface (id, name, description, systemPrompt, tools?, model?)
- [ ] 3.3 Add `getSubagentProfiles()` method to AgentDO (default returns empty array)
- [ ] 3.4 Implement profile resolution: merge parent config with profile overrides (model ID, tool filtering)
- [ ] 3.5 Write tests for profile resolution and tool filtering

## 4. Subagent — Execution Engine

- [ ] 4.1 Implement `call_subagent` tool (blocking): create child session, run Agent to completion, return result
- [ ] 4.2 Implement `start_subagent` tool (non-blocking): create child session, fire-and-forget prompt, return subagent ID
- [ ] 4.3 Implement steer-or-prompt dual-path callback on child agent_end (mirror A2A callback handler pattern)
- [ ] 4.4 Implement `PendingSubagentStore` in CapabilityStorage (mirrors PendingTaskStore)
- [ ] 4.5 Implement `check_subagent` and `cancel_subagent` tools
- [ ] 4.6 Implement orphaned subagent detection on DO wake (check pending store vs sessionAgents)
- [ ] 4.7 Implement subagent session authority inheritance for task-tracker write access
- [ ] 4.8 Mark subagent sessions with `source: "subagent"` and parent session reference
- [ ] 4.9 Write integration tests for blocking and non-blocking execution, steer delivery, cancellation

## 5. Subagent — Activity Streaming

- [ ] 5.1 Add `subagent_event` to ServerMessage discriminated union in transport types
- [ ] 5.2 Subscribe to child agent events and forward as subagent_event to parent session's WebSocket connections
- [ ] 5.3 Include subagent metadata (profile ID, child session ID, task ID if associated) in each event
- [ ] 5.4 Write tests for event forwarding

## 6. Subagent Explorer — Pre-built Profile

- [ ] 6.1 Create `packages/subagent-explorer` package
- [ ] 6.2 Implement `explorer()` function returning SubagentProfile with read-only tool filter and exploration system prompt
- [ ] 6.3 Support options: model override, custom tool list override
- [ ] 6.4 Implement default read-only tool filter (pattern-based on tool names)
- [ ] 6.5 Write tests for explorer profile configuration and tool filtering

## 7. UI — Task Tracker Components

- [ ] 7.1 Add `task_event` handling to `useAgentChat` hook (or new `useTaskTracker` hook)
- [ ] 7.2 Implement `TaskTreePanel` component: collapsible tree, status indicators, real-time updates
- [ ] 7.3 Implement `TaskBreadcrumb` component: path from root to active in_progress task
- [ ] 7.4 Add `data-agent-ui` attribute selectors for styling isolation
- [ ] 7.5 Write component tests (jsdom)

## 8. UI — Subagent Components

- [ ] 8.1 Add `subagent_event` handling to `useAgentChat` hook (or new `useSubagent` hook)
- [ ] 8.2 Implement `SubagentCard` component: profile name, status, task breadcrumb, live streaming text
- [ ] 8.3 Handle concurrent subagent cards (multiple non-blocking subagents)
- [ ] 8.4 Add `data-agent-ui` attribute selectors for styling isolation
- [ ] 8.5 Write component tests (jsdom)

## 9. Integration & Example

- [ ] 9.1 Update `examples/basic-agent` to register task-tracker and subagent capabilities
- [ ] 9.2 Add explorer profile with a fast model to the example agent's `getSubagentProfiles()`
- [ ] 9.3 Update example UI to include TaskTreePanel, TaskBreadcrumb, and SubagentCard
- [ ] 9.4 End-to-end manual test: create epic → decompose → spawn explorer subagent → close tasks
- [ ] 9.5 Update CLAUDE.md and README.md with new packages and capabilities
