## ADDED Requirements

### Requirement: SubagentCard component
The system SHALL provide a `SubagentCard` React component that displays a running subagent's activity. Each card SHALL show: profile name, current status (running/completed/failed), task breadcrumb (if associated with a task), and live streaming text from the subagent's latest message.

#### Scenario: Display running subagent
- **WHEN** a non-blocking subagent is running with profile "explorer" on task "Find auth modules"
- **THEN** the SubagentCard shows the profile name, a running indicator, the task breadcrumb, and streams the subagent's current output

#### Scenario: Subagent completes
- **WHEN** a running subagent completes successfully
- **THEN** the SubagentCard transitions to a completed state showing a summary of the result

#### Scenario: Multiple concurrent subagents
- **WHEN** two non-blocking subagents are running simultaneously
- **THEN** two SubagentCards are displayed, each streaming independently

### Requirement: SubagentCard updates from transport events
The SubagentCard SHALL update in real-time from `subagent_event` transport messages. The component SHALL handle message_start, message_update, message_end, and agent_end events to display live streaming progress.

#### Scenario: Live streaming from subagent
- **WHEN** a `subagent_event` wrapping a `message_update` arrives
- **THEN** the corresponding SubagentCard updates its displayed text with the streaming content

### Requirement: Styling isolation
All subagent UI components SHALL use `data-agent-ui` attribute selectors for styling, consistent with existing agent-ui components.

#### Scenario: Component attribute selectors
- **WHEN** SubagentCard is rendered
- **THEN** all elements have `data-agent-ui` attributes for style targeting
