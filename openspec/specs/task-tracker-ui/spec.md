# task-tracker-ui Specification

## Purpose
TBD - created by archiving change subagents-and-tasks. Update Purpose after archive.
## Requirements
### Requirement: TaskTreePanel component
The system SHALL provide a `TaskTreePanel` React component that renders a collapsible tree view of tasks. Each task node SHALL display title, status (with visual indicator), type, and priority. The tree SHALL update in real-time via `task_event` transport messages.

#### Scenario: Render task hierarchy
- **WHEN** TaskTreePanel receives a task tree with an epic containing 3 child tasks
- **THEN** it renders a collapsible tree with the epic as root and tasks as children, each showing status indicators

#### Scenario: Live update on task status change
- **WHEN** a `task_event` with type "updated" arrives via WebSocket
- **THEN** the affected task node updates its status indicator without a full re-render

### Requirement: TaskBreadcrumb component
The system SHALL provide a `TaskBreadcrumb` React component that displays the path from a root epic to the currently active task as a breadcrumb trail. The active task is determined by the current session's claimed in_progress task.

#### Scenario: Display breadcrumb for leaf task
- **WHEN** the current session has an in_progress task that is a child of a child of an epic
- **THEN** the breadcrumb shows: Epic Title > Parent Task Title > Current Task Title

#### Scenario: No active task
- **WHEN** the current session has no in_progress task
- **THEN** the TaskBreadcrumb renders nothing (hidden)

### Requirement: Styling isolation
All task-tracker UI components SHALL use `data-agent-ui` attribute selectors for styling, consistent with existing agent-ui components. Components SHALL not use global CSS or CSS modules.

#### Scenario: Component attribute selectors
- **WHEN** TaskTreePanel and TaskBreadcrumb are rendered
- **THEN** all elements have `data-agent-ui` attributes for style targeting

