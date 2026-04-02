## ADDED Requirements

### Requirement: Task creation with hierarchy
The system SHALL allow creating tasks with a title, optional description, type (task, epic, bug), priority (0-4), and optional parent task ID. Each task SHALL be assigned an immutable `owner_session` matching the creating session's ID. Task IDs SHALL be generated using nanoid.

#### Scenario: Create a root task
- **WHEN** a session creates a task with title "Build auth system" and type "epic"
- **THEN** a task is created with status "open", the session's ID as owner_session, and no parent_id

#### Scenario: Create a child task
- **WHEN** a session creates a task with parent_id pointing to an existing epic owned by the same session
- **THEN** a child task is created linked to the parent via parent_id

#### Scenario: Create task from non-owner session
- **WHEN** session B attempts to create a child task under a task owned by session A
- **THEN** the creation is rejected with an ownership error

### Requirement: Task status lifecycle
The system SHALL support task statuses: open, in_progress, blocked, closed. Status transitions SHALL be: open → in_progress, open → closed, in_progress → closed, in_progress → blocked, blocked → in_progress, blocked → closed. When a task transitions to "closed", a close_reason and closed_at timestamp SHALL be recorded.

#### Scenario: Close a task
- **WHEN** the owner session closes a task with status "in_progress" and provides a close_reason
- **THEN** the task status changes to "closed", closed_at is set, and a task_event is broadcast

#### Scenario: Invalid status transition
- **WHEN** a session attempts to transition a closed task to in_progress
- **THEN** the transition is rejected

### Requirement: Dependency graph with blocking edges
The system SHALL support dependency edges between tasks with types: "blocks" (blocking), "parent-child" (blocking), and "related" (non-blocking). Blocking dependencies SHALL affect ready-work computation. The system SHALL reject dependency additions that would create a cycle in the blocking dependency subgraph.

#### Scenario: Add a blocking dependency
- **WHEN** a dependency of type "blocks" is added where task B depends on task A
- **THEN** task B is not returned by ready-work queries until task A is closed

#### Scenario: Cycle detection
- **WHEN** adding a dependency that would create a cycle (A blocks B, B blocks C, C blocks A)
- **THEN** the dependency addition is rejected with a cycle error

#### Scenario: Non-blocking dependency
- **WHEN** a "related" dependency is added between task A and task B
- **THEN** the dependency is stored but does not affect ready-work computation

### Requirement: Ready-work computation
The system SHALL compute ready tasks as: tasks with status "open" whose blocking dependencies (type "blocks" or "parent-child") are all in "closed" status. Tasks with no blocking dependencies and status "open" SHALL always be ready.

#### Scenario: Task becomes ready when blocker closes
- **WHEN** task A blocks task B, and task A is closed
- **THEN** task B appears in ready-work query results

#### Scenario: Task with multiple blockers
- **WHEN** task C depends on both task A and task B (both blocking), and only task A is closed
- **THEN** task C does not appear in ready-work results until task B is also closed

### Requirement: Session ownership model
The system SHALL enforce that only the owner session (and its subagent child sessions) can create, update, or close tasks they own. All other sessions SHALL have read-only access to all tasks. The owner_session field SHALL be immutable after creation.

#### Scenario: Read-only cross-session access
- **WHEN** session B queries the task list
- **THEN** session B sees all tasks from all sessions but cannot modify tasks owned by session A

#### Scenario: Subagent inherits parent authority
- **WHEN** a subagent session (child of session A) attempts to update a task owned by session A
- **THEN** the update succeeds because subagent sessions inherit their parent's write authority

### Requirement: Task tree query
The system SHALL support querying the full task hierarchy from any root task, returning all descendants with their status, depth, and dependency information.

#### Scenario: Query epic tree
- **WHEN** a session queries the tree for an epic with 3 child tasks (one with 2 subtasks)
- **THEN** the result contains all 6 tasks with correct parent-child relationships and depths

### Requirement: Task persistence in DO SQLite
Tasks and dependencies SHALL be stored in dedicated SQLite tables within the Durable Object, separate from the session store tables. Tasks SHALL persist across DO hibernation and restart.

#### Scenario: Tasks survive hibernation
- **WHEN** the DO hibernates and wakes
- **THEN** all tasks and dependencies are intact and queryable

### Requirement: Real-time task events
The system SHALL broadcast a `task_event` transport message to all connected WebSocket clients when a task is created, updated, closed, or when a dependency is added or removed. The event SHALL include the full task object and the change type.

#### Scenario: Task update broadcast
- **WHEN** a task status changes from "open" to "in_progress"
- **THEN** all WebSocket connections on the DO receive a `task_event` with type "updated" and the full task object

### Requirement: Task tools
The capability SHALL provide the following tools: `task_create` (create a task with optional parent and dependencies), `task_update` (update status, priority, description), `task_close` (close with reason), `task_ready` (list ready tasks), `task_tree` (show hierarchy from a root), `task_dep_add` (add dependency edge).

#### Scenario: Agent uses task_ready to find work
- **WHEN** the agent calls task_ready
- **THEN** it receives a list of tasks whose blocking dependencies are all satisfied

#### Scenario: Agent creates task with dependencies
- **WHEN** the agent calls task_create with a parent ID and a list of blocking dependency IDs
- **THEN** the task is created and dependency edges are added atomically
