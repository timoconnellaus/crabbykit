## ADDED Requirements

### Requirement: Mode type and defineMode factory

The SDK SHALL define a `Mode` interface representing a named scoped view of the agent's capabilities and prompt, importable from the subpath `@claw-for-cloudflare/agent-runtime/modes`. The SDK SHALL export a `defineMode(mode: Mode): Mode` factory function for identity-typed authoring.

The `Mode` interface SHALL include:
- `id: string` — unique, kebab-case identifier
- `name: string` — human-readable display name
- `description: string` — one-line description
- `capabilities?: { allow?: string[]; deny?: string[] }` — capability ID allow/deny filter (coarse)
- `tools?: { allow?: string[]; deny?: string[] }` — tool name allow/deny filter (fine)
- `promptAppend?: string | ((context: AgentContext) => string)` — text appended to the system prompt after base and capability sections
- `systemPromptOverride?: string | ((base: string, context: AgentContext) => string)` — full replacement of the base system prompt
- `capabilityConfig?: Record<string, Record<string, unknown>>` — transient config merged into capability configs while the mode is active
- `model?: string` — OpenRouter model ID override; applied only when the mode is used to spawn a subagent, silently ignored when applied to the current session

#### Scenario: Consumer defines a custom mode
- **WHEN** a consumer calls `defineMode({ id: "plan", name: "Planning", description: "...", tools: { deny: ["file_write"] }, promptAppend: "..." })`
- **THEN** the returned object is a `Mode` with the declared fields and may be passed to `defineAgent({ modes: () => [mode] })` or `{ subagentModes: () => [mode] }`

#### Scenario: Mode model is ignored in main session
- **WHEN** a mode with `model: "google/gemini-2.5-flash"` is activated on the current session via `/mode` or `enter_mode`
- **THEN** the main session continues to use the agent's configured default model and the mode's `model` field is silently ignored

#### Scenario: Mode model applies to subagent spawns
- **WHEN** a mode with `model: "google/gemini-2.5-flash"` is used to spawn a subagent via `call_subagent` or `start_subagent`
- **THEN** the subagent's Agent instance is constructed with the override model ID while inheriting the parent's API key and provider

#### Scenario: systemPromptOverride function form receives parent context for subagents
- **WHEN** a mode is used to spawn a subagent and its `systemPromptOverride` is a function
- **THEN** the function is called with `(parentSystemPrompt, parentContext)` where `parentContext` is the parent session's `AgentContext` — not the child session's. This SHALL be documented on the field's JSDoc.

### Requirement: defineMode rejects conflicting allow and deny

`defineMode(mode)` SHALL throw a validation error when `mode.capabilities` or `mode.tools` specifies both `allow` and `deny` on the same filter. The error message SHALL identify which field is invalid.

#### Scenario: Tools filter with both allow and deny rejected
- **WHEN** `defineMode({ id: "x", name: "X", description: "...", tools: { allow: ["file_read"], deny: ["file_write"] } })` is called
- **THEN** the call throws an error whose message identifies `tools` as the invalid filter

#### Scenario: Capabilities filter with both allow and deny rejected
- **WHEN** `defineMode({ id: "x", name: "X", description: "...", capabilities: { allow: ["r2-storage"], deny: ["vibe-coder"] } })` is called
- **THEN** the call throws an error whose message identifies `capabilities` as the invalid filter

#### Scenario: Allow-only filter accepted
- **WHEN** `defineMode({ id: "x", name: "X", description: "...", tools: { allow: ["file_read"] } })` is called
- **THEN** the call returns a valid Mode

#### Scenario: Deny-only filter accepted
- **WHEN** `defineMode({ id: "x", name: "X", description: "...", tools: { deny: ["file_write"] } })` is called
- **THEN** the call returns a valid Mode

#### Scenario: Different filters may independently use allow or deny
- **WHEN** `defineMode({ id: "x", name: "X", description: "...", capabilities: { allow: ["r2-storage"] }, tools: { deny: ["file_write"] } })` is called
- **THEN** the call returns a valid Mode (allow and deny on different filters is fine; only both on the same filter is rejected)

### Requirement: filterToolsAndSections is a low-level pure filter

The SDK SHALL export a `filterToolsAndSections(tools: AnyAgentTool[], sections: PromptSection[], activeMode: Mode | null): { tools: AnyAgentTool[]; sections: PromptSection[] }` pure function. It SHALL apply only the `tools.allow` / `tools.deny` filter to `tools`, and SHALL flip capability-sourced prompt sections to `included: false` when the mode's `capabilities.deny` (or absence from `capabilities.allow`) matches the section's `source.capabilityId`. The function SHALL be pure and MUST NOT look up the active mode by sessionId internally. When `activeMode` is `null`, it SHALL return the input arrays unchanged.

This low-level function is the direct call site for `packages/subagent`, which does not have a `ResolvedCapabilities` object at its call site and only needs to filter a flat tool list against a mode.

#### Scenario: Null active mode is a pass-through
- **WHEN** `filterToolsAndSections(tools, sections, null)` is called
- **THEN** the returned `tools` equals the input `tools` and `sections` equals the input `sections`

#### Scenario: Tool-level deny filter removes tools
- **WHEN** a mode with `tools: { deny: ["file_write", "file_delete"] }` is applied to `tools` containing `file_write`, `file_read`, and `file_delete`
- **THEN** the returned `tools` contains only `file_read`

#### Scenario: Tool-level allow filter restricts tools
- **WHEN** a mode with `tools: { allow: ["file_read", "grep"] }` is applied
- **THEN** the returned `tools` contains only tools whose names appear in the allow list

#### Scenario: Capability-level filter excludes prompt sections
- **WHEN** a mode with `capabilities: { deny: ["vibe-coder"] }` is applied and `sections` contains a section with `source.type === "capability"` and `source.capabilityId === "vibe-coder"`
- **THEN** the returned section is marked `included: false` with `content: ""`, `lines: 0`, and `excludedReason` containing the mode ID

### Requirement: applyMode wraps filterToolsAndSections with capability plumbing

The SDK SHALL export an `applyMode(resolved: ResolvedCapabilities, capabilities: Capability[], allTools: AnyAgentTool[], activeMode: Mode | null, context: AgentContext): AppliedMode` higher-level function. It SHALL:
1. Compute the set of "dead" capability IDs (those excluded by the mode's `capabilities` filter) from the full capability list
2. Remove tools contributed by dead capabilities from `allTools` before delegating to `filterToolsAndSections`
3. Pass `resolved.promptSections` to `filterToolsAndSections` for section exclusion
4. Resolve `promptAppend` and `systemPromptOverride` (calling them with `context` if they are functions)
5. Return an `AppliedMode` containing the filtered tools, filtered sections, resolved prompt append/override strings

`applyMode` SHALL be called from `ensureAgent()` on the main session. It SHALL NOT be called from `packages/subagent` (which uses the low-level `filterToolsAndSections` directly).

When `activeMode` is `null`, `applyMode` SHALL return a pass-through `AppliedMode` containing the input tools, input sections, and no prompt append or override.

#### Scenario: Null active mode pass-through
- **WHEN** `applyMode(resolved, capabilities, allTools, null, context)` is called
- **THEN** the returned `tools` equals `allTools`, the returned `promptSections` equals `resolved.promptSections`, and no prompt append or override is set

#### Scenario: Dead capability tools are removed before filter
- **WHEN** a mode with `capabilities: { allow: ["r2-storage"] }` is applied and a vibe-coder tool appears in `allTools`
- **THEN** the vibe-coder tool is removed from the returned `tools` (before the tool-level filter runs)

#### Scenario: promptAppend function form receives context
- **WHEN** a mode with `promptAppend: (ctx) => \`Session: ${ctx.sessionId}\`` is applied
- **THEN** the returned `promptAppend` string reflects the `sessionId` from the passed `context`

#### Scenario: systemPromptOverride function form receives base and context
- **WHEN** a mode with `systemPromptOverride: (base, ctx) => \`${base}\n\nExtended\`` is applied
- **THEN** the returned `systemPromptOverride` resolver, when called with the base prompt, returns the concatenated string

### Requirement: mode_change session entry variant

The SDK SHALL add `"mode_change"` as a first-class variant of `SessionEntryType`. Each `ModeChangeEntry` SHALL carry a data payload of `{ enter: string }` (mode ID entered) or `{ exit: string }` (mode ID being exited — NOT a boolean sentinel). Entries SHALL be appended to the session via the existing immutable append-log and SHALL survive branching (parent_id tree traversal).

#### Scenario: Entering a mode appends an entry
- **WHEN** a user invokes `/mode plan` or the agent calls `enter_mode({ id: "plan" })`
- **THEN** a new `mode_change` session entry is appended with `data: { enter: "plan" }`

#### Scenario: Exiting a mode appends an entry with the exited mode ID
- **WHEN** a user invokes `/mode` with no argument or the agent calls `exit_mode()` while `"plan"` is the active mode
- **THEN** a new `mode_change` session entry is appended with `data: { exit: "plan" }`

#### Scenario: Exit entry preserves mode history
- **WHEN** a consumer inspects the session log after `[enter "plan"], [exit "plan"]`
- **THEN** the exit entry contains the exited mode ID so the history is self-describing without walking backward

### Requirement: Active mode is cached on session metadata

The session metadata row SHALL include an optional `activeModeId: string | null` field. When a `mode_change` entry is appended:
- `enter` → `activeModeId` SHALL be set to the entered mode ID **in the same transaction** as the entry append
- `exit`  → `activeModeId` SHALL be set to `null` **in the same transaction** as the entry append

`ensureAgent()` SHALL read `activeModeId` from session metadata directly and look up the corresponding `Mode` from the agent's `getModes()` list. This SHALL be the primary path and SHALL be O(1) with respect to session length.

Session branching SHALL initialize the branch's `activeModeId` from the parent chain's most recent `mode_change` entry at branch time (using `resolveActiveMode`'s walk form). After initialization, the branch maintains its own cached `activeModeId`.

#### Scenario: Active mode lookup is O(1)
- **WHEN** `ensureAgent(sessionId)` resolves the active mode on a session with 10,000 entries
- **THEN** the lookup reads `activeModeId` from session metadata without scanning the entry log

#### Scenario: Entry append and metadata update are atomic
- **WHEN** `/mode plan` appends a `mode_change` entry
- **THEN** the entry and the `activeModeId` metadata field are updated in the same transaction (no intermediate state where the entry exists but the metadata is stale)

#### Scenario: Branching initializes cache from parent chain
- **WHEN** a new branch is created from a session with an active mode
- **THEN** the branch's `activeModeId` metadata is initialized by walking the parent's entries to find the most recent `mode_change`

### Requirement: resolveActiveMode walks session entries as fallback

The SDK SHALL provide a `resolveActiveMode(sessionId: string, modes: Mode[]): Mode | null` helper that walks session entries from the current leaf toward the root, returns the mode whose ID matches the most recent `mode_change` entry with `data.enter`, and returns `null` when the most recent `mode_change` is an exit entry or no `mode_change` entries exist.

This helper SHALL be called only:
1. At session branch time, to initialize the branch's `activeModeId` cache
2. As a consistency fallback when session metadata lacks `activeModeId` (corrupted or pre-feature data)

It SHALL NOT be called from `ensureAgent()` on every turn — that path uses the cached `activeModeId` directly.

#### Scenario: Most recent entry determines active mode
- **WHEN** a session has entries: [enter "plan"], [message], [message]
- **THEN** `resolveActiveMode(sessionId, modes)` returns the mode with id "plan"

#### Scenario: Explicit exit clears active mode
- **WHEN** a session has entries: [enter "plan"], [exit "plan"], [message]
- **THEN** `resolveActiveMode(sessionId, modes)` returns `null`

#### Scenario: No mode_change entries means no active mode
- **WHEN** a session has only [message] and [tool_event] entries
- **THEN** `resolveActiveMode(sessionId, modes)` returns `null`

#### Scenario: Unknown mode ID in entry returns null
- **WHEN** the most recent `mode_change` entry references an ID that is not in the provided modes list
- **THEN** `resolveActiveMode(sessionId, modes)` returns `null`

### Requirement: mode_event transport message

The SDK SHALL add a `mode_event` discriminated variant to `ServerMessage` with shape `{ type: "mode_event"; sessionId: string; event: { kind: "entered"; modeId: string; modeName: string } | { kind: "exited"; modeId: string; modeName: string } }`. Both event kinds carry the mode ID (entered or exited) and its human-readable name. The server SHALL emit a `mode_event` immediately after appending a `mode_change` session entry and SHALL include the current `activeMode` (if any) in the `session_sync` payload.

#### Scenario: Mode entry broadcasts to connected clients
- **WHEN** a `mode_change` entry with `data: { enter: "plan" }` is appended and clients are connected to the session
- **THEN** each connected client receives a `mode_event` message with `event.kind === "entered"`, `event.modeId === "plan"`, and the mode's human-readable name

#### Scenario: session_sync includes active mode
- **WHEN** a client reconnects to a session that has an active mode
- **THEN** the `session_sync` payload includes an `activeMode: { id, name }` field reflecting the resolved active mode

#### Scenario: Old clients ignore mode_event
- **WHEN** a client built before the `mode_event` variant receives a `mode_event` message
- **THEN** the message is silently ignored (no default case in the discriminated union switch; forward-compatible by construction)

### Requirement: Slash command and tools are conditionally registered

The SDK SHALL expose `/mode <id>` slash command, `enter_mode` tool, and `exit_mode` tool only when the agent has **at least two** modes registered via `getModes()` or `defineAgent.modes`. When zero or one mode is registered, the SDK SHALL NOT register any mode-related slash command, tool, or base-prompt "Current mode: X" section.

#### Scenario: Agent with zero modes has no mode machinery
- **WHEN** an agent is registered with no `modes` slot or an empty array
- **THEN** `/mode` is not in the command list, `enter_mode`/`exit_mode` are not in the tool list, and the system prompt contains no mode indicator section

#### Scenario: Agent with one mode has no mode machinery
- **WHEN** an agent is registered with exactly one mode
- **THEN** `/mode` is not in the command list, `enter_mode`/`exit_mode` are not in the tool list, and the system prompt contains no mode indicator section

#### Scenario: Agent with two or more modes gets mode machinery
- **WHEN** an agent is registered with two or more modes
- **THEN** `/mode` is in the command list, `enter_mode` and `exit_mode` are in the tool list, and the system prompt includes a "Current mode" indicator when a mode is active

### Requirement: /mode slash command

The SDK SHALL provide a `/mode` slash command that (a) with no argument exits the current mode by appending a `mode_change` exit entry, and (b) with a mode ID argument enters that mode by appending a `mode_change` enter entry. The command SHALL return an error if the argument references an unknown mode ID.

#### Scenario: /mode with known ID enters mode
- **WHEN** the user invokes `/mode plan` and `plan` is a registered mode
- **THEN** a `mode_change` entry with `data: { enter: "plan" }` is appended, a `mode_event` is broadcast, and the command returns a success message

#### Scenario: /mode with no argument exits mode
- **WHEN** the user invokes `/mode` with no argument and a mode is currently active
- **THEN** a `mode_change` entry with `data: { exit: true }` is appended, a `mode_event` is broadcast, and the command returns a success message

#### Scenario: /mode with unknown ID fails
- **WHEN** the user invokes `/mode nonexistent` and no mode with that ID is registered
- **THEN** the command returns an error message listing the available mode IDs and no entry is appended

### Requirement: enter_mode and exit_mode agent tools

The SDK SHALL provide `enter_mode` and `exit_mode` agent tools that mirror the `/mode` slash command semantics for model-initiated transitions. `enter_mode({ id })` SHALL append a `mode_change` enter entry; `exit_mode()` SHALL append a `mode_change` exit entry. Both tools SHALL broadcast `mode_event` messages on success and return structured content describing the transition.

#### Scenario: Agent enters a mode
- **WHEN** the model calls `enter_mode({ id: "plan" })`
- **THEN** a `mode_change` entry is appended, a `mode_event` is broadcast, and the tool result content describes the entered mode

#### Scenario: Agent exits a mode
- **WHEN** the model calls `exit_mode()` while a mode is active
- **THEN** a `mode_change` entry with `data: { exit: true }` is appended, a `mode_event` is broadcast, and the tool result content describes the exit

### Requirement: Built-in planMode reference export

The SDK SHALL export a `planMode` constant from `@claw-for-cloudflare/agent-runtime/modes` with `id: "plan"`, `name: "Planning"`, a conservative tool deny list covering common CLAW-ecosystem write/exec tool names (file_write, file_edit, file_delete, file_move, file_copy, exec, process, show_preview, hide_preview, browser_click, browser_type, browser_navigate), and a `promptAppend` instructing the model to investigate and produce a plan file before executing changes. `planMode` SHALL have no runtime imports from capability packages.

`planMode` SHALL carry a JSDoc comment clearly stating that its deny list is **only a starting point for agents using CLAW ecosystem capabilities**, and that consumers with custom tool names (e.g., `db_insert`, `write_file`, `api_post`) MUST extend or replace the deny list. The JSDoc SHALL show the composition pattern:

```ts
// For agents with custom write tool names:
const myPlanMode = defineMode({
  ...planMode,
  tools: { deny: [...(planMode.tools?.deny ?? []), "db_insert", "write_file"] },
});
```

#### Scenario: planMode denies known ecosystem write tools
- **WHEN** `planMode` is inspected
- **THEN** its `tools.deny` array includes `file_write`, `file_edit`, and `file_delete`

#### Scenario: planMode is safe on agents without those tools
- **WHEN** an agent without r2-storage uses `planMode`
- **THEN** the `file_write` deny entry is a harmless no-op and no error is raised

#### Scenario: planMode has no capability-package imports
- **WHEN** the imports in `built-in/plan.ts` are inspected
- **THEN** no import references any capability package (r2-storage, sandbox, vibe-coder, etc.)

#### Scenario: planMode JSDoc warns about custom tool names
- **WHEN** a developer hovers over `planMode` in their IDE
- **THEN** the JSDoc states that the deny list only covers CLAW ecosystem tool names and shows the composition pattern for extending it

### Requirement: Client hook tracks active mode

The `useAgentChat()` client hook SHALL expose an `activeMode: { id: string; name: string } | null` field in its state. The field SHALL be updated in response to `mode_event` messages and initialized from the `activeMode` field of the `session_sync` payload on connection.

#### Scenario: activeMode updates on mode_event
- **WHEN** the client receives a `mode_event` with `event.kind === "entered"`
- **THEN** the `activeMode` state is set to the mode's id and name

#### Scenario: activeMode clears on exit
- **WHEN** the client receives a `mode_event` with `event.kind === "exited"`
- **THEN** the `activeMode` state is set to `null`

#### Scenario: activeMode initializes from session_sync
- **WHEN** the client reconnects to a session with an active mode and receives `session_sync`
- **THEN** the `activeMode` state is initialized from the `session_sync.activeMode` field

### Requirement: Subpath export

The `@claw-for-cloudflare/agent-runtime` package SHALL add a `./modes` subpath export that resolves to `src/modes/index.ts`. The barrel file SHALL export:
- `defineMode` (factory)
- `type Mode`, `type AppliedMode` (public types)
- `filterToolsAndSections` (low-level filter, called directly by `packages/subagent`)
- `applyMode` (high-level wrapper, called by `ensureAgent`)
- `resolveActiveMode` (walk-form helper, for branch init and consistency fallback)
- `planMode` (built-in)

Implementation-detail helpers (e.g., an internal `excludePromptSectionsForMode` utility used by `filterToolsAndSections`) SHALL NOT be part of the barrel. They SHALL remain module-private and testable via direct module imports in the `__tests__/` directory.

Type-level imports from other `agent-runtime` modules (e.g., `PromptSection`, `AgentContext`) SHALL continue to flow through the main package barrel.

#### Scenario: Subpath import works
- **WHEN** a consumer writes `import { defineMode, planMode } from "@claw-for-cloudflare/agent-runtime/modes"`
- **THEN** the imports resolve to the `src/modes/index.ts` barrel

#### Scenario: Main barrel does not re-export mode primitives
- **WHEN** `packages/agent-runtime/src/index.ts` is inspected
- **THEN** it does not re-export `defineMode` or `planMode` (these live only on the `./modes` subpath)

#### Scenario: Implementation-detail helpers are not exported
- **WHEN** `src/modes/index.ts` is inspected
- **THEN** it does not export `excludePromptSectionsForMode` or any other helper that exists purely to implement `filterToolsAndSections` / `applyMode`

### Requirement: Mode filtering does not affect capability lifecycle

Mode filtering SHALL apply exclusively to the set of tools and prompt sections presented to the LLM during inference. Capability lifecycle hooks (`onConnect`, `beforeInference`, `beforeToolExecution`, `afterToolExecution`, `onConfigChange`, `dispose`), `httpHandlers`, `schedules`, and `onAction` handlers SHALL continue to fire according to their existing rules regardless of the active mode.

#### Scenario: onConnect fires regardless of active mode
- **WHEN** a client connects to a session with an active mode that filters out a capability
- **THEN** the filtered capability's `onConnect` hook still fires

#### Scenario: HTTP handlers are not mode-aware
- **WHEN** a capability registers an HTTP handler and a mode is active that denies that capability
- **THEN** the HTTP handler still responds to requests matching its method and path
