# batch-tool Specification

## Purpose
TBD - created by archiving change opencode-patterns. Update Purpose after archive.
## Requirements
### Requirement: Parallel tool execution via batch tool
The system SHALL provide a `batch` tool that accepts an array of tool call descriptors and executes them in parallel via `Promise.all`. Each descriptor SHALL specify a `tool` name and `args` object. The maximum number of sub-calls per batch SHALL be 25.

#### Scenario: Batch executes 3 tools in parallel
- **WHEN** the agent calls `batch` with `[{ tool: "web_search", args: { query: "A" } }, { tool: "web_search", args: { query: "B" } }, { tool: "file_read", args: { path: "/x" } }]`
- **THEN** the system SHALL execute all 3 tool calls concurrently and return an array of results in the same order as the input

#### Scenario: Batch exceeds maximum sub-calls
- **WHEN** the agent calls `batch` with more than 25 tool call descriptors
- **THEN** the system SHALL return an error result: "Batch limited to 25 tool calls, received {n}"

### Requirement: Sub-calls run through the full hook pipeline
Each sub-call within a batch SHALL be executed through the same tool execution pipeline as a direct tool call, including `beforeToolExecution` hooks, parameter validation, timeouts, and `afterToolExecution` hooks.

#### Scenario: Doom loop detection applies to batch sub-calls
- **WHEN** a batch contains a tool call that would trigger doom loop detection
- **THEN** that specific sub-call SHALL be blocked while other sub-calls in the batch proceed normally

#### Scenario: Per-tool timeout applies to batch sub-calls
- **WHEN** a batch sub-call exceeds its tool's configured timeout
- **THEN** that sub-call SHALL return a timeout error while other sub-calls complete normally

### Requirement: Self-referential batch calls are blocked
The batch tool SHALL NOT allow sub-calls that invoke the `batch` tool itself (recursive batching).

#### Scenario: Batch contains a batch sub-call
- **WHEN** the agent calls `batch` with a sub-call where `tool` is `"batch"`
- **THEN** the system SHALL return an error for that sub-call: "Recursive batch calls are not allowed"

### Requirement: Failed sub-calls do not abort the batch
When one or more sub-calls fail (error, timeout, blocked by hook), the batch SHALL still complete all remaining sub-calls. Each result in the output array SHALL indicate whether the sub-call succeeded or failed.

#### Scenario: One sub-call fails, others succeed
- **WHEN** a batch of 3 tool calls has one that fails with an error
- **THEN** the batch result SHALL contain the error for the failed call and the successful results for the other two, all in input order

### Requirement: Batch tool resolves tools from session context
The batch tool SHALL resolve available tools from the same registry used by the current session (base tools + capability tools + MCP tools). Tool names in sub-call descriptors MUST match registered tool names.

#### Scenario: Sub-call references an unregistered tool
- **WHEN** a batch sub-call specifies `tool: "nonexistent_tool"`
- **THEN** that sub-call SHALL return an error result: "Tool 'nonexistent_tool' not found"

