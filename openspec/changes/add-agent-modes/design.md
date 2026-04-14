## Context

Two parallel forces drive this change:

1. **Tool overload is measurable.** Research and production experience converge on ~5–7 tools as the practical limit for reliable LLM tool selection. Beyond that, selection errors climb, parameter hallucination rises, and tool descriptions crowd the context window at the expense of actual task context. CLAW agents routinely exceed this — an agent with r2-storage (9 tools), sandbox (9+), vibe-coder (3), browserbase (8), skills, tavily, task-tracker, subagent, config, and a2a easily surfaces 40+ tools per turn.
2. **Users want explicit control over agent posture.** The "planning mode" pattern (read-only exploration ending in a plan file, then explicit transition to execution) is well-validated across Claude Code, Cursor, and Roo Code. CLAW has no primitive for this today.

The closest existing primitive is `SubagentProfile` in `packages/subagent`, which scopes a child agent's tools and prompt when spawning it. It's structurally ~80% of a "mode" — system prompt override, tool allowlist, model override — but only applies at the *subagent boundary*. There's no way to apply the same scoping to the current session.

**Constraint (enabling):** The just-merged rich-prompt-inspection work (`PromptSection` with `source` attribution, `included: boolean`, `excludedReason: string`, and `toPromptString()` filtering to `included` entries) provides exactly the machinery mode filtering needs. This change would be meaningfully uglier without it.

**Constraint (greenfield):** The SDK has no deployed consumers yet. `gia-cloud` is the origin but has not yet been migrated back onto the SDK. This means breaking renames are free — no deprecation aliases, no dual exports, no migration cycles.

## Goals / Non-Goals

**Goals:**
- Introduce a first-class `Mode` concept: a named filter over capabilities and tools with an associated prompt override.
- Unify `Mode` with `SubagentProfile` so the SDK has one type, one filter implementation, and one mental model for "scoped view of the agent."
- Let consumers register modes via `defineAgent({ modes: () => [...] })` (and the analogous `getModes()` subclass override).
- Provide user-initiated mode switching (`/mode <id>`) and agent-initiated mode transitions (`enter_mode` / `exit_mode` tools).
- Broadcast mode changes to clients so the UI reflects the active mode.
- Ship `planMode` as a built-in reference export from the runtime.
- Keep all new code testable to the existing 98/90/100/99 coverage thresholds.

**Non-Goals:**
- **No auto-transitions.** Capability-triggered or content-classified mode switching is out of scope for v1. Only user and agent transitions.
- **No lifecycle filtering.** Modes do not disable capability `onConnect`, `afterToolExecution`, `httpHandlers`, or `schedules`. Those are DO-level concerns; modes are session-level. Making capability lifecycle mode-aware is a separate, named feature if ever needed.
- **No `context.mode` field on `AgentContext`.** Mode-aware capability behavior is expressed via `capabilityConfig` overrides that merge into the existing config system, reusing the `configSchema` / `onConfigChange` machinery. Adding a new context field is deferred pending a concrete need it doesn't cover.
- **No composition model.** Modes are an opt-in filter layer. Agents without modes work exactly as today; adding modes is purely additive.
- **No mode nesting or stacking.** A session has at most one active mode at a time.
- **No per-capability `modes?:` field.** Capabilities contribute capabilities; modes are separate data defined alongside the agent or exported as named constants from capability packages. This may be revisited as a v2 refinement.
- **No mode filtering on the bundle-brain dispatch path.** The bundle prompt handler at `agent-runtime.ts:1570` runs before `ensureAgent` and short-circuits the turn when a bundle handles it. Bundles resolve their own tools inside the Worker Loader isolate, so `applyMode` never runs. In v1, a bundle that wishes to honor modes MUST resolve the active mode via SpineService and apply its own filter. Wiring host-side mode filtering into the bundle dispatch payload is tracked as a v1.1 follow-up. Rationale: the static brain is always the fallback, bundle-mode integration is a coherent separate feature, and bundling it into v1 would balloon the change.

## Decisions

### D1. Two slots on `defineAgent`, one `Mode` type

```ts
defineAgent({
  modes?: (setup) => Mode[]          // current-session modes
  subagentModes?: (setup) => Mode[]  // subagent spawn modes (was: subagentProfiles)
})
```

Both slots take the same `Mode[]` type. A mode can appear in both slots if it makes sense. Conditional registration rules differ per slot:
- `modes` → `/mode`, `enter_mode`, `exit_mode` gated on `modes.length >= 2`
- `subagentModes` → `call_subagent`, `start_subagent` etc. gated on the existing subagent capability registration (unchanged)

The slot is named `subagentModes` (not the shorter `subagents`) because it returns *modes used to spawn subagents*, not subagent instances. The same naming logic applies to the `AgentDO.getSubagentModes()` override method. The trade-off is verbosity for clarity; the naming matters because consumers will be reading `Mode[]` and need the context of what those modes *do*.

**Alternative considered:** one `modes?:` slot with an `activation: "session" | "subagent" | "either"` field on each mode. **Rejected** because activation is metadata about *how consumers use the mode*, not about the mode itself; it puts a display-layer concern on the data type, and "either" would be the noise-y default for most modes. Two slots makes intent explicit at the registration site.

**Alternative considered:** shorter `subagents?:` slot name. **Rejected** because `getSubagents(): Mode[]` reads confusingly — consumers expect a method named "getSubagents" to return subagent instances, not configuration. The explicit `subagentModes` / `getSubagentModes` naming eliminates the cognitive stutter.

### D2. Two layers: a low-level pure filter and a higher-level wrapper

**This is the single most important architectural decision.** The rich-prompt-inspection path uses a synthetic `__inspection__` sessionId that has no session entries. If mode filtering were to look up the active mode internally via `resolveActiveMode(sessionId)`, the inspection UI would silently show the *default* prompt while the inference path shows the *mode-filtered* prompt. A debugger that lies is worse than no debugger.

The filter surface is split into **two layers** so that the main-session path and the subagent spawn path don't share a signature they both have to bend to fit:

```ts
// Low-level: pure, no AgentContext, no ResolvedCapabilities plumbing.
// Used directly by packages/subagent (which doesn't have ResolvedCapabilities
// at the call site).
function filterToolsAndSections(
  tools: AnyAgentTool[],
  sections: PromptSection[],
  activeMode: Mode | null,
): { tools: AnyAgentTool[]; sections: PromptSection[] };

// Higher-level wrapper: handles capability-level filtering, dead-cap tool
// removal, capabilityConfig overrides, prompt append, and prompt override.
// Used by ensureAgent() on the main session.
function applyMode(
  resolved: ResolvedCapabilities,
  capabilities: Capability[],
  allTools: AnyAgentTool[],
  activeMode: Mode | null,          // ← explicit parameter
  context: AgentContext,
): AppliedMode;
```

Rationale: the subagent package calls `filterToolsAndSections(parentTools, parentSections, mode)` with a simple 3-arg signature — no need to synthesize a `ResolvedCapabilities` object it doesn't have. The main session calls `applyMode()` which internally delegates the tool/section filtering to `filterToolsAndSections` after doing the capability-level bookkeeping. One place for the filter logic, two call sites with appropriate signatures.

`resolveActiveMode(sessionId)` exists as a separate helper and is called **only** from `ensureAgent()` (see D12). The inspection path passes `null` by default or accepts a `?mode=<id>` query parameter to preview any mode without needing a live session. This is strictly better than a sessionId-internal lookup: pure, testable without a session store, and inspection gains a "what would this look like in plan mode?" affordance for free.

**Alternative considered:** one `applyMode(sessionId, ...)` function with the session lookup inside. **Rejected** — kills inspection path.

**Alternative considered:** one `applyMode(resolved, capabilities, allTools, mode, context)` function called from both the main session and subagent paths, with subagent synthesizing a fake `ResolvedCapabilities`. **Rejected** — brittle, and the filter semantics for subagents don't use capability filtering anyway (subagents inherit a flat tool list).

### D3. `mode_change` is a first-class session entry variant, not a `custom` entry

`SessionEntryType` is a string union in a single-column SQL schema. Adding a new variant requires zero migration — it's just a new string value. First-class brings:
- Pattern-matchable via `entry.type === "mode_change"` rather than `entry.type === "custom" && entry.customType === "mode_change"`
- Self-documenting in the transcript
- `buildContext()` already walks the tree; `resolveActiveMode()` is a ~10-line loop walking the same chain

The `data` payload records both enter and exit events with the mode ID, not just a boolean:
```ts
data: { enter: string } | { exit: string }   // NOT { exit: true }
```

The exit variant carries the **mode ID being exited**, not a sentinel boolean. This is essentially free to store and makes post-hoc reconstruction of mode history from the entry log straightforward — audit, analytics, and debugging all benefit from the exit event naming which mode just closed. A `{ exit: true }` sentinel would force consumers to walk backward to find the preceding `enter` entry every time they want to know which mode ended.

**Alternative considered:** follow the cost-event precedent and use a `custom` entry with `customType: "mode_change"`. **Rejected** because cost events are broadcast-only bookkeeping that doesn't need to be walked or pattern-matched. Mode changes *are* walked on every turn (even if cached per D12) and the string-key lookup is fragile during refactoring.

### D4. Filter exclusion via `included: false + excludedReason`, not drop

The rpi work made `PromptSection` structured with `included: boolean` and `excludedReason: string`. `toPromptString()` skips excluded sections when building the final prompt. Mode filtering should **flip** sections to excluded rather than **drop** them from the list:

```ts
{ ...section, content: "", lines: 0, included: false,
  excludedReason: `Filtered by mode: ${modeId}` }
```

**Why:** the inspection UI automatically surfaces "excluded by mode: plan" for every filtered section without any extra code. Tests assert on a crisper shape. Debugging "why doesn't my prompt have X?" gets an authoritative answer.

### D5. Mode machinery is conditionally registered

The rule is strict: **`/mode`, `enter_mode`, `exit_mode`, and the "Current mode: X" prompt indicator are only exposed when `modes.length >= 2`.**

- **0 modes**: feature is off. Zero new tools, zero new commands, zero prompt pollution. An agent without modes is indistinguishable from today's agent.
- **1 mode**: still off. One mode is a baked-in config, not a choice — exposing a toggle would imply agency that doesn't exist.
- **2+ modes**: full machinery.

Gate sites (in `agent-runtime.ts`):
1. `resolveCommands()` — `/mode` added to the map only when `modesActive`
2. `collectAllTools()` — `enter_mode` / `exit_mode` registered only when `modesActive`
3. Base prompt section builder — "Current mode: X" section only added when `modesActive`

`applyMode` itself still runs unconditionally (it's a no-op when `activeMode === null`), keeping the code path uniform.

### D6. `capabilityConfig` overrides for mode-aware capabilities, not a new context field

A mode can carry:
```ts
capabilityConfig?: Record<string, Record<string, unknown>>
```

Keyed by capability ID. While the mode is active, these values merge into the capability's config via the existing `configSchema` / `configDefault` / `onConfigChange` pipeline. Capabilities already read their config to decide behavior; modes hook into that pipe with zero new surface.

**Alternative considered:** add `context.mode?: ModeInfo` to `AgentContext` so capabilities can branch on mode ID directly. **Rejected (for now)** because every capability author would need to learn a new context field, and config-merge already handles the behavioral cases. Can be added later non-breakingly if a concrete case surfaces.

### D7. Subpath export: `@claw-for-cloudflare/agent-runtime/modes`

`agent-runtime` already uses subpath exports (`./client`, `./test-utils`). Adding `./modes` is consistent with that pattern and signals modes as a layered opt-in:

```ts
import { defineMode, planMode, type Mode } from "@claw-for-cloudflare/agent-runtime/modes";
```

Agents that don't use modes never import the file. Built-in modes (`planMode`) and the factory (`defineMode`) live at the same entry point for discoverability.

### D8. Built-in modes: layered ownership

| Who ships | What | Where |
|---|---|---|
| Runtime | Opinion-light generics (`planMode`) | `agent-runtime/modes/built-in/` |
| Capability packages | Modes that turn on their own capability | Alongside the capability (future: `vibeCoder` package exports `vibeDevMode`) |
| Consumers | Cross-cutting, domain-specific modes | Consumer's own codebase |

V1 ships exactly **one** runtime-level built-in: `planMode`. It references tool names from the ecosystem via deny-lists (which are harmless no-ops for tools not present) but imports nothing from capability packages. This keeps the dep graph clean while providing the most-requested mode out of the box.

Capability-package-owned modes are structurally supported (a package can export a `Mode` constant) but none ship in v1. Retrofitting existing packages can follow.

### D9. `Mode.model` is subagent-only

```ts
interface Mode {
  // ...
  model?: string;  // ignored when mode is activated on the current session
}
```

Swapping models mid-session would drop the context cache and surprise users. When a mode with `model` set is activated on the current session, the field is silently ignored and the agent's default model is used. When the same mode is used to spawn a subagent, the child runs on the override model.

This preserves the unification (one type, both use cases) at the cost of one documented quirk. Splitting into `MainSessionMode` and `SubagentMode` would re-introduce the fork the change is trying to eliminate.

### D10. Broadcast mode changes, include in `session_sync`

New `ServerMessage.type: "mode_event"` variant:

```ts
| { type: "mode_event"; sessionId: string;
    event: { kind: "entered"; modeId: string; modeName: string }
         | { kind: "exited";  modeId: string; modeName: string }; }
```

Both kinds carry `modeId` + `modeName` (matching field names across the discriminated union so client-side handling is symmetric — exit carries the ID of the mode that just closed).

Emitted:
- Immediately after appending a `mode_change` session entry
- As part of `session_sync` payload for reconnecting clients (new optional `activeMode` field)

Client-side: the `AgentConnectionProvider` reducer tracks `activeMode: { id; name } | null` in its state, and a new `useActiveMode()` selector hook exposes it to consumers. `StatusBar` reads via `useActiveMode()`. The old `useAgentChat()` shim has already been decomposed into `useChatSession` / `useAgentConnection` / capability-specific hooks — the mode state follows that same decomposed pattern rather than resurrecting a monolithic hook. All additive — existing clients ignore unknown message types silently (no default case in the switch, forward-compat safe).

### D11. Greenfield renames, no back-compat aliases

Because the SDK has no deployed consumers yet:
- `SubagentProfile` is **deleted**, not aliased. All call sites migrate to `Mode`.
- `getSubagentProfiles()` → `getSubagents()`. Hard rename.
- `defineAgent.subagentProfiles?:` → `subagents?:`. Hard rename.
- `resolveProfile()` → `applyMode()`. Hard rename, delegates to shared helper.
- `PendingSubagent.profileId` → `modeId`. Hard rename of the JSON field.
- Subagent tool parameters `profile: string` → `mode: string`. Hard rename.
- Broadcast field `profileId` → `modeId`. Hard rename.
- `packages/subagent-explorer` factory `explorer(options?)` return type: `SubagentProfile` → `Mode`. The factory name stays (the current export is the factory function, not a constant; earlier drafts of this spec mistakenly referenced `explorerProfile`). Body migrates `tools: string[]` → `tools: { allow }` and `systemPrompt` → `systemPromptOverride`. The `isReadOnlyTool` and `filterReadOnlyTools` helpers are retained.

No deprecation JSDoc, no dual exports, no transition cycles. Everything aligns on the new vocabulary from day one.

### D12. Active mode is cached on session metadata; walk is a fallback

Naive `resolveActiveMode(sessionId)` — walking session entries from leaf toward root on every `ensureAgent` call — is O(n) in session length. For long sessions this adds measurable latency to every turn, and the work is almost always wasted (mode changes are rare compared to message turns).

**The cache:** the session metadata row gains an optional `activeModeId: string | null` field. When a `/mode` command or `enter_mode` / `exit_mode` tool appends a `mode_change` entry, the session metadata is updated in the same transaction:
- `enter` → set `activeModeId` to the entered ID
- `exit`  → set `activeModeId` to `null`

`ensureAgent()` reads `activeModeId` from session metadata directly — O(1). The `Mode` object is looked up from the agent's `getModes()` list using that ID.

**The walk still exists,** in two cases:
1. **Fallback/consistency check** — if the metadata lacks `activeModeId` (session predates the feature, or corruption suspected), walk the entries to recompute. A one-time correction.
2. **Branching** — when a session branches from a parent, the branch's metadata is initialized from the most recent `mode_change` on the parent chain at branch time. After that, the branch maintains its own cached `activeModeId`.

This means `resolveActiveMode` has two modes: the cheap cache read and the expensive walk. `ensureAgent` uses the cache; the walk is an internal implementation detail of session branching and consistency recovery.

**Alternative considered:** no cache, walk on every turn. **Rejected** — O(n) per turn in session length is the kind of performance cliff that's easy to hit and hard to diagnose ("why is my long session slow?").

**Alternative considered:** maintain the cache but skip the walk entirely. **Rejected** — branching is a legitimate case where the cache needs to be populated from scratch, and the walk is reusable for that.

### D13. `allow` and `deny` are mutually exclusive per filter

A `Mode.capabilities` or `Mode.tools` filter may specify `allow` OR `deny`, but not both on the same filter. Setting both SHALL be a validation error thrown by `defineMode()`:

```ts
defineMode({
  id: "plan",
  tools: { allow: ["file_read"], deny: ["file_write"] },  // ← throws
})
```

Rationale: the composition semantics are ambiguous (is `deny` applied before or after `allow`? does `allow` make the mode explicit-list-only, with `deny` a no-op?). Every consumer who writes both-present would ask the same question. Making it a validation error at factory time is cheaper than documenting a resolution rule that everyone has to remember. If a consumer needs complex composition, they can use `allow` alone with the explicit list they want.

**Alternative considered:** define a resolution rule (e.g., "`deny` applied after `allow`") and document it. **Rejected** — the rule is invisible in code review and easy to get wrong. A thrown error at `defineMode()` time is a crisper contract.

**Alternative considered:** silently let both coexist and apply them in an implementation-defined order. **Rejected** — silent "works" with subtly different semantics per mode is how production bugs are born.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| **Inspection path divergence** — filter applied inconsistently between `ensureAgent` and `assembleAllSections`, producing a debugger that doesn't match reality. | D2: `applyMode` takes `activeMode` as an explicit parameter. Inspection passes the mode explicitly (from query param or null). No sessionId-internal lookup. |
| **Scope creep from subagent unification** — touching `packages/subagent` expands blast radius beyond the core mode feature. | Accept the scope. Unification is cheaper now (greenfield) than after v1 ships and consumers build on two divergent types. The rename is mechanical; tests are fixture updates. |
| **Coverage threshold (98/90/100/99)** — new `modes/` directory must hit thresholds or get excluded. | Target full coverage. Pure helpers (`apply-mode`, `exclude-sections`, `define-mode`, `resolve-active-mode`) are trivially testable. `commands.ts`/`tools.ts` tested via the existing session-store + transport patterns. Only `index.ts` barrels excluded. |
| **`Mode.model` quirk** — the field is silently ignored when a mode is activated on the current session, which is surprising. | Document clearly on the type JSDoc and in the `defineMode` factory JSDoc. Accept the quirk to preserve type unification. |
| **Single-mode agents get no machinery** — a consumer with one mode might expect `/mode` to work. | Documented rule in the design: one mode is a baked-in config, not a choice. The doc example shows the 0/1/2+ breakdown clearly. |
| **Capability authors may want `context.mode`** — a case may surface where `capabilityConfig` merge isn't enough. | `context.mode` can be added non-breakingly later. Starting without it forces rigorous use of the existing config pipeline, which may prove sufficient. |
| **`mode_event` broadcast back-compat** — adding a new `ServerMessage` variant could theoretically break older clients. | Verified: the client `message-handler.ts` switch has no default case, so unknown variants fall through silently. Forward-compat is bulletproof. |
| **Name collision with `model_change`** — the new `"mode_change"` session entry variant differs from the existing `"model_change"` variant by a single letter. A typo at a dispatch site would silently mis-route. | Require a JSDoc line on both variants in `session/types.ts` explicitly cross-referencing the other. String-literal dispatches ride on TS exhaustiveness checks anyway, so a typo becomes a compile error. |
| **Bundle-brain dispatch bypasses `applyMode`** — bundle turns short-circuit before `ensureAgent`, so mode filtering does not apply to bundles in v1. A bundle carrying a write tool could run under `planMode` without being filtered. | D14 (new): scoped out of v1 as an explicit non-goal. Static brain is always the fallback. v1.1 follow-up: host reads `activeModeId` from metadata before calling `bundlePromptHandler` and passes it into the dispatch payload; bundle runtime imports `filterToolsAndSections` from `agent-runtime/modes`. Documented so authors of bundles that replace high-trust tools know the gap exists. |
| **Mode proliferation / decision fatigue** — users confronted with 10 modes may not know which to pick. | Consumer responsibility. The SDK ships one reference mode; consumers add the ones they need. The `description` field on `Mode` is shown in `/mode` autocomplete. |
| **Active mode resolution cost** — walking session entries per turn would be O(n) in session length and silently add latency to long sessions. | D12: cache `activeModeId` on the session metadata row; update in the same transaction as the `mode_change` entry append. Walk is a consistency fallback and branching-time initializer only. |
| **`allow`/`deny` ambiguity** — consumers setting both on the same filter creates silent order-dependent behavior. | D13: `defineMode()` throws if both are specified on the same filter. Fail loud at authoring time. |
| **`planMode` false sense of safety** — the hard-coded deny list only covers CLAW ecosystem tool names. A consumer whose write tool is named `db_insert` gets no protection. | Document clearly on `planMode`'s JSDoc that it's a starting point for CLAW-ecosystem agents and consumers with custom tool names must override the deny list. The specs do not test the deny list as "all write tools are denied" — only that specific known names are present. |

## Migration Plan

No data migration required (greenfield). The branch is merged in one piece:

1. `packages/agent-runtime/src/modes/` directory added with all new files and unit tests.
2. `packages/agent-runtime` core files updated in the same PR: `define-agent.ts`, `agent-do.ts`, `agent-runtime.ts`, `session/types.ts`, `transport/types.ts`, package.json exports.
3. `packages/subagent` renamed in the same PR: `types.ts`, `resolve.ts`, `tools.ts`, `pending-store.ts`, `event-forwarder.ts`, plus test fixture updates.
4. `packages/subagent-explorer` renamed in the same PR: `index.ts` exports `explorerMode` only.
5. `packages/agent-ui` updated: `StatusBar` mode badge, `useAgentChat` state.
6. `examples/basic-agent` updated if it references any renamed symbol.
7. `CLAUDE.md` and `README.md` updated to reflect the new `Mode` vocabulary, new `modes/` subpath, new slash command, and new tools. Architecture rules section gets a new "Modes" subsection.

**Rollback:** single PR, single revert. No deployed clients, no stored data to restore.

## Open Questions

- **Default `planMode` tool deny-list — what if a capability ships with a conflicting tool name?** E.g., a future capability adds a `file_write` tool that planMode wants to keep. Resolution: ship `planMode` with a conservative deny list documented as "override or compose if your agent has custom write tool names." Accept that `planMode` is a starting point, not a silver bullet.
- **Should `capability_state` carry active-mode info instead of a new `mode_event`?** The existing `capability_state` envelope could theoretically absorb mode broadcasts. Decision: keep `mode_event` separate because mode is agent-level state, not capability-level state. Mixing them would muddy the envelope's semantics.
- **Do we want an `OnModeChange` lifecycle hook for capabilities?** A capability might want to react when a mode is entered (e.g., clear caches, reset state). Deferred. Can be added non-breakingly as `Capability.hooks.onModeChange?` if a concrete case surfaces.
