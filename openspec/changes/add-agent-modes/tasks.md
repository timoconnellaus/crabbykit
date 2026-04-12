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

- [ ] 1.1 Create `packages/agent-runtime/src/modes/` directory
- [ ] 1.2 Write `modes/define-mode.ts` — `Mode` interface and `defineMode()` factory. The factory SHALL throw a validation error when `capabilities` or `tools` has both `allow` and `deny` set on the same filter (see `agent-modes` spec "defineMode rejects conflicting allow and deny")
- [ ] 1.3 Write `modes/exclude-sections.ts` — internal `excludePromptSectionsForMode(sections, deadCapIds, modeId)` helper. Module-private; NOT exported from the `modes/index.ts` barrel
- [ ] 1.4 Write `modes/filter-tools-and-sections.ts` — low-level pure `filterToolsAndSections(tools, sections, activeMode)` function. Applies tool allow/deny and flips capability-sourced sections to `included: false`. Null-mode pass-through. Used directly by `packages/subagent`
- [ ] 1.5 Write `modes/apply-mode.ts` — higher-level `applyMode(resolved, capabilities, allTools, activeMode, context)` wrapper. Computes dead-cap IDs, removes dead-cap tools, delegates to `filterToolsAndSections` for the remaining tool/section filter, resolves `promptAppend` and `systemPromptOverride` function forms. Null-mode pass-through. Used only by `ensureAgent`
- [ ] 1.6 Write `modes/resolve-active-mode.ts` — walk-form `resolveActiveMode(sessionId, modes)` walking session entries from leaf toward root; returns `Mode | null`. Called only at branch init and consistency fallback — NOT from `ensureAgent`
- [ ] 1.7 Write `modes/built-in/plan.ts` — `planMode` constant with conservative tool deny list (file_write/file_edit/file_delete/file_move/file_copy/exec/process/show_preview/hide_preview/browser_click/browser_type/browser_navigate) and planning `promptAppend`. JSDoc MUST clearly warn that the deny list only covers CLAW ecosystem tool names and show the composition pattern for extending it
- [ ] 1.8 Write `modes/built-in/index.ts` — barrel re-exporting `planMode`
- [ ] 1.9 Write `modes/index.ts` — subpath barrel exporting `defineMode`, `type Mode`, `type AppliedMode`, `filterToolsAndSections`, `applyMode`, `resolveActiveMode`, and built-ins. MUST NOT export `excludePromptSectionsForMode` (implementation detail)
- [ ] 1.10 Update `packages/agent-runtime/package.json` `exports` field to include `"./modes": "./src/modes/index.ts"`
- [ ] 1.11 Verify modes subpath import from a scratch consumer: `import { defineMode, planMode } from "@claw-for-cloudflare/agent-runtime/modes"`

## 2. Core mode unit tests

- [ ] 2.1 `modes/__tests__/define-mode.test.ts` — identity factory returns input unchanged; throws when `tools` has both allow and deny; throws when `capabilities` has both allow and deny; error message identifies the invalid filter; allow-only and deny-only pass; different filters may each use allow or deny independently
- [ ] 2.2 `modes/__tests__/filter-tools-and-sections.test.ts` — null mode pass-through; tool allow filter; tool deny filter; capability-sourced section exclusion with correct `excludedReason`; non-capability sections untouched
- [ ] 2.3 `modes/__tests__/apply-mode.test.ts` — null mode pass-through; dead-cap tool removal (capability filter); delegation to `filterToolsAndSections` for remaining tool/section filter; `promptAppend` function form receives context; `systemPromptOverride` function form receives base and context; combined capability + tool filters
- [ ] 2.4 `modes/__tests__/exclude-sections.test.ts` — (internal module test via direct import) capability-sourced section excluded by cap ID; non-capability sections untouched; already-excluded sections preserved
- [ ] 2.5 `modes/__tests__/resolve-active-mode.test.ts` — no entries returns null; single enter entry returns mode; enter-then-exit returns null; unknown mode ID returns null; walks parent chain across branches
- [ ] 2.6 `modes/__tests__/plan-mode.test.ts` — planMode deny list contains expected ecosystem tool names; no capability-package imports; JSDoc warning present

## 3. Session entry variant + activeModeId metadata cache

- [ ] 3.1 Add `"mode_change"` to `SessionEntryType` union in `packages/agent-runtime/src/session/types.ts`
- [ ] 3.2 Define `ModeChangeEntry` interface with `data: { enter: string } | { exit: string }` — exit carries the mode ID being exited, NOT a boolean sentinel
- [ ] 3.3 Update `rowToEntry` in `packages/agent-runtime/src/session/session-store.ts` to handle the new variant
- [ ] 3.4 Confirm `buildContext()` skips `mode_change` entries (they must NOT appear as LLM messages)
- [ ] 3.5 Add optional `activeModeId: string | null` field to the session metadata row type (and SQL schema migration if needed)
- [ ] 3.6 Implement a `setActiveMode(sessionId, modeId | null)` helper on `SessionStore` that updates the metadata field
- [ ] 3.7 Wire atomic updates: when appending a `mode_change` enter entry, update `activeModeId` to the entered ID in the same transaction; when appending an exit entry, set `activeModeId` to `null` in the same transaction
- [ ] 3.8 Implement `readActiveModeId(sessionId): string | null` that reads the cache field directly (O(1), no entry walk)
- [ ] 3.9 Wire branch initialization: when a branch is created, initialize its `activeModeId` by walking the parent chain via `resolveActiveMode`
- [ ] 3.10 Test: append a `mode_change` entry, call `buildContext`, assert it is absent from the returned `AgentMessage[]`
- [ ] 3.11 Test: append a `mode_change` enter entry and read `activeModeId` from metadata — it matches
- [ ] 3.12 Test: append a `mode_change` exit entry — `activeModeId` reads back as `null`
- [ ] 3.13 Test: branched session — branch's `activeModeId` is initialized from parent chain's most recent `mode_change`
- [ ] 3.14 Test: entry append and metadata update happen atomically (assert no intermediate state where entry exists but metadata lags)

## 4. Transport protocol

- [ ] 4.1 Add `mode_event` ServerMessage variant to `packages/agent-runtime/src/transport/types.ts` with `event: { kind: "entered"; modeId; modeName } | { kind: "exited"; modeId; modeName }` — BOTH kinds carry modeId and modeName, not a `previousModeId` on exit
- [ ] 4.2 Add optional `activeMode?: { id: string; name: string }` field to the `session_sync` payload type
- [ ] 4.3 Update the server-side `session_sync` assembly path in `agent-runtime.ts` to populate `activeMode` by reading the `activeModeId` cache from session metadata (NOT by walking entries) and looking up the corresponding Mode
- [ ] 4.4 Verify the client `message-handler.ts` switch has no default case so unknown variants continue to fall through silently
- [ ] 4.5 Test: assert that emitting a `mode_event` reaches connected clients via the existing transport test harness
- [ ] 4.6 Test: assert that `session_sync` carries `activeMode` when a mode is active

## 5. ensureAgent integration

- [ ] 5.1 Import `applyMode` in `packages/agent-runtime/src/agent-runtime.ts`
- [ ] 5.2 In `ensureAgent(sessionId)`, after `resolveCapabilities` and tool assembly, resolve the active mode by reading `activeModeId` from session metadata (via `readActiveModeId`) and looking it up in `getModes()`. MUST NOT walk the session entry log on this path
- [ ] 5.3 Call `const applied = applyMode(resolved, capabilities, allTools, activeMode, context)`
- [ ] 5.4 Replace `allTools` with `applied.tools`, `resolved.promptSections` with `applied.promptSections` (for the subsequent prompt-builder call)
- [ ] 5.5 Apply `applied.systemPromptOverride?.(base)` and append `applied.promptAppend` when building `systemPrompt`
- [ ] 5.6 Refactor any internal section-builder that `ensureAgent` calls to accept `activeMode: Mode | null` as an explicit parameter — NOT to look up the mode internally
- [ ] 5.7 Update the rich-prompt-inspection path (`getSystemPromptSections`) to accept an optional mode override and pass it through to the same section builder; default is `null`
- [ ] 5.8 Integration test: session with no mode_change entries produces unchanged tool set and prompt
- [ ] 5.9 Integration test: session with an active mode produces filtered tool set matching the mode's filter
- [ ] 5.10 Integration test: inspection endpoint with `?mode=plan` produces the same filtered prompt as the inference path for that mode
- [ ] 5.11 Integration test: `ensureAgent` does not scan the session entry log (assert via spy that `getEntries`/equivalent is not called on the active-mode-resolution path)

## 6. Slash command and agent tools (conditional registration)

- [ ] 6.1 Write `modes/commands.ts` — `createModeCommand(modes, sessionStore)` returning a `Command` for `/mode [id]`; no-arg exits; with-arg enters; unknown ID returns error with available IDs
- [ ] 6.2 Write `modes/tools.ts` — `createEnterModeTool(modes, sessionStore)` and `createExitModeTool(sessionStore)` returning `AgentTool` instances that append the session entry and broadcast
- [ ] 6.3 Wire conditional registration in `resolveCommands()` (`agent-runtime.ts`): only add `/mode` when `getModes().length >= 2`
- [ ] 6.4 Wire conditional registration in `collectAllTools()`: only add `enter_mode` and `exit_mode` when `getModes().length >= 2`
- [ ] 6.5 Wire conditional "Current mode" indicator in the base prompt sections: only add when `modesActive` AND a mode is active
- [ ] 6.6 Test: agent with zero modes — command list has no `/mode`, tool list has no `enter_mode`/`exit_mode`
- [ ] 6.7 Test: agent with one mode — same as zero modes (dormant)
- [ ] 6.8 Test: agent with two modes — `/mode` command present, `enter_mode`/`exit_mode` tools present
- [ ] 6.9 Test: `/mode plan` appends the correct entry and emits a `mode_event`
- [ ] 6.10 Test: `enter_mode({ id: "plan" })` and `exit_mode()` tools behave identically to the slash command
- [ ] 6.11 Test: `/mode nonexistent` returns an error listing available modes and appends no entry

## 7. defineAgent + AgentDO override surface

- [ ] 7.1 Add `modes?: (setup: AgentSetup<TEnv>) => Mode[]` slot to `AgentDefinition` in `packages/agent-runtime/src/define-agent.ts`
- [ ] 7.2 Rename `subagentProfiles?:` slot to `subagentModes?:` and change its return type to `Mode[]`
- [ ] 7.3 Add `getModes(): Mode[]` public override method on `AgentDO` with default `[]`
- [ ] 7.4 Rename `getSubagentProfiles()` → `getSubagentModes()` on `AgentDO`
- [ ] 7.5 Add `getModes` and `getSubagentModes` to the `AgentDelegate` interface used by `createDelegatingRuntime`
- [ ] 7.6 Update `defineAgent` factory body to forward the new slots into the delegating runtime
- [ ] 7.7 Update the agent-runtime-core spec's list of default override methods in the internal `AgentDelegate` shape
- [ ] 7.8 Type-level test: consumer passing `modes: () => [planMode]` typechecks
- [ ] 7.9 Type-level test: consumer passing `subagentModes: () => [explorerMode]` typechecks

## 8. Subagent package unification

- [ ] 8.1 Delete `SubagentProfile` from `packages/subagent/src/types.ts`; re-export `Mode` from `@claw-for-cloudflare/agent-runtime/modes`
- [ ] 8.2 Replace `ResolvedProfile` shape as needed to hold the resolved subset (systemPrompt, tools, modelId)
- [ ] 8.3 Rewrite `packages/subagent/src/resolve.ts` to import `filterToolsAndSections` from `@claw-for-cloudflare/agent-runtime/modes` and delegate tool filtering to it. Keep the file-level function name descriptive of its role (e.g., `resolveSubagentSpawn` or similar) — it is NOT renamed to `applyMode` because `applyMode` is the main-session-specific wrapper. Do NOT construct a fake `ResolvedCapabilities` object
- [ ] 8.4 Update `call_subagent` and `start_subagent` tools in `packages/subagent/src/tools.ts` to use parameter name `mode` (not `profile`); update tool description and JSON schema
- [ ] 8.5 Rename `PendingSubagent.profileId` → `modeId` in `packages/subagent/src/types.ts` and every call site
- [ ] 8.6 Rename `SubagentEventMeta.profileId` → `modeId` in `packages/subagent/src/event-forwarder.ts` and every call site
- [ ] 8.7 Update `subagent_status` broadcast payloads in `capability.ts` / `tools.ts` to carry `modeId` (not `profileId`)
- [ ] 8.8 Update tool output strings (e.g., `[Subagent "${modeId}" completed]`) to reference the new field
- [ ] 8.9 Migrate all 5 test files in `packages/subagent/src/__tests__/` from `SubagentProfile`/`profileId` to `Mode`/`modeId`: `capability.test.ts`, `resolve.test.ts`, `tools.test.ts`, `pending-store.test.ts`, `event-forwarder.test.ts`
- [ ] 8.10 Run `bun test` in `packages/subagent` and fix any regressions

## 9. subagent-explorer package

- [ ] 9.1 Rename exported constant `explorerProfile` → `explorerMode` in `packages/subagent-explorer/src/index.ts`
- [ ] 9.2 Update the `explorer(options?)` factory to return `Mode` with `tools: { allow: [...] }` instead of `tools: string[]`
- [ ] 9.3 Migrate `systemPrompt: (parentPrompt) => ...` → `systemPromptOverride: (base, context) => ...`
- [ ] 9.4 Migrate tests in `packages/subagent-explorer` to reference `explorerMode` and the new field shapes
- [ ] 9.5 Remove the legacy `explorerProfile` export entirely — no deprecation alias

## 10. agent-runtime main barrel + re-exports

- [ ] 10.1 Remove `SubagentProfile` from `packages/agent-runtime/src/index.ts` main barrel
- [ ] 10.2 Confirm `Mode`-related primitives are NOT re-exported from the main barrel (they live only at `/modes`)
- [ ] 10.3 Update any internal imports within `agent-runtime` that referenced `SubagentProfile` to reference `Mode`

## 11. Client and UI updates

- [ ] 11.1 Add `activeMode: { id: string; name: string } | null` to the `useAgentChat()` state in `packages/agent-runtime/src/client/use-agent-chat.ts`
- [ ] 11.2 Update the client chat reducer to handle `mode_event` messages (set/clear `activeMode`)
- [ ] 11.3 Initialize `activeMode` from the `session_sync` payload on connection / session switch
- [ ] 11.4 Add a mode badge component/section to `packages/agent-ui/src/components/status-bar.tsx` that renders when `activeMode !== null`
- [ ] 11.5 Test: reducer updates `activeMode` on `mode_event` kind=entered
- [ ] 11.6 Test: reducer clears `activeMode` on `mode_event` kind=exited
- [ ] 11.7 Test: `session_sync` initializes `activeMode`
- [ ] 11.8 Test: `StatusBar` renders the mode badge when `activeMode` is set

## 12. Examples and downstream

- [ ] 12.1 Update `examples/basic-agent` to drop any reference to `SubagentProfile` / `profile` tool parameter
- [ ] 12.2 Add a demonstration `modes: () => [planMode, researchMode]` slot in `examples/basic-agent` where `researchMode` is a simple consumer-defined mode. Two modes are required to trigger conditional registration of `/mode`, `enter_mode`, `exit_mode`. If two modes feels contrived for the example, add a code comment explicitly noting the 2+ threshold
- [ ] 12.3 Verify `cd examples/basic-agent && bun dev` runs clean after the rename, and verify `/mode` appears in the slash-command autocomplete

## 13. Documentation

- [ ] 13.1 Update `CLAUDE.md`: add a "Modes are the scoping mechanism" architecture-rule subsection; document `Mode`/`defineMode`/`planMode`; document conditional registration rule; note the subpath export; note the SubagentProfile → Mode rename
- [ ] 13.2 Update `README.md`: add a Modes section to the feature list; update the `defineAgent` example to show the `modes` slot
- [ ] 13.3 Update `packages/subagent/README.md` (if present) to reference the new `mode` parameter and `Mode` type
- [ ] 13.4 Update `packages/subagent-explorer/README.md` (if present) to reference `explorerMode`

## 14. Coverage and quality gates

- [ ] 14.1 Run `bun run typecheck` at the repo root — zero errors
- [ ] 14.2 Run `bun run lint` — zero Biome warnings
- [ ] 14.3 Run `bun run test` across all workspaces — all green
- [ ] 14.4 Run `cd packages/agent-runtime && bun test:coverage` — meets 98%/90%/100%/99% thresholds with `modes/` included (only `modes/index.ts` + `modes/built-in/index.ts` barrels excluded)
- [ ] 14.5 Verify no `any` types introduced in production code; tests exempt per biome.json overrides

## 15. Final validation

- [ ] 15.1 `openspec validate add-agent-modes --strict` — zero validation errors
- [ ] 15.2 Manual smoke test: run `bun dev` in `examples/basic-agent`, register two modes, invoke `/mode plan`, verify the `StatusBar` shows the mode badge, send a prompt, confirm the LLM sees the filtered tools and the `promptAppend` content
- [ ] 15.3 Manual smoke test: invoke `/mode` with no argument, verify exit, verify the badge clears
- [ ] 15.4 Manual smoke test: call a subagent referencing `explorerMode` via `call_subagent({ mode: "explorer", prompt: "..." })` and verify the child runs with the filtered tool set
- [ ] 15.5 Manual smoke test: open the rich-prompt-inspection panel with and without a mode active, confirm excluded sections are displayed with `Filtered by mode: <id>` as the reason
