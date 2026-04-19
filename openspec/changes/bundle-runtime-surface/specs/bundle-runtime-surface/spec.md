## ADDED Requirements

<!-- ============================================================ -->
<!-- Phase 0 — Bundle-side capability + tool execution            -->
<!-- ============================================================ -->

<!-- Section: Capability + tool resolution -->

### Requirement: `runBundleTurn` SHALL invoke `setup.capabilities(env)` and `setup.tools(env)` at the start of each turn

The bundle SDK's `runBundleTurn` SHALL call `setup.capabilities(env)` (when defined) to resolve the bundle's `BundleCapability[]` and `setup.tools(env)` (when defined) to resolve any author-supplied bundle-side tools. Both calls SHALL run inside the bundle isolate per turn (no caching across turns). Capabilities and tools resolved this way are merged with each other for the per-turn loop:

- Tools available to the model: `setup.tools(env) ?? []` concatenated with each capability's `cap.tools(ctx) ?? []`.
- Prompt sections: each capability's `cap.promptSections(ctx) ?? []` collected for normalization (Phase 1).
- Hooks: each capability's `cap.hooks?.{beforeInference, afterToolExecution}` collected for the per-turn invocation chain.

When `setup.capabilities` and `setup.tools` are both undefined or both return empty arrays AND no host-side hooks are registered, the runtime SHALL follow the existing text-only fast path (no tool loop, no hook bridge invocation per tool).

#### Scenario: Capability resolution per turn
- **WHEN** a turn dispatches and `setup.capabilities` is defined as `(env) => [tavilyClient({ service: env.TAVILY })]`
- **THEN** `setup.capabilities(env)` is called exactly once for that turn
- **AND** the returned `BundleCapability` array is used to assemble tools/sections/hooks for the rest of the turn

#### Scenario: Tool resolution per turn
- **WHEN** a turn dispatches and `setup.tools` is defined as `(env) => [defineTool({ name: "x", ... })]`
- **THEN** `setup.tools(env)` is called exactly once
- **AND** the returned tools are merged into the tools list passed to the LLM call

#### Scenario: Empty resolution preserves text-only fast path
- **WHEN** a bundle has neither `setup.tools` nor `setup.capabilities`
- **AND** no host-side capability hooks are registered for the agent
- **THEN** `runBundleTurn` follows the existing v1 text-streaming path (no tool loop, no per-tool hook bridge round-trips)

<!-- Section: Tool-execution loop -->

### Requirement: Bundle SDK SHALL run a tool-execution loop that parses tool calls and re-runs inference until terminal stop

The bundle SDK SHALL parse tool calls from the streamed assistant message — supporting OpenAI/OpenRouter `tool_calls` format and Anthropic `tool_use` content blocks. After the model emits a tool-use stop reason, the SDK SHALL:

1. For each tool call, call `hookBridge.processBeforeToolExecution(event)` (existing host bridge method); if the result indicates `block: true`, surface `reason` to the model as a tool error and continue to the next call without executing.
2. Look up each non-blocked tool by name in the merged tool list.
3. Execute each tool by calling its `execute(args, ctx)` against a `BundleContext`.
4. Run bundle-side `BundleCapability.hooks.afterToolExecution` (in registration order across the bundle's capabilities) for the completed call.
5. Call `hookBridge.recordToolExecution(event)` to fire host-side `afterToolExecution` hooks via the bridge.
6. Append a tool-result message to the conversation.
7. Re-run inference (calling `processBeforeInference` first per the existing bridge contract).
8. Repeat from step 1 until the model emits a non-tool-use stop reason.

Tool-call broadcast wire format SHALL match what the static brain produces (so existing UI code renders bundle-originated tool calls identically to static-brain ones).

#### Scenario: Single tool call round-trips and continues
- **WHEN** the LLM stream emits one tool call (e.g., `web_search`) and stops with tool-use
- **THEN** the bundle SDK invokes the tool's `execute`
- **AND** appends a tool-result message
- **AND** re-runs inference

#### Scenario: Multiple tool calls in one assistant message
- **WHEN** the LLM emits two tool calls (`web_search` + `file_read`) in the same assistant message
- **THEN** the bundle SDK invokes both tools (concurrency per the project's existing tool-sequencing rule)
- **AND** both tool results are appended before re-inference

#### Scenario: processBeforeToolExecution blocks a tool
- **WHEN** the host bridge returns `{ block: true, reason: "denied" }` for a tool call
- **THEN** the tool's `execute` is NOT invoked
- **AND** a tool-result message with the deny reason is appended for the model

#### Scenario: Bundle-side hooks fire before host bridge
- **WHEN** a tool execution completes
- **THEN** the bundle's bundle-side `afterToolExecution` hooks (across all bundle capabilities, in registration order) run BEFORE `hookBridge.recordToolExecution` is called

#### Scenario: Tool-call wire format matches static
- **WHEN** the bundle broadcasts a tool-call event
- **THEN** the wire format is identical to a static-brain tool-call event for the same tool/args/result (existing UI code does not need to differentiate)

<!-- Section: Bundle prompt build merges capability sections -->

### Requirement: Bundle prompt build SHALL merge `setup.prompt` (or default) with capability-contributed sections respecting the `setup.prompt: string` override rule

When `setup.prompt` is a string, that string SHALL be the verbatim system prompt and capability `promptSections` returns SHALL NOT appear in the assembled prompt. When `setup.prompt` is `PromptOptions` (or undefined), the default builder SHALL run and capability sections SHALL splice in after the default sections.

This rule mirrors the static brain's `defineAgent({ prompt: string })` behavior.

#### Scenario: setup.prompt: string suppresses capability sections from prompt
- **WHEN** a bundle has `setup.prompt: "verbatim"` and a capability returning `["section A"]` from `promptSections`
- **THEN** the assembled system prompt is exactly `"verbatim"`
- **AND** "section A" does NOT appear in the prompt

#### Scenario: setup.prompt: PromptOptions allows capability sections
- **WHEN** a bundle has `setup.prompt: { agentName: "X" }` and a capability returning `["section A"]`
- **THEN** the assembled system prompt contains both default sections (agent name X identity, etc.) AND "section A"

#### Scenario: undefined setup.prompt allows capability sections
- **WHEN** a bundle has no `setup.prompt` field and a capability returning `["section A"]`
- **THEN** the assembled system prompt contains the default sections AND "section A"

#### Scenario: String override surfaces suppressed sections in inspection
- **WHEN** `setup.prompt` is a string AND a capability would have contributed sections
- **THEN** the inspection cache (Phase 1) records each suppressed section with `included: false, excludedReason: "Suppressed by setup.prompt: string override"`

<!-- ============================================================ -->
<!-- Phase 1 — Bundle PromptSection parity                        -->
<!-- ============================================================ -->

<!-- Section: BundleCapability.promptSections widens -->

### Requirement: `BundleCapability.promptSections` SHALL accept full `PromptSection` entries alongside existing shorthand forms

The `promptSections` field on `BundleCapability` SHALL accept a return type of `Array<string | BundlePromptSection | PromptSection>`. The bundle prompt handler SHALL normalize every returned entry into a full `PromptSection`:

- A bare `string` SHALL normalize to `{ kind: "included", content: string }` then to a `PromptSection` with `source: { type: "custom" }`, computed `key`, `lines`, `tokens`, `included: true`.
- A `BundlePromptSection` SHALL normalize to a `PromptSection` with `source: { type: "capability", capabilityId: <cap.id>, capabilityName: <cap.name> }`, computed `key` (e.g., `cap-<id>-<index>`), and `included` derived from `kind`.
- A full `PromptSection` SHALL pass through with default-fill for any missing optional fields.

#### Scenario: Bare string normalized to custom-source included section
- **WHEN** a `BundleCapability.promptSections` returns `["my prompt text"]`
- **THEN** the normalized `PromptSection[]` contains one entry with `content: "my prompt text"`, `included: true`, `source.type: "custom"`

#### Scenario: BundlePromptSection normalized with capability source attribution
- **WHEN** a `BundleCapability` with `id: "my-cap", name: "My Cap"` returns `[{ kind: "included", content: "X" }]` from `promptSections`
- **THEN** the normalized `PromptSection` has `source: { type: "capability", capabilityId: "my-cap", capabilityName: "My Cap" }`

#### Scenario: Excluded BundlePromptSection populates excludedReason
- **WHEN** a capability returns `[{ kind: "excluded", reason: "Not yet ready" }]`
- **THEN** the normalized `PromptSection` has `included: false`, `excludedReason: "Not yet ready"`, `content: ""`, `tokens: 0`, `lines: 0`

#### Scenario: Full PromptSection passes through unchanged
- **WHEN** a capability returns `[{ name: "Custom", key: "cap-x-0", content: "Y", lines: 1, tokens: 1, source: { type: "capability", capabilityId: "x", capabilityName: "X" }, included: true }]`
- **THEN** the normalized array contains the same entry (any missing optional fields populated by the host with defaults)

#### Scenario: Malformed entries skipped with warning
- **WHEN** a capability returns `[null, { kind: "wat" }, "good"]`
- **THEN** the normalized array contains exactly the entry derived from `"good"`
- **AND** the host logs a warning identifying the malformed entries

<!-- Section: Inspection cache (version-keyed) -->

### Requirement: Bundle dispatcher SHALL persist the most-recent normalized `PromptSection[]` per session per bundle version, and expose it via spine

After each bundle prompt build, the SDK SHALL call a new spine bridge method `recordPromptSections(token, sessionId, sections)`. The host SHALL write to `ctx.storage.put("bundle:prompt-sections:<sessionId>:v=<bundleVersionId>", sections)`. The cache key SHALL include the active bundle version id so a stale snapshot from a previous version does not appear in inspection after a redeploy.

A new spine method `spineGetBundlePromptSections(caller: SpineCaller, sessionId: string, bundleVersionId?: string): Promise<PromptSection[]>` SHALL read from this key (defaulting `bundleVersionId` to the active bundle version) and return the array. A cold session (no cached entry) SHALL return `[]` rather than throw.

#### Scenario: Cache write per turn
- **WHEN** the bundle SDK composes a per-turn prompt
- **THEN** it calls `spine.recordPromptSections(token, sessionId, sections)` exactly once
- **AND** the host writes the sections to `ctx.storage.put("bundle:prompt-sections:<sessionId>:v=<bundleVersionId>", sections)`

#### Scenario: spineGetBundlePromptSections returns cached sections for active version
- **WHEN** a turn previously dispatched and wrote sections for session `S` under bundle version `V`
- **AND** `spineGetBundlePromptSections(caller, S)` is called with no version argument
- **AND** the active bundle version is `V`
- **THEN** the method returns the same `PromptSection[]` that was written

#### Scenario: spineGetBundlePromptSections for a stale version returns nothing
- **WHEN** the active version is `V2` and a cache entry exists only under `V1`
- **AND** `spineGetBundlePromptSections(caller, S)` is called with no version argument
- **THEN** the method returns `[]` (it does not return the stale `V1` entry)

#### Scenario: Cold session returns empty array
- **WHEN** `spineGetBundlePromptSections(caller, "never-dispatched")` is called
- **THEN** the method returns `[]`
- **AND** the method does not throw

#### Scenario: Method runs under dedicated inspection budget category
- **WHEN** the spine method is called
- **THEN** the call is wrapped through `withSpineBudget` under the `"inspection"` category (a new category added for read-side inspection methods, separate from hot-path spine categories like `"sql"` or `"broadcast"` so heavy inspection traffic does not starve session-store or transport budgets)

#### Scenario: Inspection cache evicted on session delete
- **WHEN** a session is deleted via the existing session-delete code path
- **THEN** all storage keys matching the prefix `bundle:prompt-sections:<sessionId>:v=` SHALL be deleted as part of the same operation
- **AND** subsequent `spineGetBundlePromptSections(caller, deletedSessionId)` calls return `[]`

<!-- ============================================================ -->
<!-- Phase 2 — Bundle lifecycle hooks                             -->
<!-- ============================================================ -->

<!-- Section: BundleAgentSetup gains three lifecycle hook fields -->

### Requirement: `BundleAgentSetup` SHALL expose three optional lifecycle hook fields with semantics matching their static counterparts

`BundleAgentSetup<TEnv>` SHALL gain three optional top-level fields (NOT nested under a `hooks` object):

- `onAlarm?: (env: TEnv, ctx: BundleAlarmContext) => void | Promise<void> | Promise<{ skip?: boolean; prompt?: string }>` — called per due schedule (matching static `onScheduleFire` semantics). Return value influences dispatch: `{ skip: true }` cancels that schedule's fire; `{ prompt: string }` overrides the schedule's prompt for the dispatched turn.
- `onSessionCreated?: (env: TEnv, session: { id: string; name: string }, ctx: BundleSessionContext) => void | Promise<void>` — observation-only, return ignored.
- `onClientEvent?: (env: TEnv, event: BundleClientEvent, ctx: BundleClientEventContext) => void | Promise<void>` — observation-only, return ignored.

Each event-scoped context type SHALL include `spine: BundleSpineClient` plus event-specific fields (`schedule: Schedule` for alarm, `sessionId` for session, `event: BundleClientEvent` for client event). The full `BundleContext` (with `kvStore`, `scheduler`, `channel`, `hookBridge`) SHALL NOT be passed to lifecycle hooks.

#### Scenario: All three fields are optional
- **WHEN** a bundle author calls `defineBundleAgent({ model: ... })` without any of the three fields
- **THEN** the call type-checks
- **AND** the resulting bundle has no metadata declaration for any lifecycle hook

#### Scenario: Top-level field placement matches static defineAgent
- **WHEN** the `BundleAgentSetup` type is inspected
- **THEN** `onAlarm`, `onSessionCreated`, `onClientEvent` appear as top-level optional fields (not nested under a `hooks` object)

#### Scenario: Lifecycle context exposes spine but not hookBridge
- **WHEN** a lifecycle hook fires
- **THEN** the supplied context object exposes a `spine: BundleSpineClient`
- **AND** the supplied context object does NOT expose `hookBridge`

#### Scenario: onAlarm receives a single Schedule per dispatch
- **WHEN** the host fires an alarm wake with three due schedules
- **THEN** the bundle's `onAlarm` is invoked exactly three times (once per due schedule)
- **AND** each invocation's `ctx.schedule` is the corresponding `Schedule` object

#### Scenario: onAlarm return { skip: true } cancels that schedule's fire
- **WHEN** the bundle's `onAlarm` returns `{ skip: true }` for a given schedule
- **THEN** the host does NOT dispatch a turn for that schedule's prompt
- **AND** the alarm processing continues to the next due schedule

#### Scenario: onAlarm return { prompt } overrides the schedule's prompt
- **WHEN** the bundle's `onAlarm` returns `{ prompt: "override" }` for a given schedule
- **THEN** the host dispatches a turn using `"override"` as the prompt (instead of the schedule's stored prompt)

#### Scenario: onSessionCreated and onClientEvent return values are ignored
- **WHEN** `onSessionCreated` returns `{ skip: true }` (or any non-void value)
- **THEN** the host's session-created handling proceeds unaffected (return value is ignored)

<!-- Section: Lifecycle hook HTTP handler wiring -->

### Requirement: Bundle SDK HTTP handlers for `/alarm`, `/session-created`, `/client-event` SHALL invoke the corresponding setup field

The previously-stub handlers `handleAlarm`, `handleSessionCreated`, `handleClientEvent` in `bundle-sdk/src/define.ts` SHALL each: verify `env.__BUNDLE_TOKEN` (401 if missing); parse the request body for the typed payload; build the appropriate context object (with a `BundleSpineClient` constructed from `env`); invoke the user-supplied handler if defined; return:

- For `/alarm`: `{ status: "ok", result?: { skip?, prompt? } }` on success, `{ status: "error", message }` on throw, `{ status: "noop" }` when no handler is registered.
- For `/session-created` and `/client-event`: `{ status: "ok" }` on success, `{ status: "error", message }` on throw, `{ status: "noop" }` when no handler is registered.

If `env.SPINE` is missing, the handlers SHALL return 500 with a clear error (matching `/turn`'s spine-binding-missing path).

#### Scenario: alarm handler defined — fires and returns ok with result
- **WHEN** `defineBundleAgent({ model, onAlarm: async () => ({ skip: true }) })` is built
- **AND** the host POSTs to `/alarm` with a valid payload
- **THEN** the user-supplied `onAlarm` is invoked exactly once
- **AND** the response is `{ status: "ok", result: { skip: true } }`

#### Scenario: BundleClientEvent shape covers steer at minimum
- **WHEN** the host POSTs to `/client-event` with body `{ event: { kind: "steer", payload: { messageIds: ["m1"], type: "user-message-update" } } }`
- **THEN** the bundle's `onClientEvent` (when defined) is invoked with `event.kind === "steer"` and `event.payload` carrying the steer-specific fields
- **AND** the bundle handler can branch on `event.kind` to handle `"steer"`, `"abort"`, or future kinds

#### Scenario: Missing handler still type-checks for any registered BundleClientEvent kind
- **WHEN** the host POSTs to `/client-event` with body `{ event: { kind: "abort", payload: {} } }`
- **AND** the bundle has no `onClientEvent` field
- **THEN** the response is `{ status: "noop" }`

#### Scenario: Handler not defined — noop
- **WHEN** `defineBundleAgent({ model })` is built without an `onAlarm` field
- **AND** the host POSTs to `/alarm`
- **THEN** the response is `{ status: "noop" }`

#### Scenario: Handler throws — error response with structured message
- **WHEN** the user-supplied handler throws `new Error("boom")`
- **THEN** the response is `{ status: "error", message: "boom" }`
- **AND** the error does not crash the bundle isolate

#### Scenario: Missing __BUNDLE_TOKEN returns 401
- **WHEN** the host POSTs to any of the three endpoints without `env.__BUNDLE_TOKEN` populated
- **THEN** the response is HTTP 401

#### Scenario: Missing env.SPINE returns 500
- **WHEN** the host POSTs to any of the three endpoints with `env.__BUNDLE_TOKEN` set but `env.SPINE` undefined
- **THEN** the response is HTTP 500 with a clear error message

<!-- Section: BundleMetadata.lifecycleHooks declaration -->

### Requirement: `BundleMetadata` SHALL declare which lifecycle hooks are registered, populated automatically by `defineBundleAgent`

`BundleMetadata` SHALL gain `lifecycleHooks?: { onAlarm?: boolean; onSessionCreated?: boolean; onClientEvent?: boolean }`. `defineBundleAgent` SHALL populate this declaration based on which `BundleAgentSetup` fields are defined: `lifecycleHooks: { onAlarm: setup.onAlarm !== undefined, onSessionCreated: setup.onSessionCreated !== undefined, onClientEvent: setup.onClientEvent !== undefined }`. The host SHALL read this declaration at dispatch time and SHALL skip Worker Loader instantiation entirely for hooks the bundle does not declare.

A bundle published before this change SHALL be treated as `lifecycleHooks: undefined` (or all-false equivalent) by the host.

#### Scenario: defineBundleAgent populates declaration from defined fields
- **WHEN** `defineBundleAgent({ model, onAlarm: async () => {} })` is built
- **THEN** `BundleMetadata.lifecycleHooks` equals `{ onAlarm: true, onSessionCreated: false, onClientEvent: false }`

#### Scenario: Empty declaration when no hooks defined
- **WHEN** `defineBundleAgent({ model })` is built without any lifecycle hook field
- **THEN** `BundleMetadata.lifecycleHooks` is either `undefined` or all-false

#### Scenario: Host skips dispatch for undeclared hook
- **WHEN** a bundle has `lifecycleHooks: { onAlarm: false, onSessionCreated: true, onClientEvent: false }`
- **AND** an alarm fires
- **THEN** the host does NOT instantiate the bundle isolate or POST to `/alarm`

#### Scenario: Bundle without lifecycleHooks defaults to no dispatch
- **WHEN** a bundle published before this change (with `lifecycleHooks: undefined` in metadata) is loaded
- **AND** an alarm fires
- **THEN** the host does NOT POST to `/alarm`

<!-- Section: Lifecycle hook awaited vs fire-and-forget -->

### Requirement: `onAlarm` dispatch SHALL be awaited and dispatched in parallel across due schedules; `onSessionCreated` and `onClientEvent` dispatches SHALL be fire-and-forget

The host's invocation of `onAlarm` SHALL await the bundle's response so the return value can influence dispatch. When N schedules are due in one wake, the host SHALL dispatch them **in parallel** (`Promise.allSettled` or equivalent) so total wall-time is bounded by `max(per-handler timeouts)` rather than `sum(per-handler timeouts)`. A per-handler timeout (default **5 seconds**, configurable) SHALL apply; on timeout the host SHALL treat the result as `{}` (no skip, no prompt override) and continue with the schedule's normal dispatch.

The host's invocation of `onSessionCreated` and `onClientEvent` SHALL NOT block the host's own event handling. Both fire alongside other event consumers (e.g., the static brain's `onSessionCreated` if defined, transport client-event subscribers). Bundle handler success or failure SHALL surface in structured telemetry; bundle handler return values SHALL NOT influence host event handling.

#### Scenario: onAlarm awaited path respects { skip: true }
- **WHEN** the bundle's `onAlarm` for a given schedule returns `{ skip: true }`
- **THEN** the host does NOT proceed to dispatch a turn for that schedule
- **AND** the host's static `onScheduleFire` (if defined) DOES still fire (parity — the static hook is also per-schedule)

#### Scenario: onAlarm parallel dispatch bounds wall-time
- **WHEN** an alarm wake has N due schedules with `onAlarm` declared
- **THEN** the host dispatches all N `/alarm` calls in parallel
- **AND** total wall-time spent waiting for handlers is bounded by `max(per-handler timeouts)` not `sum`

#### Scenario: onAlarm timeout treated as empty result
- **WHEN** the bundle's `onAlarm` does not respond within the configured timeout (default 5s)
- **THEN** the host treats the result as `{}` (no skip, no prompt override)
- **AND** dispatches the schedule's stored prompt as a normal turn

#### Scenario: Bundle onAlarm and static onScheduleFire both return { prompt } — bundle wins
- **WHEN** for the same due schedule the bundle's `onAlarm` returns `{ prompt: "B" }` AND the static `onScheduleFire` returns `{ prompt: "S" }`
- **THEN** the host dispatches the schedule's turn with prompt `"B"` (bundle's return wins because the bundle is the runtime brain; static hook is observation/coordination)
- **AND** if either side returns `{ skip: true }`, the schedule is skipped (skip wins over prompt)

#### Scenario: onSessionCreated bundle error does not block host
- **WHEN** the bundle's `onSessionCreated` handler throws
- **AND** the host has a static `onSessionCreated` defined
- **THEN** the static `onSessionCreated` runs

#### Scenario: Structured error log on lifecycle handler failure
- **WHEN** a lifecycle handler throws `new Error("X")`
- **THEN** a structured error log records `{ bundleId, version, handler: <name>, errorMessage: "X" }` (or the implementation's equivalent shape)

#### Scenario: Bundle and static onSessionCreated ordering is unspecified
- **WHEN** both bundle `onSessionCreated` and static `onSessionCreated` are defined for the same agent
- **THEN** they MAY fire in any order
- **AND** neither handler MAY depend on side effects produced by the other — both must be safe under any ordering

<!-- Section: Lifecycle dispatch token shape -->

### Requirement: Lifecycle hook dispatches SHALL use the same `__BUNDLE_TOKEN` shape as `/turn` dispatches

When the host dispatches `/alarm`, `/session-created`, or `/client-event` to the bundle, the host SHALL mint a `__BUNDLE_TOKEN` with `scope: ["spine", "llm", ...catalogIds]` derived from the validated `requiredCapabilities` catalog — identical shape to the per-turn dispatch token. The handler SHALL be able to call back through spine and inference using this token.

#### Scenario: Lifecycle dispatch token has full per-turn scope shape
- **WHEN** the host dispatches `/alarm` for a bundle with `requiredCapabilities: [{ id: "tavily-web-search" }]`
- **THEN** the `__BUNDLE_TOKEN` placed on the bundle env has `scope: ["spine", "llm", "tavily-web-search"]`

#### Scenario: Lifecycle handler can call spine
- **WHEN** the bundle's `onSessionCreated` handler calls `ctx.spine.appendEntry(...)` using the token
- **THEN** the spine call verifies the token and proceeds (subject to budget)

<!-- ============================================================ -->
<!-- Phase 3 — Mode-aware bundle dispatch                         -->
<!-- ============================================================ -->

<!-- Section: Mode resolution + filtering before env composition -->

### Requirement: Bundle dispatcher SHALL resolve and apply the active mode before composing the bundle env

The bundle dispatcher's per-turn flow SHALL:

1. Read `activeModeId` from session metadata (using the existing `readActiveModeId` path).
2. If `activeModeId` is set AND the agent has a registered `Mode` with that id, look up the `Mode` from cached modes.
3. Apply `filterToolsAndSections(mode, tools, sections)` to the bundle's full tool list (from Phase 0's resolution) and full prompt section list (from Phase 1's normalization).
4. Compose the bundle env using the *filtered* tool list (the bundle isolate sees only mode-allowed tools).
5. Compose the bundle prompt using the *filtered* section list. Excluded sections SHALL surface in inspection with `excludedReason: "Filtered by mode: <id>"`.
6. Mint the token, dispatch.

The string-override rule (Phase 0) SHALL apply BEFORE mode filtering: when `setup.prompt` is a string, capability sections are suppressed regardless of mode (mode filter then operates on an empty section list).

When no mode is active OR no registered mode matches `activeModeId`, the dispatcher SHALL skip filtering — the bundle sees the full tool/section set.

#### Scenario: Mode-active turn filters tools
- **WHEN** session has `activeModeId: "planning"` AND agent has `defineMode({ id: "planning", tools: { allow: ["task_create"] } })` registered
- **AND** the bundle has tools `[task_create, file_write, web_search]` (resolved from Phase 0)
- **THEN** the bundle env's tool list is `[task_create]`

#### Scenario: Mode-active turn filters sections
- **WHEN** session has an active mode that denies a capability's sections
- **THEN** the bundle prompt does NOT include the denied capability's section content
- **AND** the inspection cache has the section with `included: false`, `excludedReason: "Filtered by mode: <mode-id>"`

#### Scenario: No active mode — no filtering
- **WHEN** session has no `activeModeId`
- **THEN** the bundle env's tool list contains every tool the bundle resolved (Phase 0)
- **AND** the bundle prompt contains every section the bundle declared (Phase 1)

#### Scenario: Active mode id without matching registered mode — no filtering
- **WHEN** session has `activeModeId: "ghost"` but no registered mode with that id
- **THEN** the dispatcher does NOT throw
- **AND** the bundle sees the unfiltered tool/section set

#### Scenario: String override + mode interact — string suppresses, then filter is no-op
- **WHEN** `setup.prompt` is a string AND the session has an active mode
- **THEN** capability sections are suppressed first (per Phase 0's override rule)
- **AND** the mode filter operates on an empty section list (no-op for sections)
- **AND** the mode filter still applies to the tool list normally

<!-- Section: BundleContext.activeMode -->

### Requirement: `BundleContext.activeMode` SHALL expose the active mode's id and name (and only those fields)

`BundleContext` SHALL gain `activeMode?: { id: string; name: string }`. Bundle code SHALL be able to read `ctx.activeMode?.id` to branch on which mode is active. The full `Mode` definition (allow/deny lists, etc.) SHALL NOT be exposed on `BundleContext`.

When no mode is active, `BundleContext.activeMode` SHALL be `undefined`.

#### Scenario: activeMode populated when mode is active
- **WHEN** the bundle dispatcher composes context for a turn whose session has an active mode `{ id: "planning", name: "Planning" }`
- **THEN** `BundleContext.activeMode` equals `{ id: "planning", name: "Planning" }`

#### Scenario: activeMode undefined when no mode active
- **WHEN** the bundle dispatcher composes context for a turn whose session has no active mode
- **THEN** `BundleContext.activeMode` is `undefined`

#### Scenario: activeMode does not expose mode internals
- **WHEN** `BundleContext.activeMode` is read
- **THEN** the returned object has exactly the fields `id` and `name` (no `tools`, no `capabilities`, no `prompt`, no `sections`)

<!-- Section: Mode transitions broadcast for bundle agents identically -->

### Requirement: Mode transitions in bundle agents SHALL broadcast `mode_event` identically to static agents

When a bundle agent's session transitions modes (via `enter_mode`/`exit_mode` tools or `/mode <id>` slash command), the host SHALL emit a `mode_event` broadcast with the same wire format used by static-brain mode transitions. The bundle vs static origin of the transition SHALL NOT affect the broadcast format.

#### Scenario: enter_mode in bundle agent broadcasts mode_event
- **WHEN** a bundle agent's session transitions from no mode to mode `"planning"`
- **THEN** a `mode_event` broadcast fires with the same wire format a static-brain transition would produce

#### Scenario: exit_mode in bundle agent broadcasts mode_event
- **WHEN** a bundle agent's session exits mode `"planning"`
- **THEN** a `mode_event` broadcast fires carrying `{ exit: "planning" }` (matching the static path)

<!-- Section: Subagent mode parity -->

### Requirement: Bundle subagent dispatch SHALL apply mode-awareness equivalently to parent dispatch

When a bundle agent spawns a subagent via `call_subagent` or `start_subagent`, the subagent's bundle dispatch SHALL resolve and apply the subagent's active mode (from `subagentModes`) using the same Phase 3 flow the parent dispatch uses. The same `Mode` constant placed in both `modes` and `subagentModes` SHALL produce identical filtering at both levels.

#### Scenario: Subagent inherits mode-aware dispatch
- **WHEN** a bundle agent spawns a subagent
- **AND** the subagent's `subagentModes` includes the active mode
- **THEN** the subagent's bundle env tool list is filtered by that mode's rules

<!-- ============================================================ -->
<!-- Cross-cutting                                                 -->
<!-- ============================================================ -->

<!-- Section: No breaking changes -->

### Requirement: All changes in this proposal SHALL be additive — existing bundles SHALL continue to function

Bundles built before any phase of this proposal lands SHALL continue to function with no required changes. Specifically:

- Bundles whose capabilities return `string` or `BundlePromptSection` from `promptSections` SHALL render in the host's prompt builder identically (Phase 1's normalization is structurally equivalent for those input forms).
- Bundles without `setup.tools` and `setup.capabilities` SHALL follow the existing v1 text-only fast path (Phase 0's tool loop is skipped).
- Bundles without `onAlarm`/`onSessionCreated`/`onClientEvent` SHALL receive no host-driven dispatches to those endpoints (Phase 2's metadata gate is the safety net).
- Bundles in agents without registered modes SHALL see no behavior change from mode-awareness — the dispatcher's filter step is a no-op when no mode is active.

The single visible behavior shift (Phase 3) — bundles in mode-registered agents now see filtered tools/sections — is documented in CLAUDE.md as a v1.1 follow-up; the release note flags it.

#### Scenario: Existing string-returning capability still renders
- **WHEN** a bundle from before this change has a capability returning `["a string"]` from `promptSections`
- **THEN** the host normalizes it identically to post-change normalization
- **AND** the rendered prompt contains the string

#### Scenario: Existing text-only bundle uses fast path
- **WHEN** a bundle has neither `setup.tools` nor `setup.capabilities`
- **THEN** `runBundleTurn` does not run the tool-execution loop
- **AND** behavior matches the v1 text-streaming path

#### Scenario: Existing bundle without lifecycle hooks receives no dispatches
- **WHEN** an alarm fires for an agent whose bundle has no `lifecycleHooks` declaration
- **THEN** the host does NOT POST to `/alarm`

#### Scenario: Existing bundle in mode-less agent unaffected
- **WHEN** an agent has no registered modes
- **AND** a turn dispatches to its bundle
- **THEN** the bundle env's tool list contains every tool the bundle resolved (no filter applied)

<!-- Section: Both dispatch paths kept in sync -->

### Requirement: Production `initBundleDispatch` closure and test-only `BundleDispatcher` class SHALL stay in sync for every per-turn flow change

`agent-runtime/src/agent-do.ts`'s `initBundleDispatch` closure is the production dispatch path. `bundle-host/src/dispatcher.ts`'s `BundleDispatcher` class is unit-test-only and SHALL mirror the closure's per-turn flow. Both files SHALL be updated for any per-turn flow change introduced by this proposal (capability/tool resolution insertion point, mode resolution, lifecycle hook gating, prompt-section snapshot write).

#### Scenario: BundleDispatcher tests pass against the same flow shape
- **WHEN** the production closure is updated for a phase
- **THEN** the test `BundleDispatcher` is updated with the same flow change
- **AND** the existing dispatcher integration tests pass

#### Scenario: Per-turn flow change covered by both paths
- **WHEN** Phase 3's mode-resolution step is added
- **THEN** both `initBundleDispatch` and `BundleDispatcher` perform the resolution before composing the bundle env

#### Scenario: Both dispatch paths call the shared envelope helper
- **WHEN** the production path (`initBundleDispatch`'s `dispatchTurn`, `dispatchClientEvent`, and Phase 2's lifecycle dispatchers) builds a Worker Loader config
- **AND** the test path (`BundleDispatcher`'s equivalents) builds a Worker Loader config
- **THEN** both call the shared `composeWorkerLoaderConfig(versionId, bytes, env, token)` helper which decodes the v1 envelope via `decodeBundlePayload`
- **AND** neither path bypasses envelope decode for any dispatch kind (turn, client-event, alarm, session-created)

### Requirement: Phase 3 SHALL emit a one-time runtime warning per (agent, bundle version) on first dispatch under an active mode

The first time a given `(agentId, bundleVersionId)` pair dispatches a turn under an active mode AFTER Phase 3 lands, the host SHALL emit a structured warning log identifying which tools and which sections were filtered out vs the bundle's full inventory. A persistent flag in DO storage (e.g., `bundle:mode-warning-emitted:<agentId>:<bundleVersionId>`) SHALL prevent duplicate warnings for the same (agent, bundle version). Subsequent turns of the same pair under the same or different modes SHALL NOT re-emit the warning.

Purpose: Phase 3 is a behavior shift for any agent with modes registered + bundle wired. Operators tailing logs after the upgrade see immediately which bundles are now filtering and which capabilities/tools they lost — without the warning, the change is silent.

#### Scenario: First mode-active dispatch emits warning
- **WHEN** an agent (id `A`) with bundle version `V` dispatches a turn under active mode `M` for the first time after Phase 3 lands
- **THEN** the host emits exactly one structured warning log with `{ agentId: A, bundleVersionId: V, modeId: M, filteredTools: [...], filteredSections: [...] }` (or implementation-equivalent shape)
- **AND** the host writes the persistent flag indicating the warning was emitted

#### Scenario: Subsequent dispatches do not re-emit
- **WHEN** the same `(A, V)` pair dispatches another turn under the same OR a different active mode
- **THEN** no additional warning is emitted

#### Scenario: New bundle version emits a fresh warning
- **WHEN** the bundle is redeployed to version `V2` and `(A, V2)` dispatches under any active mode for the first time
- **THEN** a fresh warning is emitted (the persistent flag is keyed on bundle version)
