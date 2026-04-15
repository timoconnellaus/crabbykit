# CLAW for Cloudflare

Open-source SDK for building AI agents on Cloudflare Workers. Framework, not application — consumers extend `AgentDO` (or call `defineAgent`), register capabilities, get persistent sessions, streaming, tool execution, and a composable React UI.

Originated in [gia-cloud](../gia-cloud); designed to be applied back there and open-sourced.

## Packages

Packages live under `packages/<bucket>/<name>/` — seven role-based buckets. See "### Workspace layout" under Architecture Rules for the dependency direction invariants enforced by `scripts/check-package-deps.ts`.

```
runtime/                 The engine and bundle system plumbing
  agent-runtime          Core: AgentDO, sessions, capabilities, transport, scheduling, MCP client, cost tracking
  agent-core / ai        Forks of pi-agent-core / pi-ai (LLM loop, model providers)
  ai-proxy               AiService + aiProxy for host-side LLM inference proxying
  bundle-token           Verify-only capability token primitives shared by host + sdk
  bundle-sdk             Bundle authoring API (`defineBundleAgent`, prompt/context types, runtime-source subpath)
  bundle-host            Host-side dispatcher, SpineService, LlmService, bundle-builder, mint-side token helpers
  bundle-registry        D1/KV bundle version store (content-addressed, atomic setActive)
  agent-workshop         Agent-facing bundle tools (workshop_init/build/test/deploy/disable/rollback/versions)

infra/                   Native-binding-holding, deploy-time-wired providers
  agent-storage          Shared R2 identity (bucket + namespace prefix)
  agent-auth             HTTP auth utilities
  credential-store       Secure credential storage
  skill-registry         D1-backed skill registry
  agent-registry         D1 agent registry
  app-registry           D1-backed app registry (deploy/rollback/delete tools)
  container-db           env.DB-compatible client over http://db.internal
  cloudflare-sandbox     Sandbox provider via Container DO

capabilities/            Brain-facing tools, hooks, and turn-lifecycle behaviors
  tavily-web-search      Web search/fetch via Tavily
  file-tools             Nine file_* tools backed by agentStorage (R2)
  vector-memory          Semantic memory (Vectorize + R2)
  browserbase            Browser automation via Browserbase (CDP + a11y snapshots)
  skills                 Skills capability (skill_load tool)
  prompt-scheduler       Schedule management as agent tools
  task-tracker           DAG task management
  sandbox                Shell execution with elevation model (tool side + provider contract)
  vibe-coder             Live app preview + console capture
  batch-tool             Batch tool-call execution
  subagent               Same-DO child agent spawning
  subagent-explorer      Pre-built explorer subagent profile
  doom-loop-detection    Repeated-tool-call loop detector
  tool-output-truncation Truncate oversized tool results
  compaction-summary     LLM-based conversation compaction
  heartbeat              Periodic heartbeat

channels/                Input surfaces that deliver messages to agents
  channel-telegram       Reference channel via defineChannel

federation/              Multi-agent coordination
  a2a                    Agent-to-Agent protocol (A2A v1.0)
  agent-fleet            Fleet management
  agent-peering          HMAC peer-to-peer

ui/                      Client-side React
  agent-ui               React components (data-agent-ui selectors)

dev/                     Build / dev tooling
  vite-plugin            Vite plugin for CLAW dev (bundled into containers)

examples/basic-agent     Full-stack example (Vite + Worker)
e2e/agent-runtime        E2E (pool-workers + wrangler dev w/ containers)
```

## Commands

```bash
bun install
bun run test         # all workspaces
bun run typecheck
bun run lint         # Biome check
bun run lint:fix
```

Per-package: `cd packages/X && bun test`. Example dev server: `cd examples/basic-agent && bun dev`. E2E: `cd e2e/agent-runtime && bun test` (fast) or `bun run test:dev` (real containers).

`examples/basic-agent` ships an interactive `claw` CLI (`bun link` once) wrapping debug HTTP endpoints under `/agent/:agentId/debug/*`. Implementation lives in `examples/basic-agent/src/debug-capability.ts` + `cli/index.ts` — not in runtime.

## Architecture Rules

### Workspace layout

Packages live in seven role-based buckets under `packages/`. Every package belongs to exactly one bucket matching its dominant role. New packages MUST be placed in the correct bucket; a depth-one directory (e.g. `packages/foo/`) is not picked up by the `packages/*/*` workspace glob and will surface as a module-not-found error at install time.

- `runtime/` — the engine and bundle system. Answers "what runs the agent?"
- `infra/` — native-binding-holding providers (storage identity, D1 registries, credential store, container sandbox provider). Answers "what holds the native CF bindings and secrets?"
- `capabilities/` — brain-facing tools, hooks, and turn-lifecycle behaviors. Answers "what tools can the brain call?"
- `channels/` — input surfaces that deliver messages to agents. Answers "how do messages get into agents from outside?"
- `federation/` — multi-agent coordination. Answers "how do agents talk to each other?"
- `ui/` — client-side React. Answers "what does the end user see?"
- `dev/` — build and development tooling. Answers "what's build-time only?"

**Dependency direction rules** (enforced by `scripts/check-package-deps.ts`, invoked from `bun run lint`):

```
runtime/       → runtime/
infra/         → runtime, infra
capabilities/  → runtime, infra, capabilities
channels/      → runtime, infra, capabilities, channels
federation/    → runtime, infra, federation
ui/            → runtime (only @claw-for-cloudflare/agent-runtime)
dev/           → any bucket (build-time exempt)
```

Forbidden edges: runtime → anything-below, infra → capabilities/channels/federation/ui, capabilities → channels/federation/ui, channels → federation/ui, federation → capabilities/channels/ui, ui → infra/capabilities/channels/federation. The central invariant: **`runtime/` does not know what a capability is.**

Type-only imports (`import type` / `export type`) are allowed across every boundary — they describe contracts, not runtime edges. Value imports are restricted per the table above, with a single documented exception in the lint script for `runtime/agent-runtime` → `federation/a2a` (the runtime currently hard-depends on A2A's executor and task store; the A2A first-class promotion in flight moves a2a into `runtime/` and removes the exception).

### `defineAgent()` is the primary consumer API

`defineAgent({ model, prompt, tools, capabilities, ... })` returns a DO class. Flat fields, all optional except `model`. Env-dependent fields accept `(env, setup) => value`. See `README.md` for full reference.

### Three-layer split: `defineAgent` → `AgentDO` → `AgentRuntime`

- **`AgentRuntime<TEnv>`** (`src/agent-runtime.ts`) — platform-agnostic. Sessions, LLM loop, capabilities, scheduling, A2A, HTTP routing. Zero `cloudflare:workers` imports. Takes `SqlStore`/`KvStore`/`Scheduler`/`Transport`/`RuntimeContext` adapters.
- **`AgentDO<TEnv>`** (`src/agent-do.ts`) — thin CF shell. Constructs adapters, holds `cfTransport`, delegates `fetch`/`alarm`/`webSocketMessage`/`webSocketClose` via `createDelegatingRuntime`. Escape hatch for advanced consumers.
- **`defineAgent<TEnv>()`** (`src/define-agent.ts`) — anonymous class extending `AgentDO`, forwards each delegate to the flat definition.

`createDelegatingRuntime(host, adapters)` (`src/runtime-delegating.ts`) wires an `AgentDelegate` host into an anonymous `AgentRuntime` subclass.

Subclassing `AgentDO` directly: override methods are **public** (not protected) so `createDelegatingRuntime` sees them structurally. Abstract: `getConfig()`, `getTools(ctx)`. Optional: `buildSystemPromptSections` (preferred, returns `PromptSection[]` with source attribution + included/excluded), `buildSystemPrompt` (@deprecated string form — runtime wraps it as a single "custom" section), `getPromptOptions`, `getCapabilities`, `getModes`, `getSubagentModes`, `getConfigNamespaces`, `getA2AClientOptions`, `getCommands`, `getAgentOptions`. Lifecycle hooks: `validateAuth?`, `onTurnEnd?`, `onAgentEnd?`, `onSessionCreated?`, `onScheduleFire?`. Test subclasses override `ensureAgent(sessionId)` (duck-typed). Protected getters expose runtime state: `sessionStore`, `scheduleStore`, `configStore`, `mcpManager`, `taskStore`, `queueStore`, `kvStore`, `scheduler`, `transport`, `sessionAgents`, `pendingAsyncOps`, `*Hooks`, `capabilitiesCache`, `connectionRateLimits`, `scheduleCallbacks`, `timerOwners`, `capabilityDisposers`.

### Bundle brain override (opt-in via `bundle` field on `defineAgent`)

When omitted, agent is purely static. When present, each turn dispatches into a registry-backed bundle loaded via Worker Loader. Bundle calls back to DO via `SpineService` for state; `LlmService` proxies inference. Static brain is always the fallback.

**Three-package split:** `@claw-for-cloudflare/bundle-sdk` holds the authoring API (`defineBundleAgent`, bundle context types, prompt builders, the runtime-source subpath that the host injects into compiled bundles). `@claw-for-cloudflare/bundle-host` holds the host-side dispatcher, `SpineService`, `LlmService`, `InMemoryBundleRegistry`, the `bundle-builder` auto-rebuild path, and the mint-side token helpers (`mintToken`, `deriveMintSubkey`). `@claw-for-cloudflare/bundle-token` is a tiny verify-only shared package (`verifyToken`, `NonceTracker`, `deriveVerifyOnlySubkey`) imported by both halves. The SDK has zero path to the mint primitives by construction — a `vitest` assertion in `bundle-sdk/src/__tests__/mint-unreachable.test.ts` documents the invariant.

**Security:** per-turn HMAC tokens with HKDF-derived per-service subkeys. Identity derived from verified token payload — bundles cannot forge. `globalOutbound: null` on the loader isolate blocks direct outbound. Provider credentials live in host-side `LlmService`/capability services, never bundle env.

**Capability service pattern (for capabilities holding secrets):** four subpaths — `index` (legacy static), `service` (host WorkerEntrypoint with credentials), `client` (bundle-side proxy — imports types from `@claw-for-cloudflare/bundle-sdk`), `schemas` (shared tool schemas). Tavily is the pilot.

**Bundle pointer cache is single-writer.** Hot-path cache at `ctx.storage.activeBundleVersionId` avoids per-turn D1 read. Written ONLY inside `define-agent.ts`'s `_initBundleDispatch` closure (its `bundlePointerRefresher` plus inline writes on `/bundle/disable` and auto-revert). Any in-process code that mutates `bundle-registry.setActive(...)` for an agent on the same DO MUST follow with `await ctx.notifyBundlePointerChanged()` — workshop tools are the canonical example. Skipping it = deployed bundle silently never runs.

**Out-of-band mutations** (admin scripts, other workers, direct DB writes) MUST POST `/bundle/refresh` on the agent's HTTP surface. In-process: `notifyBundlePointerChanged`. Out-of-process: `/bundle/refresh`. Two channels, no third.

**Bundle dispatch is NOT mode-aware in v1** — bundle prompt handler short-circuits before `ensureAgent`, so `applyMode` doesn't run. v1.1 follow-up.

### Modes are the scoping mechanism

A `Mode` is a named filter over tools + prompt sections. SDK answer to tool overload. Imports live ONLY at `@claw-for-cloudflare/agent-runtime/modes`:

```ts
import { defineMode, planMode, filterToolsAndSections, applyMode, resolveActiveMode, type Mode, type AppliedMode } from "@claw-for-cloudflare/agent-runtime/modes";
```

Nothing mode-related is exported from the main barrel — agents that don't use modes don't import the file.

- Two slots on `defineAgent`: `modes` (session-level, for `/mode <id>` and `enter_mode`/`exit_mode`) and `subagentModes` (for `call_subagent`/`start_subagent`). Same `Mode` constant may appear in both. Slot named `subagentModes` (not `subagents`) so getter can't be confused with returning subagent instances.
- Conditional registration gated at `>= 1` mode. With 0 modes the slash command, tools, and prompt indicator are NOT registered (byte-identical to pre-feature). One mode is meaningful (in vs out).
- `defineMode()` rejects conflicting allow + deny on `tools` or `capabilities` — throws at factory time.
- Mode transitions are `mode_change` session entries with `{ enter: id }` or `{ exit: id }` (exit carries the id, never a sentinel). Session metadata caches `activeModeId` for O(1) `ensureAgent` resolve; `resolveActiveMode` is walk-form, only for branch init / consistency repair. Broadcasts `mode_event`; client uses `useActiveMode()`.
- Mode filtering is **tools + sections only**. Capability lifecycle hooks (`onConnect`, `afterToolExecution`, `httpHandlers`, `schedules`) keep firing. Excluded sections are flipped to `included: false` with `excludedReason: "Filtered by mode: <id>"` so the inspection panel can show why.
- `SubagentProfile` was removed. Subagent package imports `Mode`. Tool param `profile` → `mode`, broadcast `profileId` → `modeId`. No deprecation aliases — greenfield.

### Capabilities are the extension model

All extensions go through `Capability`. Stateless factories — receive `AgentContext`, return tools/prompts/hooks. No side effects in `tools()` or `promptSections()`. Registration order = hook execution order; each `beforeInference` receives the previous output.

`promptSections` may return bare strings (shorthand for included), `{ kind: "included", content, name? }`, or `{ kind: "excluded", reason, name? }`. Excluded entries are NOT in the LLM prompt — they exist for the inspection panel (e.g. skills capability returns excluded when cache empty). MUST be pure w.r.t. session state — runs at both inference and inspection time; branching on `sessionId` or reading storage causes drift.

### Session entries are an immutable append-log

Never mutate. Tree structure (`parent_id`) supports branching. Compaction entries are checkpoints; `buildContext()` walks leaf → most recent compaction boundary.

### Runtime-mutable state belongs in agent-level config / `ConfigStore` / `CapabilityStorage` — NEVER in `defineAgent` closures

The `defineAgent` closure wires the *set of capability types* (compile-time). Everything else (accounts, credentials, enabled flags, schedules, skill toggles, channel subs) is runtime-mutable. Never bake env-var-derived runtime state into a capability factory closure — forces redeploy per change.

**Prefer agent-level config:** capability exports a TypeBox schema (e.g. `TavilyConfigSchema`), consumer wires it into `defineAgent`'s `config` field, factory's `config` mapping declares which slice to inject as `context.agentConfig`. `config_set` validates, persists in `ConfigStore` under `agent:{namespace}`, mutates the snapshot, fires each mapped capability's `onAgentConfigChange`, broadcasts `capability_state { capabilityId: "agent-config", event: "update" }` for `useAgentConfig()`. References: `heartbeat`, `tavily-web-search`, `doom-loop-detection`, `tool-output-truncation`, `channel-telegram`.

**`CapabilityStorage`** remains right for state the capability alone owns — bulk lists (Telegram's `telegram-accounts`), encrypted blobs (bot tokens, credentials), things mutated through `configNamespaces` + `onAction` rather than a typed schema. Telegram channel combines both layers (rate-limit policy in agent config, account list in storage).

### Deployment values belong on the runtime context, not capability options

Where the agent is deployed (public URL, future: region, auth issuer) is deployment state. Lives on the runtime, surfaced identically on `AgentContext`, `CapabilityHookContext`, `CapabilityHttpContext`. Today: `publicUrl`. `AgentRuntime` reads `env.PUBLIC_URL` at construction (overridable via `AgentDefinition.publicUrl`), normalizes (trim, no trailing slash), propagates everywhere. Channels and webhook capabilities MUST read `ctx.publicUrl` — don't add a `publicUrl` option. If undefined, throw a clear error pointing at `PUBLIC_URL`.

### Transport protocol = discriminated unions

`ServerMessage` and `ClientMessage` discriminate on `type`. Server messages include `sessionId` except global broadcasts. Type values are snake_case (`agent_event`, `tool_event`) — matches pi-agent-core event types.

### Cost tracking

Capabilities emit costs via `context.emitCost({ capabilityId, toolName, amount, currency, detail?, metadata? })` AFTER successful paid API calls (not on error). `capabilityId` MUST match the capability's `id`. Use a named constant for amount (e.g. `TAVILY_SEARCH_COST_USD = 0.01`). Persisted as session entries with `customType: "cost"`, broadcast as `cost_event`.

## TypeScript Rules

- **No `any` in production code** (Biome enforced). Use `unknown` + narrowing. Exception: lazy-loaded pi-SDK in `agent-do.ts` (annotated). SQL row casts contained in `rowToSession`/`rowToEntry`. Tests exempt via biome.json overrides.
- **Imports:** libraries (`agent-runtime`, `compaction-summary`, …) use `.js` extensions in source (ESM resolution). Bundled apps (`agent-ui`, examples) skip them (Vite). `import type` / `export type` for type-only (Biome enforced).
- **Naming:** Types/components PascalCase. Functions/methods camelCase. Constants UPPER_SNAKE. Hooks `use*`. Capability IDs kebab-case.
- **Exports:** barrel via `index.ts`. Separate `export type` from `export`. Re-export upstream types consumers need (`AgentTool`, `AgentMessage`, …). Never export internal types (`McpConnection`, …).

## Hook Naming

- AgentDO lifecycle (framework calls): `on{Event}` — `onTurnEnd`, `onAgentEnd`, `onSessionCreated`
- Capability pipeline transforms: `before{Stage}` / `after{Stage}` — `beforeInference`, `afterToolExecution`
- React: `use{Thing}` — `useChatSession`, `useAgentConnection`

## Error Handling

- **Throw** on caller error (session not found, bad config)
- **Return `null`** when absence is normal (nothing to compact, no session yet)
- **Silent catch** only for fire-and-forget (WebSocket send to dead conn)
- Never catch just to log — handle meaningfully or propagate
- Client-bound errors use `ErrorMessage` with machine-readable `code`

## Configuration Defaults

Module-level named constants only — no inline magic numbers. `const DEFAULT_MAX_RECONNECT_DELAY = 30_000`. Config interfaces use optional fields with JSDoc documenting the default.

## Testing

- **Coverage thresholds (agent-runtime):** statements 98%, branches 90%, functions 100%, lines 99%. Excludes barrels, type-only files, test helpers, `agent-do.ts`, `agent-runtime.ts`, `runtime-delegating.ts`, `define-agent.ts`, `runtime-context-cloudflare.ts`, `mcp-manager.ts`.
- Integration tests run in Cloudflare Workers pool via `@cloudflare/vitest-pool-workers`. UI tests in jsdom. Test fixtures generated separately (`vitest.generate.config.ts`). No mocking `SessionStore` — real SQLite via Workers pool. Every public function needs at least one test.
- **Test helpers** at `@claw-for-cloudflare/agent-runtime/test-utils` (NOT the barrel): `createMockStorage()`, `textOf(result)`, `TOOL_CTX`.
- **DO test isolation:** `isolatedStorage` is **disabled** in `vitest.config.ts` — pool-workers' storage frame checker doesn't handle SQLite WAL `.sqlite-shm` files (cloudflare/workers-sdk#5629). Instead: **unique DO name per describe block** (`getStub("a2a-do-1")`). Never reuse names across blocks. Await all DO ops; drain fire-and-forget via `/wait-idle`. Keep DO count reasonable.
- File locations: `packages/runtime/agent-runtime/test/` (integration), `packages/*/*/src/**/__tests__/` (unit), `packages/ui/agent-ui/src/**/*.test.tsx` (components).

## Documentation Maintenance

When adding packages, capabilities, tools, or significant features, update both this file and `README.md`. CLAUDE.md: package list + architecture rules if a new pattern is introduced. README.md: packages table + quick start example if consumer API changes.

## Known Constraints

- **Lazy SDK imports:** pi-agent-core imports pi-ai which has a partial-json CJS issue in Workers test pool. The `loadPiSdk()` pattern in `agent-do.ts` is the workaround. Don't eager-import `pi-*` at module level.
- **Per-session Agent instances:** each session gets its own Agent in `sessionAgents` Map, created in `ensureAgent()`, cleaned up on `agent_end`. Allows concurrent inference across sessions in a single DO.
