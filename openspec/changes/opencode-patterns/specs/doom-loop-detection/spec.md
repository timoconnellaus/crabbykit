## ADDED Requirements

### Requirement: Detect consecutive identical tool calls
The system SHALL detect when the agent calls the same tool with identical arguments more than a configurable threshold (default: 3) within a lookback window (default: last 10 tool calls). Detection SHALL compare tool name and a deterministic JSON serialization of the arguments.

#### Scenario: Agent repeats a tool call 3 times
- **WHEN** the agent issues a tool call with the same name and arguments as the previous 2 consecutive tool calls
- **THEN** the system SHALL block the tool call and return an error result to the LLM stating: "Doom loop detected: you have called '{toolName}' with identical arguments {threshold} times. Try a different approach."

#### Scenario: Agent calls the same tool with different arguments
- **WHEN** the agent calls the same tool name but with different arguments each time
- **THEN** the system SHALL allow the call (no doom loop detected)

#### Scenario: Repeated calls are interleaved with other tools
- **WHEN** the agent calls tool A, then tool B, then tool A again with the same arguments
- **THEN** the system SHALL NOT trigger doom loop detection because the calls are not consecutive

### Requirement: Per-tool repeat opt-out
The system SHALL support an `allowRepeat` flag in tool definitions. Tools with `allowRepeat: true` SHALL be exempt from doom loop detection.

#### Scenario: Tool with allowRepeat flag is called repeatedly
- **WHEN** a tool defined with `allowRepeat: true` is called with identical arguments 3+ times consecutively
- **THEN** the system SHALL allow all calls without triggering doom loop detection

### Requirement: Configurable detection parameters
The system SHALL accept configuration for the doom loop threshold and lookback window size. These MUST be configurable per-agent via the capability config system.

#### Scenario: Custom threshold of 5
- **WHEN** the doom loop capability is configured with `{ threshold: 5 }`
- **THEN** doom loop detection SHALL only trigger after 5 consecutive identical calls (not the default 3)

### Requirement: Doom loop notification to client
The system SHALL broadcast a transport message to connected clients when a doom loop is detected, so the UI can surface it to the user.

#### Scenario: Doom loop triggers client notification
- **WHEN** a doom loop is detected and blocked
- **THEN** the system SHALL broadcast an `agent_event` with metadata indicating a doom loop was detected, including the tool name and repeat count
