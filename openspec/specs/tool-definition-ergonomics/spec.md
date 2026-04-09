# tool-definition-ergonomics Specification

## Purpose
TBD - created by archiving change capability-state-protocol. Update Purpose after archive.
## Requirements
### Requirement: defineTool returns are assignable to Capability.tools() without casts
`defineTool<T>()` return values SHALL be directly assignable to the array type returned by `Capability.tools()` without `as unknown as AgentTool` double-casts or `any[]` workarounds.

#### Scenario: Tool assigned to capability tools array
- **WHEN** a capability's `tools()` method returns `[defineTool({ name: "my_tool", ... })]`
- **THEN** TypeScript compiles without errors and without type casts

#### Scenario: Multiple tools with different parameter schemas
- **WHEN** a capability returns `[toolA, toolB]` where each has different `TObject<{...}>` parameter types
- **THEN** the array is assignable to the capability's return type without casts

### Requirement: Tool execute accepts string return for text-only results
`defineTool()` SHALL accept an `execute` function that returns `string | AgentToolResult`. When `execute` returns a string, the framework SHALL wrap it into `{ content: [{ type: "text", text: <string> }], details: null }`.

#### Scenario: Simple string return
- **WHEN** a tool's `execute` returns `"Task created successfully"`
- **THEN** the framework produces `{ content: [{ type: "text", text: "Task created successfully" }], details: null }` as the tool result

#### Scenario: Full AgentToolResult still works
- **WHEN** a tool's `execute` returns `{ content: [{ type: "text", text: "..." }], details: { id: 1 } }`
- **THEN** the result is passed through unchanged

#### Scenario: Error string return
- **WHEN** a tool's `execute` returns a string but the tool wants to signal an error
- **THEN** the tool uses `toolResult.error("message")` which returns a full `AgentToolResult` with `isError: true`

### Requirement: AgentContext.storage is non-optional
`AgentContext.storage` SHALL be typed as `CapabilityStorage` (not `CapabilityStorage | undefined`). The capability resolver always provides storage, so the optional type is a lie that forces unnecessary null checks.

#### Scenario: Tool accesses storage without null check
- **WHEN** a tool's `execute` accesses `context.storage.get("key")`
- **THEN** TypeScript does not require a null/undefined check

### Requirement: AgentContext exposes broadcastState
`AgentContext` SHALL include `broadcastState(event: string, data: unknown, scope?: "session" | "global")` for capabilities to broadcast state via the envelope protocol.

#### Scenario: Tool broadcasts state update
- **WHEN** a tool calls `context.broadcastState("update", { task })`
- **THEN** a `capability_state` message is sent with the capability's ID and default session scope

