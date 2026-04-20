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
  tavily-web-search      Web search/fetch via Tavily (shape-2: static + service/client/schemas)
  file-tools             Nine file_* tools backed by agentStorage (R2) (shape-2: static + service/client/schemas)
  vector-memory          Semantic memory (Vectorize + R2) (shape-2: static + service/client/schemas)
  browserbase            Browser automation via Browserbase (CDP + a11y snapshots)
  skills                 Skills capability (skill_load tool) (shape-2: static + service/client/schemas)
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
ui/            → runtime (only @crabbykit/agent-runtime)
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

**Three-package split:** `@crabbykit/bundle-sdk` holds the authoring API (`defineBundleAgent`, bundle context types, prompt builders, the runtime-source subpath that the host injects into compiled bundles). `@crabbykit/bundle-host` holds the host-side dispatcher, `SpineService`, `LlmService`, `InMemoryBundleRegistry`, the `bundle-builder` auto-rebuild path, and the mint-side token helpers (`mintToken`, `deriveMintSubkey`). `@crabbykit/bundle-token` is a tiny verify-only shared package (`verifyToken`, `NonceTracker`, `deriveVerifyOnlySubkey`, `BUNDLE_SUBKEY_LABEL`) imported by both halves. The SDK has zero path to the mint primitives by construction — a `vitest` assertion in `bundle-sdk/src/__tests__/mint-unreachable.test.ts` documents the invariant.

**Security:** single `__BUNDLE_TOKEN` per turn, HMAC-signed under `BUNDLE_SUBKEY_LABEL = "claw/bundle-v1"` via HKDF. Token payload carries `scope: string[]` derived from the validated capability catalog: `["spine", "llm", ...catalogIds]`. Each host service verifies with `requiredScope` — SpineService requires `"spine"`, LlmService requires `"llm"`, capability services require their own kebab-case id. `ERR_SCOPE_DENIED` is propagated intact through SpineService.sanitize. Reserved scope strings `"spine"` and `"llm"` are rejected at bundle build time and at registry promotion. Identity derived from verified token payload — bundles cannot forge. `globalOutbound: null` on the loader isolate blocks direct outbound. Provider credentials live in host-side `LlmService`/capability services, never bundle env.

**Spine dispatch mechanism.** `SpineService` bridges bundle RPC calls back to `AgentDO` via native DO method-call RPC on a typed `DurableObjectStub<SpineHost>` — there is no HTTP routing or `handleSpineRequest` switch. `AgentDO` structurally satisfies the `SpineHost` interface (enforced by a compile-time assertion in `agent-runtime/src/agent-do.ts`), so every `host.spineX(...)` call in `SpineService` is type-checked against a real method. Adding, renaming, or changing the signature of a spine method without updating both sides breaks the build at the point of the edit. Token verification, identity derivation, and error sanitization happen inside `SpineService` before the DO method is reached. SpineService constructs a `SpineCaller` context (`{aid, sid, nonce}`) from the verified token payload and passes it as the first argument to every spine method. Per-turn budget enforcement lives in `AgentRuntime` (the DO), not in `SpineService` — the DO has stable per-agent state that survives across the full turn lifetime, whereas `WorkerEntrypoint` instances may be recycled between RPC calls, which would silently reset an in-service budget counter. Each spine method on `AgentRuntime` wraps its body through `withSpineBudget(caller, category, fn)` which calls `spineBudget.check(caller.nonce, category)` before executing. The `BudgetTracker` class remains in `bundle-host/src/budget-tracker.ts`.

**Capability service pattern (for capabilities holding secrets):** four subpaths — `index` (legacy static), `service` (host WorkerEntrypoint with credentials), `client` (bundle-side proxy — imports types from `@crabbykit/bundle-sdk`), `schemas` (shared tool schemas). Tavily was the pilot. `skills`, `vector-memory`, and `file-tools` now ship shape-2 subpaths too — each exposes its service via a worker service binding on the consumer and the bundle wires a client that proxies tool calls over RPC with the unified `__BUNDLE_TOKEN` (scope must include the capability id).

**Host hook-bus bridge (afterToolExecution + beforeInference).** Two `SpineHost` methods — `spineRecordToolExecution` and `spineProcessBeforeInference` — run the host's existing `afterToolExecutionHooks` and `beforeInferenceHooks` chains against bundle-originated events. `SpineService` exposes them as bundle-callable RPCs (`recordToolExecution`, `processBeforeInference`) under `requiredScope: "spine"`; the bundle SDK calls them via `context.hookBridge`. Bundle SDK runtime awaits `processBeforeInference` before each model call and uses the returned message array. Budget categories `hook_after_tool` (cap 200) and `hook_before_inference` (cap 100) bound runaway bundles. Purpose: capability authors register `afterToolExecution`/`beforeInference` once and the hook fires for both static and bundle brains — auto-reindexing (`vector-memory`), UI mutation broadcast (`file-tools`), loop detection (`doom-loop-detection`), output truncation (`tool-output-truncation`), and skill conflict injection (`skills`) all work identically across the two runtimes. Shape-2 capability clients therefore ship with no `afterToolExecution`/`beforeInference` hooks of their own — hooks stay on the static factory.

**Capability catalog.** Bundles declare host-side capability dependencies via `requiredCapabilities: [{ id: "tavily-web-search" }, ...]` on `defineBundleAgent`. The declaration is kebab-case-ids only, input-validated at build time (charset, length, count), persisted into `BundleMetadata`, and surfaced on the bundle's `/metadata` endpoint. `BundleRegistry.setActive` validates the declaration against the caller-supplied `knownCapabilityIds` by default and throws `CapabilityMismatchError` (code `"ERR_CAPABILITY_MISMATCH"`) on mismatch — the pointer is NOT flipped. A dispatch-time guard inside `AgentDO.initBundleDispatch` (and on `BundleDispatcher`) handles out-of-band writes, cold-start stale pointers, and host redeploys: mismatch clears the pointer via `setActive(..., null, { skipCatalogCheck: true })`, broadcasts a `bundle_disabled` event with structured `reason.code = "ERR_CAPABILITY_MISMATCH"` + `missingIds`, and falls back to static. Catalog failures do NOT count toward `maxLoadFailures`. Cross-deployment promotions pass `skipCatalogCheck: true` explicitly (workshop_deploy exposes it as a tool input). Bundles published before this change have `requiredCapabilities: undefined` and bypass validation — re-publish with an explicit declaration to opt in.

**Bundle pointer cache is single-writer.** Hot-path cache at `ctx.storage.activeBundleVersionId` avoids per-turn D1 read. Written ONLY inside `define-agent.ts`'s `_initBundleDispatch` closure (its `bundlePointerRefresher` plus inline writes on `/bundle/disable` and auto-revert). Any in-process code that mutates `bundle-registry.setActive(...)` for an agent on the same DO MUST follow with `await ctx.notifyBundlePointerChanged()` — workshop tools are the canonical example. Skipping it = deployed bundle silently never runs.

**Out-of-band mutations** (admin scripts, other workers, direct DB writes) MUST POST `/bundle/refresh` on the agent's HTTP surface. In-process: `notifyBundlePointerChanged`. Out-of-process: `/bundle/refresh`. Two channels, no third.

**Bundle runtime v2 (bundle-runtime-surface).** Bundle brain runs at functional parity with the static brain across four axes:

1. *Tool execution.* `runBundleTurn` invokes `setup.tools(env)` and `setup.capabilities(env)` once per turn, advertises the merged tool list to the LLM (OpenAI/OpenRouter `tool_calls` shape), parses streamed tool calls (provider-agnostic — own narrow parsers in `bundle-sdk/src/providers/`; pi-ai's parsers couple too tightly to the openai SDK + partial-json CJS to vendor), executes each tool against the `BundleContext`, runs bundle-side `BundleCapability.hooks.afterToolExecution` (registration order, BEFORE the host bridge), then `hookBridge.recordToolExecution`. Re-runs inference until non-toolUse stop reason or the per-turn cap of 25 iterations. Bundles with neither `setup.tools` nor `setup.capabilities` follow the existing v1 text-only fast path. Sequential-only execution; parallel tool-call execution is a v2.1 follow-up.

2. *Prompt sections.* `BundleCapability.promptSections` accepts `Array<string | BundlePromptSection | PromptSection>`. `normalizeBundlePromptSection` converts each entry into a full `PromptSection` with source attribution (`{ type: "custom" }` for bare strings, `{ type: "capability", capabilityId, capabilityName }` for `BundlePromptSection` / full `PromptSection`). The dispatcher writes a per-turn version-keyed snapshot to the inspection cache via `spine.recordPromptSections(sessionId, sections, bundleVersionId)`. Read-side spine method `getBundlePromptSections(sessionId, bundleVersionId?)` reads under the new `"inspection"` budget category. Storage lives in `KvStore` under reserved capability id `_bundle-inspection`, key `prompt-sections:<sessionId>:v=<bundleVersionId>`. Eviction on session-delete via `evictBundleInspectionForSession`.

3. *Lifecycle hooks.* `BundleAgentSetup` exposes three optional top-level fields: `onAlarm` (per-due-schedule, awaited with 5s timeout, `{ skip, prompt }` return — bundle's return wins on conflict over static `onScheduleFire`'s; either side's skip wins), `onSessionCreated` and `onClientEvent` (fire-and-forget, return ignored). Each handler receives an event-scoped context (`BundleAlarmContext` / `BundleSessionContext` / `BundleClientEventContext`) with a thin `BundleSpineClientLifecycle` (`appendEntry`, `getEntries`, `buildContext`, `broadcast`) — `hookBridge` intentionally excluded (turn-loop concept). `BundleMetadata.lifecycleHooks` declares which endpoints the bundle implements; the host skips Worker Loader instantiation for hooks the bundle didn't declare.

4. *Mode awareness.* `BundleContext.activeMode` exposes `{ id: string; name: string }` (no allow/deny lists — defense in depth). At dispatch the host resolves the active Mode via `runtime.readActiveModeForSession`, projects to `__BUNDLE_ACTIVE_MODE = { id, name, tools, capabilities }`, and injects into the bundle env. The bundle SDK applies the filter inside the isolate: `capabilities.allow/deny` drops the entire capability (tools + sections + hooks); `tools.allow/deny` filters by tool name across the merged list; the inspection cache marks dropped sections with `excludedReason: "Filtered by mode: <id>"`. Decision 14 ordering: `setup.prompt: string` suppresses sections FIRST, mode filter applies to the residual. One-time structured warning per `(agentId, bundleVersionId)` on first dispatch under any active mode (persistent flag at `bundle:mode-warning-emitted:<aid>:<vid>`).

The dispatcher injects `__BUNDLE_TOKEN`, `__BUNDLE_VERSION_ID`, `__BUNDLE_PUBLIC_URL` (when host has `PUBLIC_URL` set), and (when active) `__BUNDLE_ACTIVE_MODE` into the bundle env every turn. The bundle SDK reads these to enforce token verification, version-keyed inspection cache writes, mode filtering, and `BundleHttpContext.publicUrl` / `BundleActionContext.publicUrl` propagation.

**Bundle HTTP and UI surface (`bundle-http-and-ui-surface`).** `BundleCapability` advertises two additional fields:

5. *HTTP routes.* `BundleCapability.httpHandlers: (ctx) => BundleHttpHandler[]` — same `{ method, path, handler }` shape as the static `Capability.httpHandlers`. Methods limited to `GET/POST/PUT/DELETE`. Reserved prefixes (`/bundle/`, `/a2a`, `/a2a-callback`, `/.well-known/`, `/__`, `/mcp/`, `/schedules`) and reserved literals (`/`, `/prompt`, `/schedules`) are rejected at `defineBundleAgent` evaluation time. The host walks `setup.capabilities(probeEnv)` once at build time and persists the declared method+path tuples into a NEW top-level `BundleMetadata.surfaces.httpRoutes` field — separate from `lifecycleHooks` to avoid the requirement-shape collision with `bundle-runtime-surface`'s spec. Dispatch chain: `validateAuth` → static `matchHttpHandler` → bundle dispatcher → 404. The bundle dispatcher is NOT installed onto `preFetchHandler` — that would silently bypass auth (Decision 9). Body cap defaults to 256 KiB (`BundleConfig.maxRequestBodyBytes`, hard-capped at 1 MiB; 413 on exceed). Per-dispatch timeout defaults to 30 000 ms (`BundleConfig.httpDispatchTimeoutMs`; 504 on expiry). Streaming is a documented Non-Goal — bundle authors who need it return 202 + a job id and stream output via `channel.broadcast`.

6. *UI bridge actions.* `BundleCapability.onAction: (action, data, ctx) => Promise<void>`. Receives `BundleActionContext` carrying `capabilityId`, `agentId`, `sessionId`, `kvStore`, `channel`, `spine` lifecycle client, `publicUrl?`, `emitCost`. Reserved capability ids `agent-config`, `schedules`, `queue` are rejected at `defineBundleAgent` time (the host's built-in switch always wins). Promotion-time + dispatch-time guards reject ids that collide with host-registered capability ids (`ERR_ACTION_ID_COLLISION`). Dispatch chain: resolved static `onAction` → host built-in switch → bundle dispatcher → warn-log default.

`sendPrompt` is intentionally NOT exposed on `BundleHttpContext` / `BundleActionContext` in v1 — see proposal Non-Goals. Bundle authors who need to trigger a prompt from a webhook return the prompt text in the response body and let the upstream caller route it through `/prompt`. `sessionStore` raw access, `rateLimit`, and `agentConfig` are documented v1 parity gaps; their absence is honest, not silently broken.

`bundle_disabled` reason codes: `ERR_CAPABILITY_MISMATCH` (catalog), `ERR_HTTP_ROUTE_COLLISION` (route declared by bundle overlaps host static handler at promotion or dispatch time), `ERR_ACTION_ID_COLLISION` (action id declared by bundle overlaps host capability id), `ERR_AGENT_CONFIG_COLLISION` (bundle agent-config namespace shadows host-declared namespace), `ERR_CONFIG_NAMESPACE_COLLISION` (bundle custom configNamespace id shadows host namespace), `ERR_CAPABILITY_CONFIG_COLLISION` (bundle declares config schema for a host-registered capability id — would dual-write `config:capability:{id}`), `ERR_AGENT_CONFIG_PATH_UNRESOLVABLE` (bundle capability's `agentConfigPath` first segment resolves in neither bundle nor host schemas). All seven clear the pointer with `skipCatalogCheck: true`, broadcast structured reason, and fall back to static. **Lifecycle hook failures (`/after-turn`, `/on-connect`, `/dispose`, `/on-turn-end`, `/on-agent-end`) do NOT trigger any `bundle_disabled` code and do NOT increment `consecutiveFailures` — observation-only paths; retries could double-fire side effects.**

**Bundle config (`bundle-config-namespaces`).** Bundles get the same three-layer config model as static. Three NEW top-level `BundleMetadata` fields extracted at `defineBundleAgent` build time:

1. `capabilityConfigs: Array<{ id, schema, default? }>` — per-capability config schemas + optional defaults. Surfaced host-side via `getBundleCapabilityConfigStandIns()` — synthetic `Capability` stand-ins carrying ONLY `id`, `name`, `description`, `configSchema`, `configDefault`. Exposed to the config tools (`config_get` / `config_set` / `config_schema`) by composing `ConfigContext.capabilities` as `[...getCachedCapabilities(), ...standIns]` at the SINGLE call site that builds `ConfigContext`. **NOT merged into `getCachedCapabilities()`** — would leak phantom capabilities into prompt resolution, hook iteration, MCP merging, schedule enumeration, and the inspection panel (Decision 9).
2. `agentConfigSchemas: Record<string, TObject>` — agent-level namespaces declared via `BundleAgentSetup.config: { ns: schema, ... }`. Merged with host `getAgentConfigSchema()` in `getCachedAgentConfigSchema()`; host wins on key conflict (defense in depth — promotion-time guard rejects collisions).
3. `configNamespaces: Array<{ id, description, schema }>` — custom namespaces declared by each `BundleCapability.configNamespaces(ctx)` factory. Only the metadata projection is emitted; `get`/`set` stay in bundle code and execute via cross-isolate RPC to the bundle's `/config-namespace-get` / `/config-namespace-set` endpoints.

**`agentConfigPath` replaces `agentConfigMapping` for bundles.** Static `Capability.agentConfigMapping: (snapshot) => slice` is a function — cannot serialize. Bundle `BundleCapability.agentConfigPath: string` is a dotted-path expression the host evaluates via `evaluateAgentConfigPath(snapshot, path)`. Safe-traversal: missing intermediate segments return `undefined` rather than throwing. **Bundle authors MUST handle `ctx.agentConfig === undefined` defensively.**

**Schema serialization (Decision 1).** TypeBox schemas carry a `Symbol(TypeBox.Kind)` marker that drops on JSON round-trip, breaking `Value.Check`. `defineBundleAgent` walks each schema with `serializeBundleSchema` to mirror the symbol onto a plain enumerable `Kind` string property BEFORE emission into metadata; the host calls `hydrateBundleSchema` to restore the symbol when it loads metadata via `bundlePointerRefresher`. Transform / Constructor / Function `Kind`s are rejected at build time — their runtime closures (`Decode`/`Encode`, constructor refs, callable refs) cannot survive JSON round-trip and would silently drop behavior host-side.

**Config hook ordering matches static exactly.** `onConfigChange` fires BEFORE `ConfigStore.setCapabilityConfig` in `config/config-set.ts`. On `{ok: false, error}` return from `bundleConfigChangeDispatcher`, the tool returns the error and persistence is SKIPPED. `onAgentConfigChange` fires AFTER `applyAgentConfigSet` persists — handler errors are logged but do not reverse persistence.

**`BundleConfig.configHookTimeoutMs`** (default 5 000 ms) bounds each bundle config dispatch separately from the 30 000 ms `httpDispatchTimeoutMs` — config UX expects sub-second feedback.

**Reserved agent-config keys.** `config:agent:__orphans` is a framework-managed record. When `ensureAgentConfigLoaded` reads a persisted `config:agent:{ns}` value that no longer validates against the currently-active schema (bundle declared the namespace, then was disabled by collision with a newly-deployed host static namespace using a different schema), the snapshot is set to `Value.Create(currentSchema)` (the default) AND the raw payload is appended to `config:agent:__orphans` as `{ persistedValue, recordedAt: ISO8601, schemaCheckFailed: true }`. The persisted value is NEVER deleted — operator can roll back the host change and re-promote the bundle to recover (Decision 10).

**Pattern-matched configNamespaces are deferred.** Only `prompt-scheduler`'s `schedule:{id}` uses pattern-matched namespaces today; regex serialization across the isolate boundary is non-trivial. Bundle authors must use a single namespace with structured value (e.g. `{ schedules: { [id]: {...} } }`) in v1.

**Cross-deployment promotion.** `BundleRegistry.setActive` accepts `knownAgentConfigNamespaces`, `knownConfigNamespaceIds`, `knownCapabilityConfigIds` alongside the existing `knownCapabilityIds` and `knownHttpRoutes`. Each is the host's currently-resolved snapshot; passing `undefined` skips the corresponding promotion-time collision check (dispatch-time guard still fires). `workshop_deploy` forwards all four by default via the runtime-context accessors `getBundleHostCapabilityIds()`, `getBundleHostAgentConfigNamespaces()`, `getBundleHostConfigNamespaceIds()`. The capability-config collision check is **distinct** from the `requiredCapabilities` catalog check — same host snapshot, different metadata axis.

**Shared envelope plumbing.** `composeWorkerLoaderConfig` in `bundle-host/src/loader-config.ts` is the single helper every dispatch path (turn, lifecycle, http, action) calls to build the Worker Loader config. Drift between dispatch paths is now structurally impossible — adding a new path means calling this helper or breaking the build. `serializeRequestForBundle` / `deserializeResponseFromBundle` / `serializeActionForBundle` in `bundle-host/src/serialization.ts` cover the JSON envelope shapes for `/http` and `/action`. `BundleDispatcher.dispatchClientEvent` was refactored onto the helper as the prerequisite for `bundle-lifecycle-hooks`; all dispatch paths now share the same envelope decode + env composition.

**Bundle lifecycle hooks (`bundle-lifecycle-hooks`).** Five new capability-author-facing parity hooks match the static surface and cross the isolate boundary over the established JSON envelope:

1. *Per-capability* — `BundleCapability.afterTurn?(ctx, sessionId, finalText)`, `BundleCapability.hooks.onConnect?(ctx)`, `BundleCapability.dispose?()`. Match static `Capability.afterTurn` / `Capability.hooks.onConnect` / `Capability.dispose` semantics. Per-cap errors are caught and logged; one failing handler never blocks siblings.
2. *Setup-level* — `BundleAgentSetup.onTurnEnd?(messages, toolResults)` and `BundleAgentSetup.onAgentEnd?(messages)`. Match static `AgentDelegate.onTurnEnd` / `onAgentEnd`. Setup-level; no capabilityId.

Endpoints on the bundle fetch surface: `POST /after-turn`, `POST /on-connect`, `POST /dispose`, `POST /on-turn-end`, `POST /on-agent-end`. `BundleMetadata.lifecycleHooks` carries five new boolean flags (`afterTurn`, `onConnect`, `dispose`, `onTurnEnd`, `onAgentEnd`) populated at `defineBundleAgent` build time by walking `setup.capabilities(probeEnv)` and checking `setup.{onTurnEnd,onAgentEnd}` presence. Host (via the five new callback wirings in `agent-do.ts`) consults `BundleDispatcher.getActiveLifecycleFlags()` BEFORE instantiating the Worker Loader — zero overhead for bundles that did not declare the hook. **Mode-filter caveat:** a bundle whose only `afterTurn`-declaring capability is filtered out by the active mode still incurs the dispatch cost at runtime. Build-time aggregation does not account for dispatch-time mode filtering. The "zero overhead" claim applies at build time, not after mode filtering.

**Ordering invariants.** `afterTurn` is awaited INSIDE `dispatchAfterTurn` — the static per-cap walk completes first, then the bundle dispatch fires inside the same `waitUntil`-tracked promise. For `dispose` / `onConnect` / `onTurnEnd` / `onAgentEnd`, the static delegate is KICKED OFF first (non-awaited, with `.catch`) and the bundle dispatch is queued as a SEPARATE `runtimeContext.waitUntil(...)` registration plus `pendingAsyncOps` add — they run concurrently from the caller's perspective. Bundle authors needing to observe pre-`agent_end`-broadcast state must use `beforeInference` or interpose at the static turn loop, not `afterTurn` (which runs AFTER the final `agent_end` broadcast).

**`dispose` is session-less.** Dispatch envelope carries `{agentId}` only — no `sessionId`. `BundleDisposeContext` omits `sessionId`, `channel`, `emitCost`, `agentConfig`. Session-scoped spine methods (`appendEntry`, `getEntries`, `buildContext`, `broadcast`, etc.) throw `ERR_SESSION_REQUIRED` (new `SpineErrorCode`) when called from a dispose handler. Bundle authors needing cleanup persistence use `ctx.kvStore` (capability-scoped, agent-level, not session-scoped).

**Token mint extension for session-less dispatch.** `mintToken` payload `sid` is now `string | null`. `SpineService.verify` returns a `SpineCaller` with `sid: string | null`; every session-scoped spine method's first-line `requireSession(caller)` helper throws `ERR_SESSION_REQUIRED` when `caller.sid === null`. Verify-side: `TokenPayload` accepts both legacy `sessionId: string` (one release cycle) and new `sid: string | null` so bundle-SDK / host can roll independently.

**Per-handler timeout.** `BundleConfig.lifecycleHookTimeoutMs` (default 5 000 ms, matches `configHookTimeoutMs`) bounds each dispatch via `Promise.race`. On timeout, the host logs `outcome: "timeout"` and the event proceeds; Worker Loader fetch is NOT cancelled (Workers runtime constraint). The 30 000 ms `httpDispatchTimeoutMs` does NOT apply to lifecycle hooks.

**`onTurnEnd` `toolResults` are projected host-side.** `event.toolResults` from agent-core may contain functions, class instances, or stream readers that do not cross the isolate boundary. `projectToolResultsForBundle` in `bundle-host/src/serialization.ts` reduces each entry to `BundleToolResult { toolName, args, content, isError }`. Non-projectable entries are replaced with `{toolName: "unknown", args: null, content: "<projection failed>", isError: true}` and emit `outcome: "tool_result_projection_failed"` per entry — never silently dropped.

**Fresh context types, not `BundleHookContext` extensions.** `BundleAfterTurnContext`, `BundleOnConnectContext`, `BundleDisposeContext`, `BundleTurnEndContext`, `BundleAgentEndContext` are five NEW types that do NOT extend `BundleHookContext` and do NOT carry `hookBridge` — reusing the turn-loop bridge here would generate phantom `recordToolExecution` events. Documented v1 parity gaps relative to static `AgentContext`: no `schedules`, `rateLimit`, `requestFromClient`, `broadcastToAll`, `notifyBundlePointerChanged`. Bundle authors needing them have alternatives (bundle-side `ctx.scheduler`, `ctx.channel.broadcast`, etc.).

**Telemetry.** Every lifecycle dispatch emits `[BundleDispatch]` with `kind: "lifecycle_after_turn" | "lifecycle_on_connect" | "lifecycle_dispose" | "lifecycle_on_turn_end" | "lifecycle_on_agent_end"` and `outcome: "ok" | "timeout" | "error" | "tool_result_projection_failed"`. Error messages truncated to 500 chars.

### Modes are the scoping mechanism

A `Mode` is a named filter over tools + prompt sections. SDK answer to tool overload. Imports live ONLY at `@crabbykit/agent-runtime/modes`:

```ts
import { defineMode, planMode, filterToolsAndSections, applyMode, resolveActiveMode, type Mode, type AppliedMode } from "@crabbykit/agent-runtime/modes";
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
- **Test helpers** at `@crabbykit/agent-runtime/test-utils` (NOT the barrel): `createMockStorage()`, `textOf(result)`, `TOOL_CTX`.
- **DO test isolation:** `isolatedStorage` is **disabled** in `vitest.config.ts` — pool-workers' storage frame checker doesn't handle SQLite WAL `.sqlite-shm` files (cloudflare/workers-sdk#5629). Instead: **unique DO name per describe block** (`getStub("a2a-do-1")`). Never reuse names across blocks. Await all DO ops; drain fire-and-forget via `/wait-idle`. Keep DO count reasonable.
- File locations: `packages/runtime/agent-runtime/test/` (integration), `packages/*/*/src/**/__tests__/` (unit), `packages/ui/agent-ui/src/**/*.test.tsx` (components).

## Documentation Maintenance

When adding packages, capabilities, tools, or significant features, update both this file and `README.md`. CLAUDE.md: package list + architecture rules if a new pattern is introduced. README.md: packages table + quick start example if consumer API changes.

## Known Constraints

- **Lazy SDK imports:** pi-agent-core imports pi-ai which has a partial-json CJS issue in Workers test pool. The `loadPiSdk()` pattern in `agent-do.ts` is the workaround. Don't eager-import `pi-*` at module level.
- **Per-session Agent instances:** each session gets its own Agent in `sessionAgents` Map, created in `ensureAgent()`, cleaned up on `agent_end`. Allows concurrent inference across sessions in a single DO.
