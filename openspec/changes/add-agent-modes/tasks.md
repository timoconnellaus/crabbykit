## 0. Task dependency map (read before starting)

Dependency order across groups:
- **Group 1** (core primitives) has no dependencies
- **Group 2** (unit tests) depends on Group 1
- **Group 3** (session entry + metadata cache) depends on Group 1
- **Group 4** (transport) depends on Group 3 (so mode_event appends can broadcast with cache-updated state)
- **Group 5** (ensureAgent integration) depends on Groups 1, 3
- **Group 6** (slash command + tools) depends on Groups 1, 3, 4
- **Group 7** (defineAgent + AgentDO) depends on Group 1
- **Group 8** (subagent unification) depends on Group 1 (specifically `filterToolsAndSections`)
- **Group 9** (subagent-explorer) depends on Group 8
- **Group 10** (main barrel cleanup) depends on Groups 7, 8
- **Group 11** (client + UI) depends on Groups 4, 6
- **Group 12** (examples) depends on Groups 7, 8, 9
- **Group 13** (docs) can happen in parallel once Groups 1–11 are stable
- **Group 14** (quality gates) is last
- **Group 15** (final validation) is last

## 1. Core mode primitives (new subpath)

- [x] 1.1 Create `packages/agent-runtime/src/modes/` directory
- [x] 1.2 Write `modes/define-mode.ts` — `Mode` interface and `defineMode()` factory. The factory SHALL throw a validation error when `capabilities` or `tools` has both `allow` and `deny` set on the same filter (see `agent-modes` spec "defineMode rejects conflicting allow and deny")
- [x] 1.3 Write `modes/exclude-sections.ts` — internal `excludePromptSectionsForMode(sections, deadCapIds, modeId)` helper. Module-private; NOT exported from the `modes/index.ts` barrel
- [x] 1.4 Write `modes/filter-tools-and-sections.ts` — low-level pure `filterToolsAndSections(tools, sections, activeMode)` function. Applies tool allow/deny and flips capability-sourced sections to `included: false`. Null-mode pass-through. Used directly by `packages/subagent`
- [x] 1.5 Write `modes/apply-mode.ts` — higher-level `applyMode(resolved, capabilities, allTools, activeMode, context)` wrapper. Computes dead-cap IDs, removes dead-cap tools, delegates to `filterToolsAndSections` for the remaining tool/section filter, resolves `promptAppend` and `systemPromptOverride` function forms. Null-mode pass-through. Used only by `ensureAgent`
- [x] 1.6 Write `modes/resolve-active-mode.ts` — walk-form `resolveActiveMode(sessionId, modes)` walking session entries from leaf toward root; returns `Mode | null`. Called only at branch init and consistency fallback — NOT from `ensureAgent`
- [x] 1.7 Write `modes/built-in/plan.ts` — `planMode` constant with conservative tool deny list (file_write/file_edit/file_delete/file_move/file_copy/exec/process/show_preview/hide_preview/browser_click/browser_type/browser_navigate) and planning `promptAppend`. JSDoc MUST clearly warn that the deny list only covers CLAW ecosystem tool names and show the composition pattern for extending it
- [x] 1.8 Write `modes/built-in/index.ts` — barrel re-exporting `planMode`
- [x] 1.9 Write `modes/index.ts` — subpath barrel exporting `defineMode`, `type Mode`, `type AppliedMode`, `filterToolsAndSections`, `applyMode`, `resolveActiveMode`, and built-ins. MUST NOT export `excludePromptSectionsForMode` (implementation detail)
- [x] 1.10 Update `packages/agent-runtime/package.json` `exports` field to include `"./modes": "./src/modes/index.ts"`
- [x] 1.11 Verify modes subpath import from a scratch consumer: `import { defineMode, planMode } from "@crabbykit/agent-runtime/modes"`

## 2. Core mode unit tests

- [x] 2.1 `modes/__tests__/define-mode.test.ts` — identity factory returns input unchanged; throws when `tools` has both allow and deny; throws when `capabilities` has both allow and deny; error message identifies the invalid filter; allow-only and deny-only pass; different filters may each use allow or deny independently
- [x] 2.2 `modes/__tests__/filter-tools-and-sections.test.ts` — null mode pass-through; tool allow filter; tool deny filter; capability-sourced section exclusion with correct `excludedReason`; non-capability sections untouched
- [x] 2.3 `modes/__tests__/apply-mode.test.ts` — null mode pass-through; dead-cap tool removal (capability filter); delegation to `filterToolsAndSections` for remaining tool/section filter; `promptAppend` function form receives context; `systemPromptOverride` function form receives base and context; combined capability + tool filters
- [x] 2.4 `modes/__tests__/exclude-sections.test.ts` — (internal module test via direct import) capability-sourced section excluded by cap ID; non-capability sections untouched; already-excluded sections preserved
- [x] 2.5 `modes/__tests__/resolve-active-mode.test.ts` — no entries returns null; single enter entry returns mode; enter-then-exit returns null; unknown mode ID returns null; walks parent chain across branches
- [x] 2.6 `modes/__tests__/plan-mode.test.ts` — planMode deny list contains expected ecosystem tool names; no capability-package imports; JSDoc warning present

## 3. Session entry variant + activeModeId metadata cache

- [x] 3.1 Add `"mode_change"` to `SessionEntryType` union in `packages/agent-runtime/src/session/types.ts`. REQUIRED: add a JSDoc line on the new variant AND on the existing `"model_change"` variant explicitly cross-referencing the other — the names differ by one letter and a typo at a dispatch site must be obvious in review
- [x] 3.2 Define `ModeChangeEntry` interface with `data: { enter: string } | { exit: string }` — exit carries the mode ID being exited, NOT a boolean sentinel
- [x] 3.3 Update `rowToEntry` in `packages/agent-runtime/src/session/session-store.ts` to handle the new variant
- [x] 3.4 Confirm `buildContext()` skips `mode_change` entries. Already satisfied because `session-store.ts` filters to `entry.type === "message"` at line ~287; this task is a one-line assertion test, not new filter code
- [x] 3.5 Add optional `activeModeId: string | null` field to the session metadata row type (and SQL schema migration if needed)
- [x] 3.6 Implement a `setActiveMode(sessionId, modeId | null)` helper on `SessionStore` that updates the metadata field
- [x] 3.7 Wire atomic updates: when appending a `mode_change` enter entry, update `activeModeId` to the entered ID in the same transaction; when appending an exit entry, set `activeModeId` to `null` in the same transaction
- [x] 3.8 Implement `readActiveModeId(sessionId): string | null` that reads the cache field directly (O(1), no entry walk)
- [x] 3.9 Wire branch initialization: when a branch is created, initialize its `activeModeId` by walking the parent chain via `resolveActiveMode`
- [x] 3.10 Test: append a `mode_change` entry, call `buildContext`, assert it is absent from the returned `AgentMessage[]`
- [x] 3.11 Test: append a `mode_change` enter entry and read `activeModeId` from metadata — it matches
- [x] 3.12 Test: append a `mode_change` exit entry — `activeModeId` reads back as `null`
- [x] 3.13 Test: branched session — branch's `activeModeId` is initialized from parent chain's most recent `mode_change`
- [x] 3.14 Test: entry append and metadata update happen atomically (assert no intermediate state where entry exists but metadata lags)

## 4. Transport protocol

- [x] 4.1 Add `mode_event` ServerMessage variant to `packages/agent-runtime/src/transport/types.ts` (currently ~line 148, end of ServerMessage union) with `event: { kind: "entered"; modeId: string; modeName: string } | { kind: "exited"; modeId: string; modeName: string }` — BOTH kinds carry `modeId` and `modeName`, NOT a `previousModeId` on exit. Design D10 uses this same shape
- [x] 4.2 Add optional `activeMode?: { id: string; name: string }` field to the `session_sync` payload type
- [x] 4.3 Update the server-side `session_sync` assembly path in `agent-runtime.ts` to populate `activeMode` by reading the `activeModeId` cache from session metadata (NOT by walking entries) and looking up the corresponding Mode
- [x] 4.4 Verify the client `message-handler.ts` switch has no default case so unknown variants continue to fall through silently
- [x] 4.5 Test: assert that emitting a `mode_event` reaches connected clients via the existing transport test harness
- [x] 4.6 Test: assert that `session_sync` carries `activeMode` when a mode is active

## 5. ensureAgent integration

- [x] 5.1 Import `applyMode` in `packages/agent-runtime/src/agent-runtime.ts`. Target function: `ensureAgent(sessionId)` at approximately line 1776. Note: the bundle dispatch path at `agent-runtime.ts:1570` runs BEFORE `ensureAgent` and short-circuits the turn when a bundle handles it — mode filtering therefore does NOT apply to bundle-brain turns in v1. This is an explicit non-goal (see design Non-Goals)
- [x] 5.2 In `ensureAgent(sessionId)`, after `resolveCapabilities` and tool assembly, resolve the active mode by reading `activeModeId` from session metadata (via `readActiveModeId`) and looking it up in `getModes()`. MUST NOT walk the session entry log on this path
- [x] 5.3 Call `const applied = applyMode(resolved, capabilities, allTools, activeMode, context)`
- [x] 5.4 Replace `allTools` with `applied.tools`, `resolved.promptSections` with `applied.promptSections` (for the subsequent prompt-builder call)
- [x] 5.5 Apply `applied.systemPromptOverride?.(base)` and append `applied.promptAppend` when building `systemPrompt`
- [x] 5.6 Refactor any internal section-builder that `ensureAgent` calls to accept `activeMode: Mode | null` as an explicit parameter — NOT to look up the mode internally
- [x] 5.7 Update the rich-prompt-inspection path (`getSystemPromptSections`) to accept an optional mode override and pass it through to the same section builder; default is `null`
- [x] 5.8 Integration test: session with no mode_change entries produces unchanged tool set and prompt
- [x] 5.9 Integration test: session with an active mode produces filtered tool set matching the mode's filter
- [x] 5.10 Integration test: inspection endpoint with `?mode=plan` produces the same filtered prompt as the inference path for that mode
- [x] 5.11 Integration test: the new active-mode resolution step in `ensureAgent` reads the `activeModeId` cache from session metadata and does NOT walk the session entry log. (Note: `ensureAgent` still calls `buildContext` to assemble LLM messages — the assertion is specifically about the mode-resolution step, not `buildContext`)

## 6. Slash command and agent tools (conditional registration)

- [x] 6.1 Write `modes/commands.ts` — `createModeCommand(modes, sessionStore)` returning a `Command` for `/mode [id]`; no-arg exits; with-arg enters; unknown ID returns error with available IDs
- [x] 6.2 Write `modes/tools.ts` — `createEnterModeTool(modes, sessionStore)` and `createExitModeTool(sessionStore)` returning `AgentTool` instances that append the session entry and broadcast
- [x] 6.3 Wire conditional registration in `resolveCommands()` (`agent-runtime.ts`): only add `/mode` when `getModes().length >= 2`
- [x] 6.4 Wire conditional registration in `collectAllTools()`: only add `enter_mode` and `exit_mode` when `getModes().length >= 2`
- [x] 6.5 Wire conditional "Current mode" indicator in the base prompt sections: only add when `modesActive` AND a mode is active
- [x] 6.6 Test: agent with zero modes — command list has no `/mode`, tool list has no `enter_mode`/`exit_mode`
- [x] 6.7 Test: agent with one mode — same as zero modes (dormant)
- [x] 6.8 Test: agent with two modes — `/mode` command present, `enter_mode`/`exit_mode` tools present
- [x] 6.9 Test: `/mode plan` appends the correct entry and emits a `mode_event`
- [x] 6.10 Test: `enter_mode({ id: "plan" })` and `exit_mode()` tools behave identically to the slash command
- [x] 6.11 Test: `/mode nonexistent` returns an error listing available modes and appends no entry

## 7. defineAgent + AgentDO override surface

- [x] 7.1 Add `modes?: (setup: AgentSetup<TEnv>) => Mode[]` slot to `AgentDefinition` in `packages/agent-runtime/src/define-agent.ts`
- [x] 7.2 Rename `subagentProfiles?:` slot to `subagentModes?:` and change its return type to `Mode[]`
- [x] 7.3 Add `getModes(): Mode[]` public override method on `AgentDO` with default `[]`
- [x] 7.4 Rename `getSubagentProfiles()` → `getSubagentModes()` on `AgentDO`
- [x] 7.5 Add `getModes` and `getSubagentModes` to the `AgentDelegate` interface used by `createDelegatingRuntime`
- [x] 7.6 Update `defineAgent` factory body to forward the new slots into the delegating runtime
- [x] 7.7 Update the agent-runtime-core spec's list of default override methods in the internal `AgentDelegate` shape
- [x] 7.8 Type-level test: consumer passing `modes: () => [planMode]` typechecks
- [x] 7.9 Type-level test: consumer passing `subagentModes: () => [explorerMode]` typechecks

## 8. Subagent package unification

- [x] 8.1 Delete `SubagentProfile` from `packages/subagent/src/types.ts`; re-export `Mode` from `@crabbykit/agent-runtime/modes`
- [x] 8.2 Replace `ResolvedProfile` shape as needed to hold the resolved subset (systemPrompt, tools, modelId)
- [x] 8.3 Rewrite `packages/subagent/src/resolve.ts` to import `filterToolsAndSections` from `@crabbykit/agent-runtime/modes` and delegate tool filtering to it. Keep the file-level function name descriptive of its role (e.g., `resolveSubagentSpawn` or similar) — it is NOT renamed to `applyMode` because `applyMode` is the main-session-specific wrapper. Do NOT construct a fake `ResolvedCapabilities` object
- [x] 8.4 Update `call_subagent` and `start_subagent` tools in `packages/subagent/src/tools.ts` to use parameter name `mode` (not `profile`); update tool description and JSON schema
- [x] 8.5 Rename `PendingSubagent.profileId` → `modeId` in `packages/subagent/src/types.ts` and every call site
- [x] 8.6 Rename `SubagentEventMeta.profileId` → `modeId` in `packages/subagent/src/event-forwarder.ts` and every call site
- [x] 8.7 Update `subagent_status` broadcast payloads in `capability.ts` / `tools.ts` to carry `modeId` (not `profileId`)
- [x] 8.8 Update tool output strings (e.g., `[Subagent "${modeId}" completed]`) to reference the new field
- [x] 8.9 Migrate all 5 test files in `packages/subagent/src/__tests__/` from `SubagentProfile`/`profileId` to `Mode`/`modeId`: `capability.test.ts`, `resolve.test.ts`, `tools.test.ts`, `pending-store.test.ts`, `event-forwarder.test.ts`
- [x] 8.10 Run `bun test` in `packages/subagent` and fix any regressions

## 9. subagent-explorer package

NOTE: earlier spec drafts referenced a nonexistent constant `explorerProfile`. The actual export at `packages/subagent-explorer/src/explorer.ts:55` is the factory function `explorer(options?: ExplorerOptions): SubagentProfile`. Tasks below target the factory, not a constant.

- [x] 9.1 Update `packages/subagent-explorer/src/explorer.ts`: change `explorer(options?)` return type from `SubagentProfile` to `Mode` (imported from `@crabbykit/agent-runtime/modes`). Factory name stays the same
- [x] 9.2 Migrate factory body: `tools: options?.tools` (string[]) → `tools: options?.tools ? { allow: options.tools } : undefined`. Update `ExplorerOptions.tools` JSDoc to describe the allow-list semantics
- [x] 9.3 Migrate `systemPrompt: EXPLORER_SYSTEM_PROMPT` (function of `parentPrompt`) → `systemPromptOverride: (base, context) => EXPLORER_SYSTEM_PROMPT(base)`. The base parameter replaces the old `parentPrompt`
- [x] 9.4 Retain `isReadOnlyTool` and `filterReadOnlyTools` exports — do NOT drop them
- [x] 9.5 Update `packages/subagent-explorer/src/index.ts` barrel — no export name changes needed (`explorer`, `filterReadOnlyTools`, `isReadOnlyTool`, `type ExplorerOptions`). Remove any reference to `SubagentProfile` as the return type in JSDoc examples
- [x] 9.6 Migrate tests in `packages/subagent-explorer` to assert the new return shape (`tools.allow` array, `systemPromptOverride` present, `model` preserved)

## 10. agent-runtime main barrel + re-exports

- [x] 10.1 Remove `SubagentProfile` from `packages/agent-runtime/src/index.ts` main barrel
- [x] 10.2 Confirm `Mode`-related primitives are NOT re-exported from the main barrel (they live only at `/modes`)
- [x] 10.3 Update any internal imports within `agent-runtime` that referenced `SubagentProfile` to reference `Mode`

## 11. Client and UI updates

NOTE: `useAgentChat()` no longer exists. The client has been decomposed into `AgentConnectionProvider` + `useAgentConnection` + `useChatSession` + capability-specific hooks (`useTelegramChannel`, etc.). Mode state follows the same decomposed pattern — a new selector hook `useActiveMode()` reading from the connection provider's reducer state. Do NOT resurrect `useAgentChat`.

- [x] 11.1 Add `activeMode: { id: string; name: string } | null` to the connection provider's reducer state in `packages/agent-runtime/src/client/` (same module that backs `useAgentConnection` / `AgentConnectionProvider`)
- [x] 11.2 Update the connection-provider reducer to handle `mode_event` messages: kind=entered sets `activeMode`, kind=exited clears it. Reuse the existing dispatch infrastructure used by `capability_state` messages
- [x] 11.3 Initialize `activeMode` from the `session_sync.activeMode` payload on connection establishment AND on session switch
- [x] 11.4 Add `useActiveMode()` selector hook in the same client module, reading `activeMode` off `useAgentConnection().state`. Export from the runtime client entry point alongside the other decomposed hooks
- [x] 11.5 Update `packages/agent-ui/src/components/status-bar.tsx` to import `useActiveMode` and render a mode badge when `activeMode !== null`. Badge sits alongside the existing `SandboxBadge` / `BrowserBadge`
- [x] 11.6 Test: reducer updates `activeMode` on `mode_event` kind=entered
- [x] 11.7 Test: reducer clears `activeMode` on `mode_event` kind=exited
- [x] 11.8 Test: `session_sync` payload with `activeMode` initializes the state
- [x] 11.9 Test: session switch clears + reinitializes `activeMode` from the new session's `session_sync`
- [x] 11.10 Test: `StatusBar` renders the mode badge when `activeMode` is set, omits it when null

## 12. Examples and downstream

- [x] 12.1 Update `examples/basic-agent` to drop any reference to `SubagentProfile` / `profile` tool parameter
- [x] 12.2 Add a demonstration `modes: () => [planMode, researchMode]` slot in `examples/basic-agent` where `researchMode` is a simple consumer-defined mode. Two modes are required to trigger conditional registration of `/mode`, `enter_mode`, `exit_mode`. If two modes feels contrived for the example, add a code comment explicitly noting the 2+ threshold
- [x] 12.3 Verify `cd examples/basic-agent && bun dev` runs clean after the rename, and verify `/mode` appears in the slash-command autocomplete

## 13. Documentation

- [x] 13.1 Update `CLAUDE.md`: add a "Modes are the scoping mechanism" architecture-rule subsection; document `Mode`/`defineMode`/`planMode`; document conditional registration rule; note the subpath export; note the SubagentProfile → Mode rename
- [x] 13.2 Update `README.md`: add a Modes section to the feature list; update the `defineAgent` example to show the `modes` slot
- [x] 13.3 Update `packages/subagent/README.md` (if present) to reference the new `mode` parameter and `Mode` type
- [x] 13.4 Update `packages/subagent-explorer/README.md` (if present) to reference `explorerMode`

## 14. Coverage and quality gates

- [x] 14.1 Run `bun run typecheck` at the repo root — zero errors
- [x] 14.2 Run `bun run lint` — zero Biome warnings
- [x] 14.3 Run `bun run test` across all workspaces — all green
- [x] 14.4 Run `cd packages/agent-runtime && bun test:coverage` — meets 98%/90%/100%/99% thresholds with `modes/` included (only `modes/index.ts` + `modes/built-in/index.ts` barrels excluded)
- [x] 14.5 Verify no `any` types introduced in production code; tests exempt per biome.json overrides

## 15. Final validation

- [x] 15.1 `openspec validate add-agent-modes --strict` — zero validation errors
- [x] 15.2 Manual smoke test: run `bun dev` in `examples/basic-agent`, register two modes, invoke `/mode plan`, verify the `StatusBar` shows the mode badge, send a prompt, confirm the LLM sees the filtered tools and the `promptAppend` content
- [x] 15.3 Manual smoke test: invoke `/mode` with no argument, verify exit, verify the badge clears
- [x] 15.4 Manual smoke test: call a subagent referencing `explorerMode` via `call_subagent({ mode: "explorer", prompt: "..." })` and verify the child runs with the filtered tool set
- [x] 15.5 Manual smoke test: open the rich-prompt-inspection panel with and without a mode active, confirm excluded sections are displayed with `Filtered by mode: <id>` as the reason
