# CLAW for Cloudflare

Open-source SDK for building AI agents on Cloudflare Workers.

## What This Is

CLAW is a **framework**, not an application. It provides the primitives for building conversational AI agents that run on Cloudflare's edge infrastructure. Consumers extend `AgentDO`, register capabilities, and get a production-ready agent with persistent sessions, real-time streaming, tool execution, and a composable React UI — without building the plumbing themselves.

The SDK is designed to be applied back to [gia-cloud](../gia-cloud) (where it originated) and open-sourced for general use.

## What the SDK Provides Today

### Runtime (`packages/agent-runtime`)
- **AgentDO base class** — Durable Object that consumers extend. Handles WebSocket lifecycle, session management, LLM inference loop, and tool execution. Consumers implement `getConfig()`, `getTools()`, `buildSystemPrompt()`, and optionally `getCapabilities()`.
- **Session store** — Immutable append-log backed by DO SQLite. Supports branching (parent_id tree), compaction checkpoints, and context rebuilding.
- **Capability system** — Extension model for adding tools, prompt sections, MCP servers, schedules, and lifecycle hooks. Each capability gets scoped persistent KV storage.
- **Tool system** — `defineTool()` with TypeBox schema validation. Tools return structured `content` + `details`.
- **Compaction engine** — Token estimation, cut-point selection, staged summarization, emergency truncation. Used by the compaction-summary capability.
- **Scheduling** — Cron-based schedule store with prompt and callback schedule types. Agents can create/update/delete schedules via `context.schedules`.
- **MCP client** — Connect to external MCP servers, surface their tools alongside native tools.
- **Cost tracking** — `context.emitCost()` persists costs as session entries and broadcasts to clients in real time.
- **Transport protocol** — Discriminated union messages over WebSocket. Session sync, agent events, tool events, cost events, schedule lists, MCP status.

### UI (`packages/agent-ui`)
- **Composable React components** — MessageList, Message, ChatInput, StatusBar, SessionList, SystemPromptPanel, SkillPanel, ChannelsPanel, etc. All use `data-agent-ui` attribute selectors for styling isolation. Components read from the connection context via the decomposed hooks below — there is no global "ChatProvider" / `useChat` shim.
- **Connection provider + decomposed hooks** (all exported from `@claw-for-cloudflare/agent-runtime/client`) — `AgentConnectionProvider` owns the WebSocket, reconnect, and reducer state. Consumers wrap their tree once, then children pull the slices they need: `useChatSession` (messages, send/steer/abort, agentStatus, thinking, costs, error), `useSessions` (list + switch/create/delete), `useSchedules`, `useSkills`, `useCommands`, `useQueue`, `useSystemPrompt`, `useAgentConnection` (raw `send`, `connectionStatus`, `state`, `dispatch`, `onSessionSwitch`). Capability-specific UI hooks (e.g. `useTelegramChannel`) read directly from `useAgentConnection().state.capabilityState` and send `capability_action` via the provider's `send`.
- **Markdown rendering** — Lightweight built-in renderer (no external deps). Code blocks, formatting, links, lists.

### Capability Packages
- **`packages/compaction-summary`** — LLM-based conversation compaction. Configurable provider/model.
- **`packages/tavily-web-search`** — Web search + fetch tools via Tavily API. Emits costs.
- **`packages/prompt-scheduler`** — Exposes schedule management as agent tools (create/update/delete/list schedules).
- **`packages/r2-storage`** — R2-backed file storage capability. Provides 9 tools: file_read, file_write, file_edit, file_delete, file_copy, file_move, file_list, file_tree, file_find. Path validation, namespace isolation via configurable prefix.
- **`packages/vector-memory`** — Semantic memory search using Cloudflare Vectorize + R2. Auto-indexes markdown files, uses Workers AI embeddings, falls back to keyword search.
- **`packages/sandbox`** — Controlled shell execution with elevation model. Tools: elevate, de_elevate, exec, process (poll/log/write/kill/list/remove), save_file_credential, list_file_credentials, delete_file_credential. Auto-deactivates after idle timeout.
- **`packages/cloudflare-sandbox`** — Sandbox provider implementation for Cloudflare Containers. Proxies sandbox operations to a Container DO via HTTP.
- **`packages/vibe-coder`** — Live app preview capability. Provides 3 tools: show_preview, hide_preview, get_console_logs. Proxies dev server traffic through the container, injects console capture script, retrieves logs from the browser via client round-trip.
- **`packages/container-db`** — Tiny client library for container apps providing `env.DB`-compatible interface over `http://db.internal`. Used by vibe-coded apps for database access that works in both dev (container) and deploy (worker).
- **`packages/browserbase`** — Browser automation capability via Browserbase. Provides 8 tools: browser_open, browser_navigate, browser_snapshot, browser_screenshot, browser_click, browser_type, browser_close, browser_clear_state. Lightweight CDP client over WebSocket, accessibility tree snapshots with ref-based element selection, hybrid state management (BB Contexts + cookie merge), cost tracking.
- **`packages/channel-telegram`** — Reference Telegram channel built via `defineChannel`. Constant-time secret verification, dual-bucket rate limiting (per-sender + per-account Sybil guard), chunked outbound with 5-message cap, bot-token redaction on every error path, and group-chat collapse to a single session keyed by `group:<chatId>` with per-member attribution preserved in the stashed inbound.

### Skills Packages
- **`packages/skill-registry`** — D1-backed skill registry with `SkillRegistry` interface. Stores skill metadata, content, and version info. Supports self-seeding from a skill definitions array on startup.
- **`packages/skills`** — Skills capability for on-demand procedural knowledge. Syncs from registry, stores enabled skills in R2, provides `skill_load` tool for loading SKILL.md into agent context. Three-scenario sync (new, update-clean, update-dirty), dirty tracking at mutation time via afterToolExecution hook, and conflict resolution for agent-modified skills with upstream updates.

### Task & Subagent Packages
- **`packages/task-tracker`** — DAG-based task management capability. SQLite-backed task store with dependency graph, ready-work computation, session ownership, and 6 tools (task_create, task_update, task_close, task_ready, task_tree, task_dep_add).
- **`packages/subagent`** — Same-DO child agent spawning capability. Blocking and non-blocking execution modes with steer-or-prompt dual-path result delivery. SubagentHost interface, PendingSubagentStore, event forwarding, and 4 tools (call_subagent, start_subagent, check_subagent, cancel_subagent).
- **`packages/subagent-explorer`** — Pre-built explorer subagent profile. Read-only codebase search with configurable model override and tool filtering.

### Agent Operations Packages
- **`packages/a2a`** — Agent-to-Agent protocol (A2A v1.0). Task store, handler, executor, and tools (call_agent, start_task, check_task, cancel_task).
- **`packages/agent-fleet`** — Fleet management capability. Create/list/delete child agents via D1 registry.
- **`packages/agent-peering`** — Peer-to-peer agent communication via HMAC-signed tokens.
- **`packages/agent-registry`** — D1-backed agent registry for discovery and metadata.
- **`packages/agent-auth`** — Authentication utilities for agent HTTP endpoints.
- **`packages/agent-storage`** — Shared storage identity (R2 bucket + namespace prefix) passed to r2-storage, vector-memory, and cloudflare-sandbox.
- **`packages/credential-store`** — Secure credential storage capability for managing API keys and secrets.
- **`packages/heartbeat`** — Periodic heartbeat capability with configurable interval.
- **`packages/vite-plugin`** — Vite plugin for CLAW development (bundled into container images).

### Bundle Brain Override Packages
- **`packages/agent-bundle`** — Bundle authoring API (`defineBundleAgent`), `BundleEnv` type constraint, small async bundle runtime, `SpineService` WorkerEntrypoint (bridges bundle RPC to DO's sync stores), `LlmService` (multi-provider LLM proxy with credential isolation), capability token mint/verify/HKDF utilities, `InMemoryBundleRegistry` for tests.
- **`packages/bundle-registry`** — D1-backed bundle version store with content-addressed IDs (SHA-256), KV bundle bytes storage, KV readback verification on deploy, atomic `setActive`/`rollback` via `db.batch()`, self-seeding migration, append-only deployment audit log.
- **`packages/agent-workshop`** — Agent-facing capability with 7 tools: `workshop_init`, `workshop_build`, `workshop_test`, `workshop_deploy`, `workshop_disable`, `workshop_rollback`, `workshop_versions`. Self-editing deploys by default (safe because static brain is always the fallback). Per-agent deploy rate limiting.

### Internal Packages (not published)
- **`packages/agent-core`** — Fork of pi-agent-core. The LLM agent loop (inference, tool calls, streaming).
- **`packages/ai`** — Fork of pi-ai. Model provider abstraction (OpenRouter, Anthropic, etc.).

## Project Structure

```
packages/agent-runtime     — Core runtime (DO base class, sessions, capabilities, transport)
packages/agent-ui          — React chat components (Radix UI based)
packages/agent-core        — LLM agent loop (forked from pi-agent-core)
packages/ai                — Model provider abstraction (forked from pi-ai)
packages/compaction-summary — Compaction capability
packages/tavily-web-search — Web search capability
packages/prompt-scheduler  — Schedule management capability
packages/r2-storage        — R2 file storage capability
packages/vector-memory     — Semantic memory search (Vectorize + R2)
packages/sandbox           — Shell execution with elevation model
packages/cloudflare-sandbox — Sandbox provider for Cloudflare Containers
packages/vibe-coder        — Live app preview with console capture
packages/browserbase        — Browser automation via Browserbase (CDP + snapshots)
packages/agent-bundle       — Bundle authoring + host dispatch + security tokens
packages/bundle-registry    — D1/KV bundle version store
packages/agent-workshop     — Agent-facing bundle authoring tools
packages/channel-telegram   — Telegram channel (reference implementation of defineChannel)
packages/task-tracker       — DAG-based task management (deps, ready-work)
packages/subagent           — Same-DO child agent spawning
packages/subagent-explorer  — Pre-built explorer subagent profile
packages/container-db       — DB client for containers (db.internal)
packages/skill-registry     — D1-backed skill registry with self-seeding
packages/skills             — Skills capability (on-demand procedural knowledge)
packages/a2a                — Agent-to-Agent protocol (A2A v1.0)
packages/agent-fleet        — Fleet management (create/list child agents)
packages/agent-peering      — Peer-to-peer agent communication
packages/agent-registry     — D1-backed agent registry
packages/agent-auth         — Authentication utilities
packages/agent-storage      — Shared R2 storage identity
packages/credential-store   — Secure credential storage capability
packages/heartbeat          — Periodic heartbeat capability
packages/vite-plugin        — Vite plugin for CLAW dev (bundled into containers)
examples/basic-agent        — Full-stack example (Vite + Cloudflare Worker)
e2e/agent-runtime           — E2E tests (pool-workers + wrangler dev w/ containers)
```

## Commands

```bash
bun install              # Install dependencies
bun run test             # Run all tests across workspaces
bun run typecheck        # TypeScript check across workspaces
bun run lint             # Biome lint + format check
bun run lint:fix         # Auto-fix Biome issues
bun run format           # Format all files
```

Package-level:
```bash
cd packages/agent-runtime && bun test           # Runtime tests (Workers pool)
cd packages/agent-runtime && bun test:coverage  # With coverage thresholds
cd examples/basic-agent && bun dev              # Dev server
```

E2E tests:
```bash
cd e2e/agent-runtime && bun test                # Pool-workers tests (fast, sub-second)
cd e2e/agent-runtime && bun run test:dev        # Wrangler dev tests (real containers, ~40s)
```

## Debugging the Example App

The basic-agent example (`examples/basic-agent`) includes a debug/inspection API and an interactive CLI for observing agent behavior and simulating tool calls without LLM inference. Start the dev server with `cd examples/basic-agent && bun dev`.

### Debug CLI (`claw`)

The `claw` CLI is an interactive REPL for the debug API. Set it up once:

```bash
cd examples/basic-agent && bun link   # Registers the `claw` command globally
```

Then with the dev server running, use it from any terminal:

```bash
claw                        # Connect to localhost:5173 (default)
claw --url=http://host:port # Connect to a custom server
```

**Commands:**
```
agents                    List agents (auto-selects if only one)
use <id>                  Set active agent
sessions                  List sessions
session <id>              Set active session
messages [limit]          Show messages (default: 20)
prompt <text>             Send a prompt (alias: p)
tools                     List available tools
tool <name> [json-args]   Execute a tool (alias: t)
broadcast <event> [json]  Broadcast a custom event (alias: bc)
status                    Show current agent/session/server
```

**Example session:**
```
claw> sessions
claw> session Oq_mDM-g1pXuoB-Qjp3FL
claw> messages
claw> prompt what time is it?
claw> messages
claw> tool get_current_time
claw> tools
```

The CLI auto-discovers agents on startup, tracks the active session across commands, and filters out thinking blocks from message output.

### Debug HTTP API

The CLI wraps these HTTP endpoints, which can also be called directly. All endpoints are under `/agent/:agentId/debug/...`. Get the agent ID from `GET /agents`.

- `GET /debug/sessions` — List all sessions
- `GET /debug/messages?sessionId=...&limit=50&afterSeq=...` — Paginated message history
- `POST /debug/prompt` — Send a prompt (`{"text": "...", "sessionId": "..."}`)
- `POST /debug/execute-tool` — Execute a tool (`{"toolName": "...", "args": {...}, "sessionId": "..."}`)
- `POST /debug/broadcast` — Broadcast event (`{"event": "...", "data": {...}}`)

### Implementation

The debug system has three parts, all in the example app (not the runtime):
- `examples/basic-agent/cli/index.ts` — Interactive REPL CLI wrapping the debug HTTP API
- `examples/basic-agent/src/debug-capability.ts` — Capability with HTTP handlers for inspection endpoints (sessions, messages, prompt, broadcast)
- `examples/basic-agent/src/worker.ts` — `BasicAgent.fetch()` override for `/debug/execute-tool`, using `this.resolveToolsForSession(sessionId)` for tool resolution

### Limitations

- Tool simulation persists entries and broadcasts `tool_event` messages, but the UI won't stream them live unless a WebSocket client is connected to that session. Switching to the session in the UI triggers a `session_sync` which loads all entries.
- The `calculate` tool uses `Function()` which is blocked in Workers — use other tools for testing.

## Bundle Brain Override in basic-agent

The basic-agent example includes full bundle brain override support. The agent can author, build, and deploy bundles to itself at runtime via the workshop tools.

### How to use bundles in basic-agent

1. Start the dev server: `cd examples/basic-agent && bun dev`
2. Open the UI and send a prompt — the static brain responds
3. Ask the agent to create a bundle: *"Create a bundle called my-brain that adds a current_time tool"*
4. The agent runs `workshop_init` → edits `src/index.ts` → `workshop_build` → `workshop_test` → `workshop_deploy`
5. On the next turn, the bundle brain handles the prompt instead of the static brain
6. To revert: ask the agent to run `workshop_disable`, or call `POST /bundle/disable` directly

### Bundle tools available

| Tool | Purpose |
|------|---------|
| `workshop_init` | Scaffold a new bundle workspace in the sandbox |
| `workshop_build` | Compile with `bun build --target=browser --format=esm` |
| `workshop_test` | Validate the built bundle |
| `workshop_deploy` | Register as active brain (self-editing by default) |
| `workshop_disable` | Revert to static brain |
| `workshop_rollback` | Swap to previous version |
| `workshop_versions` | List deployment history |

### Wrangler bindings required

- `BUNDLE_DB`: D1 database for bundle registry
- `BUNDLE_KV`: KV namespace for bundle bytes
- `AGENT_AUTH_KEY`: HMAC secret for capability tokens
- `SPINE_SERVICE`, `LLM_SERVICE`: Service bindings for bundle RPC

### Standalone demo

A minimal standalone demo exists at `examples/bundle-agent-phase2/` with an InMemoryBundleRegistry and curl-based workflow — see its README for details.

## Tech Stack

- **Runtime**: Cloudflare Workers + Durable Objects + SQLite
- **Frontend**: React 19 + Vite 6
- **Testing**: Vitest with @cloudflare/vitest-pool-workers (runtime), jsdom (UI)
- **Package manager**: Bun with workspaces
- **Linting/Formatting**: Biome (configured in biome.json)
- **Schema validation**: TypeBox (@sinclair/typebox)
- **AI SDK**: @mariozechner/pi-agent-core + pi-ai

## Architecture Rules

### Bundle brain override — opt-in per-agent runtime override via Worker Loader

`defineAgent` accepts an optional `bundle` config field. When omitted, the agent is purely static — no new code paths. When present, the agent gains the ability to dispatch turns into a registry-backed bundle loaded via Worker Loader.

**How it works:** On each turn, if a bundle is registered for the agent, the DO mints an HMAC capability token, loads the compiled bundle via `LOADER.get(versionId, factory)`, and dispatches the turn into the bundle's `POST /turn` endpoint. The bundle runs its own small async runtime, calls back to the DO via `SpineService` for state operations (session store, KV, transport, cost emission), and streams agent events back. If no bundle is registered (or the bundle fails to load), the static brain runs unchanged.

**Security model:** Per-turn HMAC tokens with HKDF-derived per-service subkeys. Bundles cannot forge identity — every SpineService/LlmService/capability-service method derives identity from the verified token payload. `globalOutbound: null` on the loader isolate prevents bundles from making direct outbound network calls. Provider credentials live in host-side `LlmService`/capability services, never in bundle env.

**Capability service pattern:** Capability packages that hold secrets expose four subpaths: `index` (legacy static, unchanged), `service` (host WorkerEntrypoint with credentials), `client` (bundle-side proxy), `schemas` (shared tool schemas). Tavily is the pilot implementation.

**Self-editing is safe by default:** `workshop_deploy` targets the invoking agent's own bundle pointer. The static brain (defined at compile time via `defineAgent` fields) is always the fallback — disabling the bundle reverts to it.

### Modes are the scoping mechanism

A `Mode` is a named filter over the agent's tool surface and prompt that can be activated for a single session (or used to spawn a subagent). Modes are the SDK's answer to "tool overload" — agents with 30+ tools across many capabilities suffer real selection-accuracy degradation, and modes let consumers expose a small, focused subset (planning, research, vibe-dev, …) without rewriting the agent.

**Where it lives.** All mode primitives live at the subpath `@claw-for-cloudflare/agent-runtime/modes`. Import surface:

```ts
import {
  defineMode,
  planMode,
  filterToolsAndSections, // low-level pure filter (used by packages/subagent)
  applyMode,              // high-level wrapper (used by ensureAgent)
  resolveActiveMode,      // walk-form helper (branch init / consistency repair)
  type Mode,
  type AppliedMode,
} from "@claw-for-cloudflare/agent-runtime/modes";
```

Nothing mode-related is exported from the main `@claw-for-cloudflare/agent-runtime` barrel — agents that don't use modes never import the file.

**Two slots on `defineAgent`.** `modes: () => Mode[]` registers session-level modes (for `/mode <id>` and `enter_mode` / `exit_mode`). `subagentModes: () => Mode[]` registers modes used to spawn subagents via `call_subagent` / `start_subagent`. The same `Mode` constant may appear in both slots. The slot is named `subagentModes` (not the shorter `subagents`) so `getSubagentModes()` can't be confused with "return the subagent instances themselves." Both slots default to `[]`.

**Conditional registration is gated on `>= 1` modes.** With 0 modes, `/mode`, `enter_mode`, `exit_mode`, and the "current mode" prompt indicator are NOT registered — an agent without modes is byte-identical to a pre-feature agent. With 1+ modes the machinery turns on: even a single registered mode yields two effective states ("in the mode" vs "out of the mode, null") so the toggle is meaningful. (The original spec gated at `>= 2`; we relaxed it after building the example and realizing the "enter vs exit" toggle is the point.)

**`defineMode()` rejects conflicting allow + deny.** A `Mode.tools` or `Mode.capabilities` filter may set `allow` OR `deny`, never both. Setting both throws at factory time — there is no resolution rule to remember.

**Mode-change events are first-class.** Mode transitions are recorded as `mode_change` session entries with payload `{ enter: id }` or `{ exit: id }` (the exit variant carries the mode id being exited, never a boolean sentinel — so post-hoc reconstruction of mode history is local). The session metadata row caches `activeModeId` so `ensureAgent` resolves the active mode in O(1) without walking the entry log; the walk-form `resolveActiveMode` exists only for branch initialization and consistency repair. Transitions broadcast a `mode_event` server message and are surfaced on the client via `useActiveMode()` (a decomposed selector hook on the connection provider's reducer state).

**Mode filtering is tools + sections only.** Capability lifecycle hooks (`onConnect`, `afterToolExecution`, `httpHandlers`, `schedules`) keep firing regardless of the active mode — modes are a session-level concept, not a capability lifecycle concern. Excluded capability sections are not dropped; they're flipped to `included: false` with `excludedReason: "Filtered by mode: <id>"` so the rich-prompt-inspection panel can show *why* a section is missing.

**Bundle dispatch path is NOT mode-aware in v1.** The bundle prompt handler short-circuits before `ensureAgent`, so `applyMode` doesn't run for bundle turns. The static brain remains the authoritative fallback. Wiring host-side mode filtering into the bundle dispatch payload is a v1.1 follow-up.

**`SubagentProfile` was removed.** The subagent package now imports `Mode` (re-exported from `@claw-for-cloudflare/agent-runtime/modes`). Tool parameter `profile: string` → `mode: string`, broadcast field `profileId` → `modeId`, `PendingSubagent.profileId` → `modeId`. `packages/subagent-explorer`'s factory now returns `Mode` and uses `tools: { allow }` instead of `tools: string[]`; the factory name (`explorer`) is unchanged. No deprecation aliases — the SDK is greenfield.

### Capabilities are the extension model

All agent extensions go through the `Capability` interface. Capabilities are stateless factories — they receive `AgentContext`, return tools/prompts/hooks. No side effects in `tools()` or `promptSections()`.

Registration order determines hook execution order. Each `beforeInference` hook receives the output of the previous one.

`promptSections` may return a mix of bare strings (shorthand for an included section), `{ kind: "included", content, name? }`, and `{ kind: "excluded", reason, name? }`. Excluded entries are NOT part of the prompt the LLM sees — they exist only so the inspection panel can surface "why isn't my-capability contributing here?" (e.g. skills capability returns `{ kind: "excluded", reason: "No skills enabled" }` when its cache is empty). `promptSections` must be pure with respect to session state — it runs at both inference and inspection time, so branching on `sessionId` or reading storage will cause drift.

### Session entries are an immutable append-log

Never mutate existing entries. The tree structure (parent_id) supports branching. Compaction entries act as checkpoints — `buildContext()` walks from leaf to the most recent compaction boundary.

### Runtime-mutable capability state belongs in agent-level `config` / `ConfigStore` / `CapabilityStorage`, not `defineAgent` closures

The `defineAgent` closure wires the *set of capability types* that exist in the code — that's genuinely compile-time. Everything else a human operator or the agent itself needs to tune at runtime (accounts, credentials, enabled flags, schedules, skill toggles, channel subscriptions) belongs in the runtime-mutable layer below and is exposed to both the agent and the UI through the unified config surface. Never bake env-var-derived runtime state into a capability factory's closure — it forces a redeploy for every change.

Prefer the **agent-level config** path for new capabilities: the capability exports a TypeBox schema (e.g. `TavilyConfigSchema`), the consumer wires it into `defineAgent`'s `config` field, and the capability factory's `config` mapping parameter tells the runtime which slice of the agent config to inject as `context.agentConfig`. Mutations via `config_set` validate against the schema, persist in `ConfigStore` under `agent:{namespace}`, mutate the snapshot in place, fire each mapped capability's `onAgentConfigChange` hook, and broadcast a `capability_state { capabilityId: "agent-config", event: "update" }` message the client's `useAgentConfig()` hook subscribes to. Reference migrations: `packages/heartbeat`, `packages/tavily-web-search`, `packages/doom-loop-detection`, `packages/tool-output-truncation`, `packages/channel-telegram`.

Per-capability `CapabilityStorage` remains the right place for state the capability alone owns — notably: bulk lists (Telegram's `telegram-accounts`), encrypted blobs (bot tokens, credentials), and state the agent must mutate through `configNamespaces` + `onAction` rather than a typed schema. The Telegram channel (`packages/channel-telegram`) is the reference implementation of this pattern and also shows how to combine both layers: rate-limit policy moves to agent-level config; the account list stays in `CapabilityStorage`.

### Deployment-level values belong on the runtime context, not in capability options

Values that describe *where the agent is deployed* (public base URL, future peers: region, auth issuer, …) are deployment state, not capability config. They live on the runtime and are surfaced identically on `AgentContext`, `CapabilityHookContext`, and `CapabilityHttpContext` so every capability can read them without demanding its own option.

Today the one value wired this way is `publicUrl`. `AgentRuntime` reads it from `env.PUBLIC_URL` at construction time (overridable via `AgentDefinition.publicUrl` on `defineAgent`), normalizes it (trimmed, no trailing slash), and propagates it to every capability context. Channels and other capabilities that register external webhooks MUST read `ctx.publicUrl` — don't add a new `publicUrl` option to your capability factory. If a capability needs the URL and it's undefined, throw a clear error that points the operator at `PUBLIC_URL`.

### Transport protocol uses discriminated unions

All messages (both `ServerMessage` and `ClientMessage`) discriminate on the `type` field. Server messages include `sessionId` except for global broadcasts. Protocol types use snake_case for `type` values (e.g., `agent_event`, `tool_event`) — this is intentional and matches the underlying event types from pi-agent-core.

### `defineAgent()` is the primary consumer API

`defineAgent({ model, prompt, tools, capabilities, ... })` returns a
Durable Object class directly. All fields are flat and optional except
`model`. Fields that need env access accept either a literal or a
function of `env` / `setup` — see `README.md` for the full field reference.
This is the blessed path for new agents.

### Three-layer architecture: `defineAgent` → `AgentDO` → `AgentRuntime`

- **`AgentRuntime<TEnv>`** (`src/agent-runtime.ts`): platform-agnostic
  business logic — session management, LLM loop, capabilities,
  scheduling, A2A, HTTP routing. Zero imports from `cloudflare:workers`.
  Takes abstract `SqlStore` / `KvStore` / `Scheduler` / `Transport` /
  `RuntimeContext` adapters via its constructor.
- **`AgentDO<TEnv>`** (`src/agent-do.ts`): thin Cloudflare shell. Extends
  `DurableObject`, constructs CF adapters, holds `cfTransport` directly,
  and delegates `fetch` / `alarm` / `webSocketMessage` / `webSocketClose`
  to the composed runtime via `createDelegatingRuntime`. Remains
  available as the escape hatch for advanced consumers.
- **`defineAgent<TEnv>()`** (`src/define-agent.ts`): returns an anonymous
  class extending `AgentDO` that forwards each delegate method to the
  flat definition. Builds the `AgentSetup` once at construction time.

`createDelegatingRuntime(host, adapters)` (`src/runtime-delegating.ts`)
is the shared helper that wires a host object implementing
`AgentDelegate` into an anonymous `AgentRuntime` subclass.

### Subclassing AgentDO (escape hatch)

Consumers who need direct `this.ctx` / `this.env` access or bespoke
constructor logic can still `class MyAgent extends AgentDO<Env>`. The
public override surface:
- Abstract: `getConfig()`, `getTools(ctx)`
- Optional overrides: `buildSystemPromptSections(ctx)` (preferred, returns
  `PromptSection[]` with source attribution and included/excluded flags),
  `buildSystemPrompt(ctx)` (@deprecated string-returning form — kept for
  back-compat; the runtime wraps its output in a single "custom" section
  when the section-returning method wasn't also overridden),
  `getPromptOptions()`, `getCapabilities()`, `getModes()`,
  `getSubagentModes()`, `getConfigNamespaces()`, `getA2AClientOptions()`,
  `getCommands(ctx)`, `getAgentOptions()`
- Lifecycle hooks: `validateAuth?`, `onTurnEnd?`, `onAgentEnd?`,
  `onSessionCreated?`, `onScheduleFire?`

The override methods are **public** on `AgentDO` (not `protected`) so
that `createDelegatingRuntime` can see them structurally through the
`AgentDelegate` interface. When upgrading existing subclasses, drop
the `protected` modifier.

#### Protected members for subclasses and test helpers

AgentDO exposes the runtime's state via protected getters/setters so
legacy access patterns like `this.sessionStore` still work:
- Field getters: `sessionStore`, `scheduleStore`, `configStore`,
  `mcpManager`, `taskStore`, `queueStore`, `kvStore`, `scheduler`,
  `transport`, `sessionAgents`, `pendingAsyncOps`, `beforeInferenceHooks`
  (get/set), `beforeToolExecutionHooks` (get/set),
  `afterToolExecutionHooks` (get/set), `resolvedCapabilitiesCache`
  (get/set), `capabilitiesCache` (get/set), `connectionRateLimits`,
  `scheduleCallbacks`, `timerOwners`, `capabilityDisposers` (get/set)
- Method delegators: `buildScheduleManager()`, `handlePrompt()`,
  `handleSteer()`, `handleCostEvent()`, `handleAgentEvent()`,
  `transformContext()`, `syncCapabilitySchedules()`,
  `handleAgentPrompt()`, `resolveToolsForSession()`,
  `getCachedCapabilities()`
- For test subclasses that override the LLM loop, define
  `ensureAgent(sessionId)` as a method on your subclass — the
  delegating runtime will pick it up via duck typing.

## TypeScript Rules

### No `any` in production code (enforced by Biome)

- Use `unknown` + type guards or type narrowing instead of `any`
- Exception: the lazy-loaded pi-SDK pattern in `agent-do.ts` — annotated with comment explaining why
- SQL row conversions use `as` casts in `rowToSession`/`rowToEntry` — this is the boundary, keep casts contained there
- Tests are exempt from `noExplicitAny` (configured in biome.json overrides)

### Import conventions

- **Libraries** (`agent-runtime`, `compaction-summary`): Use `.js` extensions in imports (required for ESM resolution)
- **Bundled apps** (`agent-ui`, `examples`): No extensions needed (Vite handles resolution)
- Use `import type` for type-only imports (enforced by Biome `useImportType`)
- Use `export type` for type-only re-exports (enforced by Biome `useExportType`)

### Naming conventions (enforced by Biome)

- Types/interfaces: PascalCase (`AgentConfig`, `SessionEntry`)
- Functions/methods: camelCase (`buildContext`, `defineTool`)
- Constants: UPPER_SNAKE_CASE (`SAFETY_MARGIN`, `DEFAULT_BASE_CHUNK_RATIO`)
- React components: PascalCase (`MessageList`, `ChatInput`)
- Hooks: `use` prefix (`useChatSession`, `useSessions`, `useTelegramChannel`)
- Capability IDs: kebab-case (`"compaction-summary"`)

### Export conventions

- Barrel exports via `index.ts` in each package
- Separate `export type { ... }` from `export { ... }`
- Re-export upstream types consumers need (AgentTool, AgentMessage, etc.) from the main package
- Never export internal implementation types (McpConnection, etc.)

## Error Handling Rules

- **Throw** when a caller passed invalid input (session not found, bad config)
- **Return `null`** when absence is a normal outcome (nothing to compact, no session yet)
- **Silent catch only** for fire-and-forget (WebSocket send to a dead connection)
- Never catch an error just to log it — either handle it meaningfully or let it propagate
- Error messages sent to clients use `ErrorMessage` with a machine-readable `code` field

## Cost Tracking

Capabilities that incur per-call costs (paid APIs, metered services) emit costs via `context.emitCost()`. The framework handles persistence (as custom session entries) and real-time broadcast (as `cost_event` transport messages).

### How to emit costs

In a capability's `tools(context)` factory, pass `context` to tool creators. In the tool's `execute` function, call `context.emitCost()` after a successful paid API call:

```ts
context.emitCost({
  capabilityId: "my-capability",  // Must match the capability's id field
  toolName: "my_tool",            // The tool that incurred the cost
  amount: 0.01,                   // Monetary amount
  currency: "USD",                // ISO 4217 currency code
  detail: "Human-readable note",  // Optional
  metadata: { key: "value" },     // Optional
});
```

### Rules

- Only emit costs for paid external API calls, not free operations
- Emit after successful execution, not on error (don't charge for failed calls)
- Use a named constant for the cost amount (e.g., `TAVILY_SEARCH_COST_USD = 0.01`)
- The `capabilityId` must match the capability's `id` field
- Costs are persisted as custom session entries with `customType: "cost"` and broadcast as `cost_event` messages

## Testing Rules

### Coverage thresholds (agent-runtime)

- Statements: 98%, Branches: 90%, Functions: 100%, Lines: 99%
- Coverage excludes: index.ts barrel files, type-only files, test helpers, agent-do.ts (DO lifecycle), agent-runtime.ts (extracted runtime — unit backfill is tech debt), runtime-delegating.ts, define-agent.ts, runtime-context-cloudflare.ts, mcp-manager.ts (external SDK)

### Test patterns

- Integration tests run in Cloudflare Workers pool via `@cloudflare/vitest-pool-workers`
- UI tests run in jsdom
- Test fixtures are generated separately (`vitest.generate.config.ts`)
- No mocking of `SessionStore` — test against real SQLite via Workers pool
- Every public function must have at least one test

### Shared test helpers

`packages/agent-runtime/src/test-utils.ts` exports helpers for capability/tool tests. Import via the package exports path — **not** via the barrel:

```ts
import { createMockStorage, textOf, TOOL_CTX } from "@claw-for-cloudflare/agent-runtime/test-utils";
```

- `createMockStorage()` — in-memory `CapabilityStorage` (get/put/delete/list)
- `textOf(result)` — extract `.text` from the first content block of a tool result
- `TOOL_CTX` — minimal `ToolExecuteContext` for `tool.execute()` calls

### DO integration test isolation

`isolatedStorage` is **disabled** in `vitest.config.ts` for `agent-runtime`. The pool-workers runner's storage frame checker doesn't handle SQLite WAL auxiliary files (`.sqlite-shm`) created by DO KV storage operations, causing spurious `AssertionError` crashes during suite teardown (see cloudflare/workers-sdk#5629).

Instead, tests isolate via **unique DO names per describe block** (e.g., `getStub("a2a-do-1")`, `getStub("a2a-do-2")`). Each DO name maps to a separate SQLite database in a temporary directory that is wiped per test run. Rules:

- **Use a unique DO name per describe block.** Tests within the same block can share a stub but tests in different blocks must use different names.
- **Never reuse DO names across describe blocks.** State written by one block's tests is visible to another block sharing the same name.
- **Await all DO operations.** Fire-and-forget async operations (like the A2A callback handler's `handleAgentPrompt`) must be tracked and drained before the test ends. Use the `/wait-idle` test endpoint to drain pending ops.
- **Keep DO count reasonable.** Each unique name creates a separate SQLite database. Avoid creating dozens of DOs per test file.

### Test file locations

- `packages/agent-runtime/test/` — integration tests
- `packages/agent-runtime/src/*/__tests__/` — unit tests colocated with source
- `packages/agent-ui/src/**/*.test.tsx` — component tests

## Hook Naming Conventions

- **AgentDO lifecycle overrides** (called by framework): `on{Event}` — `onTurnEnd`, `onAgentEnd`, `onSessionCreated`
- **Capability hooks** (transform data in pipeline): `before{Stage}` / `after{Stage}` — `beforeInference`
- **React hooks** (standard React): `use{Thing}` — `useChatSession`, `useAgentConnection`

## Configuration Defaults

- Extract defaults to module-level named constants: `const DEFAULT_MAX_RECONNECT_DELAY = 30_000`
- Config interfaces use optional fields with JSDoc documenting the default value
- Never inline magic numbers — always use a named constant

## Documentation Maintenance

When adding new packages, capabilities, tools, or significant features to the SDK, update both this file (CLAUDE.md) and README.md to reflect the changes. Specifically:

- **CLAUDE.md**: Add new packages to "What the SDK Provides Today" and "Project Structure". Update architecture rules if new patterns are introduced.
- **README.md**: Add new packages to the packages table. Update the quick start example if the consumer API changes.

## Known Constraints

- **Lazy SDK imports**: pi-agent-core imports pi-ai which has a partial-json CJS issue in Workers test pool. The `loadPiSdk()` pattern in `agent-do.ts` is a workaround. Don't eager-import pi-* at module level.
- **Per-session Agent instances**: Each session gets its own Agent instance (stored in `sessionAgents` Map), created fresh in `ensureAgent()` and cleaned up on `agent_end`. This allows multiple sessions to run inference concurrently within a single DO.
