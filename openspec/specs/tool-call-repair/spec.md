# tool-call-repair Specification

## Purpose
TBD - created by archiving change opencode-patterns. Update Purpose after archive.
## Requirements
### Requirement: Case-insensitive tool name matching
When the LLM produces a tool call with a name that does not exactly match any registered tool, the system SHALL attempt case-insensitive matching before failing.

#### Scenario: LLM calls tool with wrong casing
- **WHEN** the LLM calls "Get_Current_Time" but the registered tool is "get_current_time"
- **THEN** the system SHALL resolve the call to "get_current_time" and execute it normally

#### Scenario: No case-insensitive match exists
- **WHEN** the LLM calls "nonexistent_tool" and no registered tool matches case-insensitively
- **THEN** the system SHALL proceed to the error feedback mechanism

### Requirement: Structured error feedback for unresolved tool calls
When a tool call cannot be resolved (no exact or case-insensitive match), the system SHALL return a structured error result to the LLM containing the invalid tool name, a list of available tool names, and the closest match (by edit distance) if one exists.

#### Scenario: LLM calls a non-existent tool
- **WHEN** the LLM calls "search_web" but available tools are ["web_search", "web_fetch", "get_time"]
- **THEN** the system SHALL return an error result: "Tool 'search_web' not found. Did you mean 'web_search'? Available tools: web_search, web_fetch, get_time"

#### Scenario: LLM calls a non-existent tool with no close match
- **WHEN** the LLM calls "xyz_123" and no registered tool has a similar name
- **THEN** the system SHALL return an error result listing available tools without a "did you mean" suggestion

### Requirement: Repair does not bypass tool validation
When a tool call is resolved via case-insensitive matching, the resolved tool's parameter validation SHALL still run normally. Only the name lookup is repaired.

#### Scenario: Case-repaired tool call with invalid arguments
- **WHEN** the LLM calls "Get_Current_Time" (resolved to "get_current_time") with invalid arguments
- **THEN** the system SHALL return the standard parameter validation error (not a repair error)

