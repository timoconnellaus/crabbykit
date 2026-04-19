## MODIFIED Requirements

### Requirement: Pre-built explorer mode

The system SHALL provide an `explorer(options?)` function that returns a `Mode` configured for fast, read-only codebase exploration, and SHALL export the default configuration as a named constant `explorerMode` (replacing the legacy `explorerProfile` export). The mode SHALL have `id: "explorer"`, a `systemPromptOverride` focused on finding information quickly, and a `tools` allow-list (or deny-filter) limited to read-only operations.

#### Scenario: Default explorer mode
- **WHEN** a consumer imports `explorerMode` from `@crabbykit/subagent-explorer`
- **THEN** a `Mode` value is available with read-only tools and no model override (inherits parent's model)

#### Scenario: Explorer with model override via factory
- **WHEN** a consumer calls `explorer({ model: "google/gemini-2.5-flash" })`
- **THEN** a `Mode` is returned with the specified model override

#### Scenario: No legacy explorerProfile export
- **WHEN** `packages/subagent-explorer/src/index.ts` is inspected
- **THEN** it does not export `explorerProfile` — only `explorerMode` (and the `explorer()` factory)

### Requirement: Explorer tool filtering

The explorer mode SHALL populate its `tools` field using the shared `Mode` tool filter shape (`{ allow?: string[]; deny?: string[] }`). The default filter SHALL match tool names that correspond to read-only operations (e.g., names containing `read`, `search`, `list`, `get`, `find`, `grep`, `glob`, `tree`). The consumer SHALL be able to override the filter via `explorer({ tools: [...] })`, which sets the `allow` list directly.

#### Scenario: Explorer inherits parent's read-only tools
- **WHEN** the parent has tools `[file_read, file_write, file_edit, file_list, grep, tavily_search]` and the subagent is spawned with `explorerMode`
- **THEN** the subagent has access to `[file_read, file_list, grep, tavily_search]` after applyMode filtering (write/edit removed)

#### Scenario: Consumer overrides tool filter
- **WHEN** a consumer calls `explorer({ tools: ["file_read", "custom_search"] })`
- **THEN** the returned `Mode.tools.allow` equals `["file_read", "custom_search"]` and applyMode uses it as the allowlist

### Requirement: Explorer system prompt

The explorer mode SHALL populate its `systemPromptOverride` field with a function that receives the parent's base system prompt and an `AgentContext`, and returns a prompt instructing the agent to focus on finding information quickly, reporting findings concisely, and avoiding any file modifications. The function form SHALL be used in place of the legacy `systemPrompt: string | ((parentPrompt: string) => string)` field.

#### Scenario: Explorer prompt includes parent context
- **WHEN** the explorer subagent is initialized
- **THEN** its system prompt (produced by `systemPromptOverride(parentPrompt, context)`) includes relevant context from the parent's system prompt plus exploration-specific instructions

## RENAMED Requirements

- FROM: `### Requirement: Pre-built explorer profile`
- TO: `### Requirement: Pre-built explorer mode`
