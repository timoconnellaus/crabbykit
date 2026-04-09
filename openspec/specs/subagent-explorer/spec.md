# subagent-explorer Specification

## Purpose
TBD - created by archiving change subagents-and-tasks. Update Purpose after archive.
## Requirements
### Requirement: Pre-built explorer profile
The system SHALL provide an `explorer()` function that returns a SubagentProfile configured for fast, read-only codebase exploration. The profile SHALL have id "explorer", a system prompt focused on finding information quickly, and a tool allowlist limited to read-only operations.

#### Scenario: Default explorer profile
- **WHEN** a consumer calls `explorer()` with no arguments
- **THEN** a SubagentProfile is returned with read-only tools and no model override (inherits parent's model)

#### Scenario: Explorer with model override
- **WHEN** a consumer calls `explorer({ model: "google/gemini-2.5-flash" })`
- **THEN** a SubagentProfile is returned with the specified model override

### Requirement: Explorer tool filtering
The explorer profile SHALL filter the parent's resolved tools to only include read-only tools. The default filter SHALL match tools by name pattern (e.g., names containing "read", "search", "list", "get", "find", "grep", "glob", "tree"). The consumer SHALL be able to override the filter via profile options.

#### Scenario: Explorer inherits parent's read-only tools
- **WHEN** the parent has tools [file_read, file_write, file_edit, file_list, grep, tavily_search]
- **THEN** the explorer subagent has access to [file_read, file_list, grep, tavily_search] (write/edit filtered out)

#### Scenario: Consumer overrides tool filter
- **WHEN** a consumer calls `explorer({ tools: ["file_read", "custom_search"] })`
- **THEN** the explicit tools list is used instead of the default read-only filter

### Requirement: Explorer system prompt
The explorer profile SHALL include a system prompt that instructs the agent to focus on finding information quickly, reporting findings concisely, and avoiding any file modifications. The prompt SHALL be a function that receives the parent's base system prompt for context.

#### Scenario: Explorer prompt includes parent context
- **WHEN** the explorer subagent is initialized
- **THEN** its system prompt includes relevant context from the parent's system prompt plus exploration-specific instructions

