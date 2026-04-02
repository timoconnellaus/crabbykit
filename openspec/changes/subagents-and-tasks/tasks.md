## 1. Task Tracker — Core Store

- [ ] 1.1 Create `packages/task-tracker` package with package.json, tsconfig, biome config
- [ ] 1.2 Implement `TaskStore` with SQLite schema (tasks table, task_deps table) and migration on init
- [ ] 1.3 Implement task CRUD: create (with owner_session, parent_id), update (status, priority, description), close (with reason + timestamp)
- [ ] 1.4 Implement dependency graph: add/remove edges, cycle detection on blocking subgraph
- [ ] 1.5 Implement ready-work query: tasks where all blocking deps are closed
- [ ] 1.6 Implement tree query: recursive hierarchy from any root task
- [ ] 1.7 Implement session ownership authorization: owner + subagent child sessions can write, all others read-only
- [ ] 1.8 Write pool-workers integration tests for TaskStore: CRUD operations, dependency edge add/remove, cycle detection rejection, ready-work computation across states, tree queries, session ownership enforcement (unique DO name per describe block)

## 2. Task Tracker — Capability & Tools

- [ ] 2.1 Implement task-tracker capability (id, tools, promptSections)
- [ ] 2.2 Implement tools: task_create, task_update, task_close, task_ready, task_tree, task_dep_add
- [ ] 2.3 Add `task_event` to ServerMessage discriminated union in transport types
- [ ] 2.4 Wire TaskStore into AgentDO — initialize alongside SessionStore, pass to capability context
- [ ] 2.5 Broadcast task_event on mutations via transport
- [ ] 2.6 Write tests for each task tool using createMockStorage/TOOL_CTX from test-utils: happy path, error cases (ownership rejection, invalid transitions, cycle detection), and transport event emission

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
- [ ] 4.9 Write pool-workers integration tests: blocking call returns result, non-blocking start returns immediately, steer delivery when parent streaming, prompt delivery when parent idle, cancellation aborts child, orphan detection on wake, PendingSubagentStore CRUD and hibernation survival

## 5. Subagent — Activity Streaming

- [ ] 5.1 Add `subagent_event` to ServerMessage discriminated union in transport types
- [ ] 5.2 Subscribe to child agent events and forward as subagent_event to parent session's WebSocket connections
- [ ] 5.3 Include subagent metadata (profile ID, child session ID, task ID if associated) in each event
- [ ] 5.4 Write tests for event forwarding: verify subagent_event includes correct metadata, verify events only go to parent session's connections, verify all AgentEvent types are forwarded

## 6. Subagent Explorer — Pre-built Profile

- [ ] 6.1 Create `packages/subagent-explorer` package
- [ ] 6.2 Implement `explorer()` function returning SubagentProfile with read-only tool filter and exploration system prompt
- [ ] 6.3 Support options: model override, custom tool list override
- [ ] 6.4 Implement default read-only tool filter (pattern-based on tool names)
- [ ] 6.5 Write tests for explorer profile: default config shape, model override, custom tool list override, default read-only filter correctly includes/excludes tools by name pattern

## 7. UI — Task Tracker Components

- [ ] 7.1 Add `task_event` handling to `useAgentChat` hook (or new `useTaskTracker` hook)
- [ ] 7.2 Implement `TaskTreePanel` component: collapsible tree, status indicators, real-time updates
- [ ] 7.3 Implement `TaskBreadcrumb` component: path from root to active in_progress task
- [ ] 7.4 Add `data-agent-ui` attribute selectors for styling isolation
- [ ] 7.5 Write jsdom component tests: TaskTreePanel renders hierarchy, updates on task_event, collapses/expands; TaskBreadcrumb shows path for active task, hides when no active task

## 8. UI — Subagent Components

- [ ] 8.1 Add `subagent_event` handling to `useAgentChat` hook (or new `useSubagent` hook)
- [ ] 8.2 Implement `SubagentCard` component: profile name, status, task breadcrumb, live streaming text
- [ ] 8.3 Handle concurrent subagent cards (multiple non-blocking subagents)
- [ ] 8.4 Add `data-agent-ui` attribute selectors for styling isolation
- [ ] 8.5 Write jsdom component tests: SubagentCard renders profile/status, updates on subagent_event stream, handles multiple concurrent cards, shows completion state

## 9. Quality & Coverage Gates

- [ ] 9.1 Configure vitest coverage thresholds for task-tracker: 95% statements, 85% branches, 100% functions, 95% lines
- [ ] 9.2 Configure vitest coverage thresholds for subagent: 95% statements, 85% branches, 100% functions, 95% lines
- [ ] 9.3 Configure vitest coverage thresholds for subagent-explorer: 95% statements, 85% branches, 100% functions, 95% lines
- [ ] 9.4 Verify all source files stay under 500 lines (split if needed per quality-check.sh)
- [ ] 9.5 Verify all test files stay under 1500 lines
- [ ] 9.6 Verify no console.log in library code (use console.error/warn where needed)
- [ ] 9.7 Run `./tools/quality-check.sh` — zero new warnings from these packages
- [ ] 9.8 Run `bun run typecheck` — no new type errors
- [ ] 9.9 Run `bun run lint` — no new biome violations
- [ ] 9.10 Every public export has at least one test

## 10. Integration & Example

- [ ] 10.1 Update `examples/basic-agent` to register task-tracker and subagent capabilities
- [ ] 10.2 Add explorer profile with a fast model to the example agent's `getSubagentProfiles()`
- [ ] 10.3 Update example UI to include TaskTreePanel, TaskBreadcrumb, and SubagentCard
- [ ] 10.4 End-to-end manual test: create epic → decompose → spawn explorer subagent → close tasks
- [ ] 10.5 Update CLAUDE.md and README.md with new packages and capabilities
