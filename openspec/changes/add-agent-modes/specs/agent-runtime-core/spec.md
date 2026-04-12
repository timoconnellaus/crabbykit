## MODIFIED Requirements

### Requirement: AgentRuntime defines abstract and overridable methods

`AgentRuntime` SHALL declare `getConfig()` and `getTools(ctx)` as abstract methods. It SHALL provide default implementations for `buildSystemPrompt`, `getPromptOptions`, `getCapabilities`, `getSubagentModes` (previously `getSubagentProfiles`), `getModes`, `getConfigNamespaces`, `getA2AClientOptions`, `getCommands`, and lifecycle hooks (`validateAuth`, `onTurnEnd`, `onAgentEnd`, `onSessionCreated`, `onScheduleFire`). `getModes()` and `getSubagentModes()` SHALL default to returning an empty array.

#### Scenario: Required methods are abstract
- **WHEN** a class extends `AgentRuntime` without implementing `getConfig` or `getTools`
- **THEN** TypeScript reports a compile error

#### Scenario: Optional methods have defaults
- **WHEN** a class extends `AgentRuntime` without overriding `getCapabilities`
- **THEN** the default returns `[]`

#### Scenario: getSubagentModes is overridable
- **WHEN** a class extends `AgentRuntime` and overrides `getSubagentModes()`
- **THEN** the override is called during capability resolution and returned modes are registered as subagent spawn modes consumable by `call_subagent`/`start_subagent`

#### Scenario: getModes is overridable
- **WHEN** a class extends `AgentRuntime` and overrides `getModes()`
- **THEN** the override is called during initialization and returned modes are registered as current-session modes

#### Scenario: getModes default is empty
- **WHEN** a class extends `AgentRuntime` without overriding `getModes()`
- **THEN** the default returns `[]` and no mode machinery is exposed

### Requirement: Internal helpers stay inside AgentRuntime

The following internal helpers SHALL live entirely inside `AgentRuntime` and SHALL NOT be delegated to a host: `buildScheduleManager`, `createSchedule`/`updateSchedule`/`deleteSchedule`/`listSchedules`, `refreshAlarm`, `handleAgentEvent`, `handleCostEvent`, `transformContext`, `resolveToolsForSession`, `createSessionBroadcast`, `broadcastCustomToAll`, `createCapabilityBroadcastState`, `fireOnConnectHooks`, `disposeCapabilities`, `handleA2ARequest`, `handleMcpCallback`, `syncCapabilitySchedules`, `matchHttpHandler`, `ensureAgent`, `getCachedCapabilities`, `readActiveModeFromMetadata`. These are not override points.

#### Scenario: Delegation list is exactly the override surface
- **WHEN** the `AgentDelegate` interface is inspected
- **THEN** it contains exactly: 2 abstract methods (`getConfig`, `getTools`), 8 optional overrides (`buildSystemPrompt`, `getPromptOptions`, `getCapabilities`, `getSubagentModes`, `getModes`, `getConfigNamespaces`, `getA2AClientOptions`, `getCommands`), and 5 hooks (`validateAuth`, `onTurnEnd`, `onAgentEnd`, `onSessionCreated`, `onScheduleFire`) — nothing else. The previous `getSubagentProfiles` entry is replaced by `getSubagentModes`.

## ADDED Requirements

### Requirement: ensureAgent integrates mode filtering via O(1) cached lookup

`AgentRuntime.ensureAgent(sessionId)` SHALL resolve the active mode for the session by reading the `activeModeId` field from the session metadata row and looking up the corresponding `Mode` from `getModes()`. This path SHALL NOT walk the session entry log. After capability resolution and before tool/prompt assembly, `ensureAgent` SHALL call `applyMode(resolved, capabilities, allTools, activeMode, context)` and use the returned filtered tools and prompt sections for the LLM agent instance. When `activeModeId` is `null` or missing, `applyMode` SHALL be called with `null` and behave as a pass-through.

The walk-form `resolveActiveMode(sessionId, modes)` helper SHALL NOT be called from `ensureAgent` on every turn. It is reserved for branch initialization and consistency recovery.

#### Scenario: ensureAgent with no active mode is unchanged
- **WHEN** a session has no `mode_change` entries and `ensureAgent(sessionId)` is called
- **THEN** the Agent instance is created with the unfiltered tool set and prompt sections, matching pre-change behavior

#### Scenario: ensureAgent with active mode filters tools
- **WHEN** a session has an active mode whose `tools.deny` contains `file_write` and `ensureAgent(sessionId)` is called
- **THEN** the Agent instance is created without `file_write` in its tool list

#### Scenario: ensureAgent with active mode filters prompt sections
- **WHEN** a session has an active mode whose `capabilities.deny` contains `vibe-coder` and `ensureAgent(sessionId)` is called
- **THEN** the Agent instance's system prompt does not contain the vibe-coder capability's prompt section content

### Requirement: Section builder accepts explicit active mode

All internal functions that build the list of `PromptSection[]` for inspection or inference — including `assembleAllSections`, the inspection path used by `getSystemPromptSections`, and any helper used by `ensureAgent` — SHALL accept `activeMode: Mode | null` as an **explicit parameter**. These functions SHALL NOT look up the active mode by sessionId internally. The inspection path SHALL pass `null` by default and SHALL accept an optional mode override (e.g., via query parameter) so operators can preview any mode without a live session.

#### Scenario: Inspection path passes null by default
- **WHEN** the rich-prompt-inspection endpoint is called without a mode override
- **THEN** the section builder is called with `activeMode: null` and returns the unfiltered section list

#### Scenario: Inspection path previews a mode
- **WHEN** the rich-prompt-inspection endpoint is called with a mode ID override
- **THEN** the section builder is called with the corresponding `Mode` and returns the filtered section list with excluded entries marked `included: false` and `excludedReason` containing the mode ID

#### Scenario: Inference path passes resolved active mode
- **WHEN** `ensureAgent(sessionId)` is called for a session with an active mode
- **THEN** the section builder receives that resolved mode and the resulting prompt matches what the LLM sees

### Requirement: defineAgent exposes modes and subagentModes slots

`defineAgent` SHALL accept two mode-related slots in its definition:
- `modes?: (setup: AgentSetup<TEnv>) => Mode[]` — current-session modes
- `subagentModes?: (setup: AgentSetup<TEnv>) => Mode[]` — subagent spawn modes (replaces the previous `subagentProfiles?:` slot)

Both slots SHALL accept the same `Mode[]` type. A mode constant MAY be referenced from both slots.

#### Scenario: Agent definition with only modes
- **WHEN** `defineAgent({ model, modes: () => [planMode, researchMode], capabilities: ... })` is called
- **THEN** the returned DO class exposes `planMode` and `researchMode` as current-session modes

#### Scenario: Agent definition with only subagentModes
- **WHEN** `defineAgent({ model, subagentModes: () => [explorerMode], capabilities: ... })` is called
- **THEN** the returned DO class exposes `explorerMode` as a subagent spawn mode and the `call_subagent`/`start_subagent` tools can reference its ID

#### Scenario: Same mode in both slots
- **WHEN** a mode constant is referenced in both `modes` and `subagentModes`
- **THEN** no error is raised and the mode is available for both current-session activation and subagent spawning

### Requirement: AgentDO override surface for modes

`AgentDO<TEnv>` SHALL expose `getModes(): Mode[]` and `getSubagentModes(): Mode[]` as public override methods on the class (replacing `getSubagentProfiles()`). Both methods SHALL default to returning an empty array. `createDelegatingRuntime` SHALL forward both through `AgentDelegate`.

#### Scenario: Subclass overrides getModes
- **WHEN** a class extends `AgentDO` and overrides `getModes()` to return `[planMode]`
- **THEN** the runtime sees the returned modes via the delegating runtime

#### Scenario: Subclass overrides getSubagentModes
- **WHEN** a class extends `AgentDO` and overrides `getSubagentModes()` to return `[explorerMode]`
- **THEN** the runtime sees the returned subagent spawn modes via the delegating runtime

### Requirement: Session metadata carries activeModeId cache

The session metadata row SHALL include an optional `activeModeId: string | null` field. When a `mode_change` entry is appended to a session, the `activeModeId` metadata field SHALL be updated in the same transaction (`enter` → mode ID, `exit` → `null`). `ensureAgent` SHALL read `activeModeId` directly from session metadata and SHALL NOT walk the entry log for this lookup.

When a session is branched from a parent, the branch's `activeModeId` SHALL be initialized by calling the walk-form `resolveActiveMode` on the parent chain at branch creation time. After initialization, the branch manages its own `activeModeId` independently.

#### Scenario: Metadata cache is updated atomically with entry append
- **WHEN** `/mode plan` is executed on a session
- **THEN** the `mode_change` entry append and the `activeModeId` metadata update occur in the same transaction

#### Scenario: ensureAgent does not walk entries for active mode
- **WHEN** `ensureAgent(sessionId)` is called and the session metadata has `activeModeId: "plan"`
- **THEN** the resolution reads `activeModeId` from metadata directly and does not iterate session entries

#### Scenario: Branch initializes activeModeId from parent walk
- **WHEN** a new branch is created from a session whose parent chain's most recent `mode_change` entry is `{ enter: "plan" }`
- **THEN** the branch's `activeModeId` metadata field is initialized to `"plan"`

### Requirement: Session entry type includes mode_change

The `SessionEntryType` string union SHALL include `"mode_change"`. The corresponding `ModeChangeEntry` interface SHALL carry `data: { enter: string } | { exit: true }`. The `rowToEntry` row-to-entry conversion SHALL handle the new variant. `buildContext` SHALL continue to function unchanged — mode change entries SHALL NOT appear as LLM messages in the reconstructed context.

#### Scenario: mode_change entry is not part of LLM context
- **WHEN** `buildContext(sessionId)` is called on a session containing `mode_change` entries
- **THEN** the returned `AgentMessage[]` does not include the mode_change entries

#### Scenario: mode_change entry persists across branches
- **WHEN** a session branches after a `mode_change` entry and the branch continues
- **THEN** `resolveActiveMode(sessionId, modes)` on the branch correctly walks the parent chain and returns the mode set before the branch

### Requirement: Transport protocol includes mode_event

`ServerMessage` SHALL include a `mode_event` discriminated variant. The client message handler switch SHALL NOT add a default case — unknown message types SHALL continue to fall through silently so that future additions remain forward-compatible.

#### Scenario: Server emits mode_event on entry
- **WHEN** a session transitions to an active mode via slash command or tool
- **THEN** the server sends a `mode_event` message with `event.kind === "entered"` to all connected clients for that session

#### Scenario: session_sync carries active mode
- **WHEN** a client requests a session sync for a session with an active mode
- **THEN** the `session_sync` payload includes an `activeMode: { id, name }` field

#### Scenario: Unknown message type is ignored
- **WHEN** a client receives a message whose `type` is not in its known union
- **THEN** the switch statement in `message-handler.ts` does not hit a default case and the message is silently ignored

## RENAMED Requirements

- FROM: `### Requirement: AgentRuntime defines abstract and overridable methods` (the old scenario "getSubagentProfiles is overridable")
- TO: The scenario is replaced by "getSubagentModes is overridable" in the MODIFIED Requirements section above. The method name `getSubagentProfiles()` is renamed to `getSubagentModes()` throughout the runtime and delegation surface.
