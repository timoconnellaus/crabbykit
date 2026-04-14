## Why

Agents that expose many tools suffer measurable performance degradation: tool descriptions crowd the context window, selection accuracy drops as option count grows, and unrelated tools pollute reasoning on every turn. Prior art (Claude Code Plan Mode, Cursor modes, Roo Code custom modes, OpenCode agents) shows that scoping the agent's tool and prompt surface to a named "mode" — planning, vibe-dev, research — materially improves both focus and user control. CLAW currently has no way to do this at the main-session level; the closest primitive is `SubagentProfile`, which only applies when spawning a child agent. This change introduces a first-class `Mode` concept and unifies it with the subagent profile type so the SDK has one shared vocabulary for "a named view of the agent's capabilities."

## What Changes

- **NEW**: `Mode` type + `defineMode()` factory at new subpath `@claw-for-cloudflare/agent-runtime/modes`. Carries capability allow/deny, tool allow/deny, `promptAppend`, `systemPromptOverride`, `capabilityConfig` merge, and `model` (subagent-only).
- **NEW**: `planMode` reference export from the runtime — the one opinion-light built-in mode.
- **NEW**: `modes?:` slot on `defineAgent` for current-session modes. Gated: `/mode`, `enter_mode`, and `exit_mode` are only registered when the agent has `>= 2` modes.
- **NEW**: `getModes()` and `getSubagentModes()` override methods on `AgentDO` (subclass escape hatch).
- **NEW**: `mode_change` session entry variant (first-class, added to `SessionEntryType` union). Recorded on entry/exit, walked by `resolveActiveMode()` to determine the session's current mode.
- **NEW**: `mode_event` transport `ServerMessage` variant. Broadcast on mode transitions and included in `session_sync` so reconnecting clients see the active mode.
- **NEW**: `activeMode: { id: string; name: string } | null` state on the `AgentConnectionProvider` reducer, exposed via a new `useActiveMode()` selector hook (matching the decomposed client-hook pattern — `useAgentChat` no longer exists). Mode badge shown in `StatusBar`, which reads via `useActiveMode()`.
- **NEW**: `/mode <id>` slash command. `enter_mode(id)` / `exit_mode()` agent tools (Claude Code ExitPlanMode-style).
- **NEW**: `filterToolsAndSections()` pure low-level filter (tools + sections + mode → filtered tools + sections). Wrapped by a higher-level `applyMode()` helper for the main session that adds the resolved-capabilities plumbing. Both take `activeMode: Mode | null` as an **explicit parameter** (not looked up internally) so the inspection path can preview any mode without a live session. The subagent package calls the low-level `filterToolsAndSections` directly without constructing fake `ResolvedCapabilities`.
- **NEW**: Active mode is cached on session metadata (updated when appending a `mode_change` entry) so `ensureAgent` resolution is O(1). A `resolveActiveMode()` helper exists as a consistency fallback that walks session entries from leaf toward root.
- **BREAKING**: `SubagentProfile` type removed. Replaced by `Mode`. No deprecation alias. (Greenfield SDK — no deployed consumers.)
- **BREAKING**: `packages/subagent` renames: `resolveProfile()` → `applyMode()` (delegates to shared helper), `PendingSubagent.profileId` → `modeId`, `call_subagent` / `start_subagent` tool parameter `profile` → `mode`, broadcast event field `profileId` → `modeId`, `SubagentEventMeta.profileId` → `modeId`.
- **BREAKING**: `AgentDO.getSubagentProfiles()` → `getSubagentModes()`. `defineAgent.subagentProfiles?:` slot → `subagentModes?:` (returns `Mode[]`). Named for clarity — these are *modes used to spawn subagents*, not subagent instances.
- **BREAKING**: `packages/subagent-explorer` exports `explorerMode` (not `explorerProfile`). No alias.
- Mode filtering excludes capability prompt sections by flipping `included: false` with `excludedReason: "Filtered by mode: <id>"`, leveraging the `PromptSection` structure from the rich-prompt-inspection work. The inspection UI automatically surfaces why a section is absent.
- Mode filtering applies to **tools and prompt sections only**. Capability lifecycle hooks (`onConnect`, `afterToolExecution`, `httpHandlers`, `schedules`) are intentionally untouched — modes are a session-level concept, not a capability lifecycle concern.

## Capabilities

### New Capabilities
- `agent-modes`: Core mode concept — `Mode` type, `defineMode` factory, `applyMode` filter, `resolveActiveMode` session-walker, `mode_change` session entry, `mode_event` transport message, `/mode` slash command, `enter_mode` / `exit_mode` tools, conditional registration (`>= 2` modes), `planMode` built-in, client `activeMode` state.

### Modified Capabilities
- `agent-runtime-core`: `defineAgent` gains `modes?:` slot and renames `subagentProfiles?:` → `subagentModes?:`. `AgentDO` gains `getModes()` and renames `getSubagentProfiles()` → `getSubagentModes()`. `ensureAgent()` integrates `applyMode` after capability resolution. `assembleAllSections` / section-building takes `activeMode` as an explicit parameter to keep inspection and inference aligned. Session entry type union adds `"mode_change"`. Session metadata gains an optional `activeModeId` cache field so active-mode lookup is O(1).
- `subagent`: `SubagentProfile` removed; types re-export `Mode` from `agent-modes`. `resolveProfile()` → `applyMode()` delegating to shared helper. Tool parameters and broadcast fields rename `profile`/`profileId` → `mode`/`modeId`. `PendingSubagent` storage field rename.
- `subagent-explorer`: `explorerProfile` export renamed to `explorerMode`. Profile shape migrates to `Mode` type. Uses `systemPromptOverride` instead of `systemPrompt` field.

## Impact

- **Affected packages**: `packages/agent-runtime` (core runtime + new `modes/` subpath export + connection-provider reducer + new `useActiveMode` hook + transport types + session entry types), `packages/subagent` (type rename + tool param rename + storage field rename + delegation to shared filter), `packages/subagent-explorer` (factory return type migration — the export is the factory `explorer(options?)`, NOT a constant named `explorerProfile`), `packages/agent-ui` (mode badge in `StatusBar` via `useActiveMode()`).

- **NOT modified in v1**: bundle-brain dispatch path. See design Non-Goals — bundle turns bypass `ensureAgent` and therefore bypass `applyMode`. Static-brain fallback remains authoritative.
- **Affected examples**: `examples/basic-agent` — update any references to `SubagentProfile` / `profile` tool parameter.
- **Public API surface**: new subpath `@claw-for-cloudflare/agent-runtime/modes` added to `package.json` exports.
- **Wire format**: new `ServerMessage.type: "mode_event"` variant. Older clients silently ignore unknown variants (no default case in switch, forward-compat safe). `session_sync` payload gains optional `activeMode` field.
- **Coverage**: all new `modes/` source files held to the 98/90/100/99 thresholds. `apply-mode.ts`, `exclude-sections.ts`, `define-mode.ts`, `resolve-active-mode.ts`, `commands.ts`, and `tools.ts` fully unit-tested; `index.ts` barrels excluded.
- **Dependencies**: none added. Builds on existing `PromptSection` machinery from the just-merged rich-prompt-inspection work.
- **Downstream consumers**: `gia-cloud` will adopt the new API directly (SDK has not yet been applied back). `basic-agent` is the in-repo consumer and is updated in the same change.
