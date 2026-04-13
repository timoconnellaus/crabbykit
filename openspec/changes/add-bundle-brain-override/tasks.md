## 1. Phase 0 — Spikes (gating)

### 1A. pi-agent-core import inside loader isolate

- [x] 1.1 Create a throwaway worker `spike/pi-import/` with `worker_loaders` binding and a minimal WorkerEntrypoint host
- [x] 1.2 Hand-write a minimal bundle that does `import { AgentRuntime } from "@claw-for-cloudflare/agent-runtime"` and logs `typeof AgentRuntime`
- [x] 1.3 Compile the bundle with `bun build --target=browser --format=esm --outfile=bundle.js`
- [x] 1.4 Load the compiled bundle via `LOADER.get(...)` and invoke its default fetch handler
- [x] 1.5 Verify the import resolves without hitting the pi-agent-core partial-json CJS issue or other transitive failures
- [x] 1.6 Record findings: import chain status, any required upstream fixes, baseline bundle size

### 1B. Cold-start latency baseline

- [x] 1.7 Compile a representative bundle: pi-agent-core + pi-ai + 2-3 capabilities (compaction, prompt-scheduler) inlined via `bun build`
- [x] 1.8 Measure the compiled bundle size in bytes
- [x] 1.9 Measure cold-load latency: time from `LOADER.get(newKey, factory)` to first successful `getEntrypoint().fetch()` response on a fresh isolate
- [x] 1.10 Compare against a static `AgentDO` instantiation cold start under `wrangler dev`
- [x] 1.11 Record numbers as the Phase 2 reference baseline

### 1C. Read-only mount feasibility on Cloudflare Containers

- [x] 1.12 Create a small spike that updates the existing SandboxContainer Dockerfile to mount a directory read-only
- [x] 1.13 Verify that writes to the read-only path produce EROFS or equivalent inside the running container
- [x] 1.14 If read-only mount is unsupported, document the alternate (per-build integrity verification only) and accept the smaller TOCTOU window
- [x] 1.15 Record outcome and impact on Phase 5 task design

### 1D. Phase 0 decision checkpoint

- [x] 1.16 Aggregate spike results into `openspec/changes/add-bundle-brain-override/phase-0-results.md`
- [x] 1.17 Decision: green outcomes proceed to Phase 1; red outcomes scope the appropriate remediation before continuing

## 2. Phase 1 — packages/agent-bundle core

### 2A. Capability token utilities

- [x] 2.1 Create `packages/agent-bundle/src/security/capability-token.ts`
- [x] 2.2 Implement `mintToken({agentId, sessionId, ttlMs}, key)` returning `base64url(payload).base64url(signature)` using HMAC-SHA256 via Web Crypto SubtleCrypto
- [x] 2.3 Implement `verifyToken(token, subkey)` with constant-time comparison and explicit return shape `{aid, sid, exp, nonce} | null`
- [x] 2.4 Implement `deriveSubkey(masterKey, label)` via HKDF — used at host startup to compute per-service verify-only subkeys
- [x] 2.5 Implement nonce tracking helper with bounded LRU and TTL eviction
- [x] 2.6 Unit tests: roundtrip mint+verify, expired rejection, tampered payload rejection, tampered signature rejection, wrong subkey rejection, replay rejection, HKDF subkey distinctness

### 2B. Bundle authoring API and small async runtime

- [x] 2.7 Create `packages/agent-bundle` with `package.json`, `tsconfig.json`, `src/index.ts`, `src/bundle/`, `src/host/`
- [x] 2.8 Implement `defineBundleAgent<BundleEnv>(setup)` in `src/bundle/define.ts`
- [x] 2.9 Define `BundleEnv` constraint type that excludes native binding types and accepts only `Service<T>` + serializable values
- [ ] 2.10 Type-level tests: `interface E extends BundleEnv { AI: Ai }` fails to compile; `interface E extends BundleEnv { LLM: Service<unknown> }` succeeds; `interface E extends BundleEnv { TIMEZONE: string }` succeeds
- [x] 2.11 Define the bundle default-export contract: fetch handler discriminating on `/turn`, `/client-event`, `/alarm`, `/session-created`, `/smoke`, `/metadata`
- [x] 2.12 Implement `SessionStoreClient` async interface (bundle-side, not the static SessionStore — distinct types in distinct files)
- [x] 2.13 Implement `KvStoreClient`, `SchedulerClient` async interfaces (bundle-side)
- [x] 2.14 Implement `SessionChannel` send-only interface — `broadcast`, `broadcastGlobal`; explicitly no callback methods
- [x] 2.15 Implement bundle-side `CapabilityHookContext` with async `sessionStore`, `kvStore`, etc. — distinct from the static-agent hook context type
- [x] 2.16 Implement bundle-side small runtime that constructs per turn from a token, verifies the token, builds adapter clients, runs the inference loop, returns `AsyncIterable<AgentEvent>` (as a `ReadableStream` body)
- [x] 2.17 Bundle subpath export from `@claw-for-cloudflare/agent-bundle/bundle` that exposes `defineBundleAgent`, `defineTool`, `Type`, the bundle hook context types — but NOT `LlmService`, `SpineService`, or any host-side WorkerEntrypoint
- [x] 2.18 Add `package.json` `exports` rules that physically separate bundle-authoring entry from host-side entry
- [x] 2.19 Unit tests: bundle constructs runtime, runs a simple turn against a fake spine, returns stream of events
- [ ] 2.20 Integration test: hand-compiled bundle loaded via Worker Loader handles a turn against an in-process mock SpineService

## 3. Phase 2 — bundle field on defineAgent + SpineService bridge

### 3A. SpineService and bridge methods

- [x] 3.1 Create `packages/agent-bundle/src/host/spine-service.ts` exposing `SpineService extends WorkerEntrypoint<SpineEnv>`
- [x] 3.2 SpineService methods take `token: string` as first argument; first action is `verifyToken` against the HKDF-derived spine subkey from `this.env`
- [x] 3.3 Identity (agentId, sessionId) for all session-scoped operations is derived from the verified token payload — no method takes a sessionId argument
- [x] 3.4 Implement session store RPC methods: `appendEntry(token, entry)`, `getEntries(token, options)`, `getSession(token)`, `createSession(token, init)`, `listSessions(token, filter)`, `buildContext(token)`, `getCompactionCheckpoint(token)`
- [x] 3.5 Each method calls into the host DO (via DO namespace binding) which then calls the existing sync `sessionStore.*` methods
- [x] 3.6 Implement KV store RPC methods: `kvGet`, `kvPut`, `kvDelete`, `kvList` — bridging to the DO's existing sync `kvStore`
- [x] 3.7 Implement scheduler RPC methods: `scheduleCreate`, `scheduleUpdate`, `scheduleDelete`, `scheduleList`, `alarmSet`
- [x] 3.8 Implement transport-out RPC methods: `broadcast(token, event)`, `broadcastGlobal(token, event)` — bridging to existing `Transport.broadcast` / `broadcastGlobal`
- [x] 3.9 Implement `emitCost(token, costEvent)` — costEvent has no sessionId; identity from token; bridges to existing cost emission flow
- [x] 3.10 Per-turn budget enforcement in SpineService: counters per token nonce, configurable defaults (100 SQL, 50 KV, 200 broadcasts, 5 alarms), atomic via DO storage transaction or in-isolate counter
- [x] 3.11 Unit tests for each spine method — fake DO target, verify token verification, identity derivation, signature mismatch rejection
- [x] 3.12 Unit tests for budget enforcement — sequential and parallel call patterns

### 3B. defineAgent gains optional bundle field

- [x] 3.13 In `packages/agent-runtime/src/define-agent.ts`, add an optional `bundle?: BundleConfig<TEnv>` field on the `AgentSetup` type
- [x] 3.14 Define `BundleConfig<TEnv>` type with `registry`, `loader`, `authKey`, `bundleEnv` factory functions
- [x] 3.15 Verify that adding the field is backwards-compatible: existing static agents that omit it must compile and behave identically
- [x] 3.16 In the `defineAgent` factory, if `bundle` is set, attach a small dispatcher to the returned DO class
- [x] 3.17 The dispatcher hooks into `AgentDO.handleTurn` (or equivalent) with a check at the top: `if (this.bundleConfig && await this.hasActiveBundle()) { return this.runBundleTurn(prompt); } return this.runStaticTurn(prompt); /* existing code */`
- [x] 3.18 Implement `hasActiveBundle()`: read `ctx.storage.activeBundleVersionId`; on miss, query `bundle.registry.getActiveForAgent(agentId)` and cache the result
- [x] 3.19 Implement `runBundleTurn(prompt)`:
  - Mint a capability token using the host DO's master `AGENT_AUTH_KEY`
  - Read bundle bytes from the registry's KV
  - Invoke `LOADER.get(activeVersionId, factory)` where factory returns the modules + bundleEnv (with token under `__SPINE_TOKEN`)
  - Call `worker.getEntrypoint().fetch("https://bundle/turn", { method: "POST", body: JSON.stringify({prompt}) })`
  - Consume the returned `ReadableStream` of agent events; for each event, persist via existing sync `SessionStore` and forward via existing `Transport`
- [x] 3.20 Implement auto-revert: if loader factory throws or `/turn` returns load error on N consecutive calls (default N=3), call `bundle.registry.setActive(agentId, null)`, log poison-bundle deployment row, fall through to `runStaticTurn`
- [x] 3.21 Implement `webSocketMessage` extension: on incoming client message during a bundle turn, call `worker.getEntrypoint().fetch("https://bundle/client-event", { ... })` with a fresh token
- [x] 3.22 Implement `POST /bundle/disable` HTTP endpoint on the DO at the DO level (NOT routed through the bundle), authenticated via existing agent-auth, clears the active version pointer
- [x] 3.23 The DO reserves `/bundle/*` paths and never forwards them to a bundle
- [x] 3.24 Per-entry bundle version tagging: when the dispatcher persists an entry produced by a bundle turn, the DO stamps `bundleVersionId: <hash>` on the entry's metadata. When persisting from a static turn, the DO stamps `bundleVersionId: "static"`.
- [x] 3.25 Unit tests: dispatch check short-circuits when `bundle` config is absent (no overhead); dispatch correctly handles active bundle path; auto-revert kicks in after N failures; static brain runs after revert
- [ ] 3.26 Integration test: a `defineAgent`-produced DO with bundle config loads a hand-compiled bundle and runs a turn end-to-end; verify token is minted, spine RPCs are made, entries are persisted, events are broadcast, cost emission works

### 3C. Phase 1 → Phase 2 milestone demo

- [x] 3.27 Create `examples/bundle-agent-phase2/` with one bundle-enabled `defineAgent` and a hand-written/hand-compiled bundle
- [x] 3.28 Demo script: start `wrangler dev`, the example uses an inline test fallback registry pointing at a file-loaded bundle, send a prompt via curl, see a response via the bundle path
- [ ] 3.29 Verify spine RPC calls in DO logs: token verification, entry appends, transport broadcasts
- [x] 3.30 Document the demo in `examples/bundle-agent-phase2/README.md`
- [x] 3.31 Measure: cold-load latency, per-turn RPC count, total turn latency vs the static `examples/basic-agent` baseline
- [x] 3.32 **Phase 2 decision gate**: if loader latency > 3× static latency, stop and add batching to spine clients before continuing to Phase 3

## 4. Phase 3 — LlmService and Tavily capability service pilot

### 4A. LlmService

- [x] 4.1 Create `packages/agent-bundle/src/host/llm-service.ts` with `LlmService extends WorkerEntrypoint<LlmEnv>`
- [x] 4.2 LlmEnv includes its HKDF-derived verify-only subkey, plus `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, native `AI` binding, and a `SPINE` service binding
- [x] 4.3 `infer(token, request)` verifies token first via the spine-derived subkey; rejects on bad token
- [x] 4.4 OpenRouter branch — fetch to OpenRouter API using `this.env.OPENROUTER_API_KEY`
- [x] 4.5 Anthropic branch — direct Anthropic API
- [x] 4.6 OpenAI branch — direct OpenAI API
- [x] 4.7 Workers AI branch — `this.env.AI.run(...)`
- [x] 4.8 Unknown-provider branch returns structured error without echoing upstream response or credential state
- [x] 4.9 Wrap all provider calls in try/catch; sanitize errors to whitelisted error codes + generic messages; never forward upstream response bodies; never forward stack traces
- [x] 4.10 Tool-call request support — accept tool schemas, return tool-call responses in compatible shape
- [x] 4.11 Streaming response support via `ReadableStream` return value
- [x] 4.12 Per-agent inference rate limiting (default 100 calls/min per token-derived agentId)
- [x] 4.13 Cost emission — call `env.SPINE.emitCost(token, ...)` on success with `capabilityId: "llm-service"`, `toolName: "infer"`, computed amount
- [x] 4.14 Bundle-side `ServiceLlmProvider` adapter in `packages/agent-bundle/src/bundle/llm/` — implements bundle runtime's LLM provider interface, RPCs to `env.LLM_SERVICE` with `env.__SPINE_TOKEN`
- [x] 4.15 Bundle runtime selects `ServiceLlmProvider` automatically when `model()` returns `{ provider, modelId }` without `apiKey`
- [x] 4.16 Make `apiKey` a compile-time error in bundle-side `model` type — type-level enforcement via the bundle subpath's restricted `ModelConfig` type
- [ ] 4.17 Unit tests for each provider branch with credential redaction assertions
- [ ] 4.18 Integration test: bundle declaring `model: { provider: "openrouter", modelId: "..." }` runs a complete tool-calling turn; bundle source greppable for OpenRouter key returns zero matches

### 4B. Tavily capability service pilot

- [x] 4.19 Add `packages/tavily-web-search/src/schemas.ts` — static tool schemas (search, fetch) shared between service and client
- [x] 4.20 Add `packages/tavily-web-search/src/service.ts` — `TavilyService extends WorkerEntrypoint<TavilyEnv>` with `search(token, args)` and `fetch(token, args)` methods
- [x] 4.21 TavilyEnv includes `TAVILY_API_KEY`, the HKDF-derived Tavily subkey, and a `SPINE` service binding
- [x] 4.22 Each method verifies the token first via the Tavily subkey; derives sessionId from the verified token
- [x] 4.23 Service methods use `TAVILY_API_KEY` to call Tavily; sanitize errors before returning
- [x] 4.24 Service methods call `env.SPINE.emitCost(token, {...})` before returning success
- [x] 4.25 Add `packages/tavily-web-search/src/client.ts` — `tavilyClient({ service })` capability factory
- [x] 4.26 Client tool execute reads token from `ctx.bundleEnv.__SPINE_TOKEN` and calls service via RPC
- [x] 4.27 Update `packages/tavily-web-search/package.json` `exports` to expose `/service`, `/client`, `/schemas` subpaths; keep `.` unchanged
- [x] 4.28 Verify legacy `tavilyWebSearch({apiKey})` still builds and tests pass — static agents unaffected
- [x] 4.29 Schema-hash check: client passes computed schema hash, service compares against its own (defensive consistency check, not security boundary — service still validates args against its own TypeBox schema)
- [ ] 4.30 Unit tests for `TavilyService` (mocked fetch + mocked spine; verify cost emission, token rejection)
- [ ] 4.31 Unit tests for `tavilyClient` (mocked service stub; verify tools RPC correctly with token; verify no credential paths)
- [ ] 4.32 Integration test: bundle-enabled agent with `tavilyClient` capability runs a search via the service; cost event lands in session store keyed to correct sessionId; bundle source grep for `TAVILY_API_KEY` returns zero matches

## 5. Phase 4 — packages/bundle-registry

- [x] 5.1 Create `packages/bundle-registry` with `package.json`, `tsconfig.json`, `src/index.ts`
- [x] 5.2 Define `BundleRegistry` interface: `createVersion`, `getVersion`, `getActiveForAgent`, `setActive`, `rollback`, `listDeployments`, `putBytes`, `getBytes`
- [x] 5.3 Write D1 schema — `bundle_versions`, `agent_bundles`, `bundle_deployments` tables with indexes
- [x] 5.4 Implement `D1BundleRegistry` with self-seeding migration following the `skill-registry` pattern (`ensureTable()` runs CREATE IF NOT EXISTS on first call)
- [x] 5.5 Implement KV bundle bytes read/write helpers — `putBytes`, `getBytes` keyed by `bundle:{versionId}`
- [x] 5.6 Implement content-addressed version ID computation (SHA-256 hex of artifact bytes via Web Crypto)
- [x] 5.7 Implement KV readback verification: after `kv.put`, poll `kv.get` with exponential backoff (50ms, 100ms, 200ms, 400ms, 800ms, 1600ms, 2000ms) until bytes are visible; deploy fails on timeout
- [x] 5.8 Implement atomic `setActive` using D1 `db.batch([...])` — single batch wrapping UPDATE pointer + INSERT deployment log
- [x] 5.9 Implement atomic `rollback` using `db.batch` — wraps swap + insert deployment log
- [x] 5.10 Implement `InMemoryBundleRegistry` for unit tests (no D1 required)
- [x] 5.11 Unit tests for both implementations: version CRUD, set/get active, rollback with and without previous, deployment log ordering, KV size limit enforcement
- [ ] 5.12 Unit test KV readback verification: happy path, simulated lag, timeout failure
- [ ] 5.13 Unit test D1 batch atomicity: partial-failure simulation
- [x] 5.14 Wire `defineAgent`'s bundle field to accept the registry from `packages/bundle-registry`
- [x] 5.15 Implement `ctx.storage` active-version pointer cache update via a method the workshop calls when a deploy completes
- [ ] 5.16 Integration test: two deploys in sequence; both versions land in KV and D1 with correct hashes; DO pointer updates after each; rollback works; KV readback enforced

## 6. Phase 5 — packages/bundle-workshop

### 6A. Container image update

- [x] 6.1 Update `packages/cloudflare-sandbox/container/Dockerfile` to copy vendored `@claw-for-cloudflare/*` bundle-authoring packages to `/opt/claw-sdk/` during image build
- [x] 6.2 Mount `/opt/claw-sdk/` read-only at runtime via the container's filesystem configuration
- [x] 6.3 Generate `/opt/claw-sdk/INTEGRITY.json` at image build time with SHA-256 hashes of every vendored file
- [x] 6.4 Vendored set includes only what bundle authors need: `@claw-for-cloudflare/agent-bundle/bundle` subpath, `@claw-for-cloudflare/tavily-web-search/client` and `/schemas`, plus any other capability `client`/`bundle` subpaths that exist
- [x] 6.5 Verify that vendored snapshot does NOT include host-side WorkerEntrypoint classes (no `LlmService`, no `SpineService`, no `TavilyService`)
- [ ] 6.6 Document the image rebuild process in `packages/cloudflare-sandbox/README.md`
- [ ] 6.7 Add a CI check that the sandbox container image builds successfully after SDK changes
- [ ] 6.8 Add a CI check that `INTEGRITY.json` is regenerated whenever any vendored file changes

### 6B. Workshop package and tools

- [x] 6.9 Create `packages/bundle-workshop` with `package.json`, `tsconfig.json`, `src/index.ts`
- [x] 6.10 Define the workshop capability factory `bundleWorkshop({ registry, sandboxNamespace, deployRateLimitPerMinute? })`
- [x] 6.11 Implement `bundle_init` tool — scaffolds `package.json`, `tsconfig.json`, `src/index.ts`, `README.md` at `/workspace/bundles/{name}/`; runs `bun install --ignore-scripts`; uses `file:/opt/claw-sdk/...` references
- [x] 6.12 Implement `bundle_build` tool — verifies vendored package integrity hashes against `INTEGRITY.json`, then runs `bun build src/index.ts --target=browser --format=esm --outfile=dist/bundle.js`; captures stdout/stderr
- [x] 6.13 Implement `bundle_test` tool — reads built `dist/bundle.js`, does scratch Worker Loader invocation with throwaway in-memory spine and synthetic capability token, sends a test prompt, returns transcript
- [x] 6.14 `bundle_test` isolates state — no writes to parent's session store; throwaway spine has its own in-memory storage discarded after test
- [x] 6.15 `bundle_test` runs in a separate sandbox namespace (no parent credentials, no parent file state, no parent network identity)
- [x] 6.16 Implement `bundle_deploy` tool — reads artifact, computes hash, runs pre-deploy smoke test, calls `registry.createVersion` (handles KV write + readback verify), calls `registry.setActive`, signals target DO to refresh pointer
- [x] 6.17 Pre-deploy smoke test — loads candidate in scratch loader with throwaway spine + synthetic token, sends `POST /smoke`, verifies well-formed response; aborts deploy on failure
- [x] 6.18 `bundle_deploy` defaults to deploying to **invoking agent's own bundle pointer** (self-editing); accepts optional `targetAgentId` for cross-agent deploys
- [x] 6.19 `bundle_deploy` extracts metadata via the bundle's `POST /metadata` endpoint
- [x] 6.20 `bundle_deploy` enforces per-agent rate limit (default 5 deploys/minute) via DO storage counter
- [x] 6.21 Implement `bundle_disable` tool — calls `registry.setActive(targetAgentId, null)`, records rationale, signals target DO; defaults to invoking agent
- [x] 6.22 Implement `bundle_rollback` tool — calls `registry.rollback(targetAgentId)`, records rationale, signals target DO
- [x] 6.23 Implement `bundle_versions` tool — queries `bundle_deployments` joined with `bundle_versions.metadata`; default limit 20, max 100
- [x] 6.24 Sandbox elevation guard on all workshop tools — return clear error if sandbox not elevated
- [x] 6.25 KV size limit check in `bundle_deploy` — fail fast on bundles > 25 MiB
- [x] 6.26 Workshop tool audit logging — every `bundle_*` invocation appends a structured `workshop_audit` custom session entry recording tool name, args summary, status, error code if applicable, timestamp
- [x] 6.27 Unit tests for each workshop tool — mocked sandbox, registry, KV
- [ ] 6.28 Integration test (pool-workers): full init → build → test → deploy loop against a real (mocked-network) sandbox container and a real registry

## 7. Phase 6 — Example, polish, docs

### 7A. Example

- [x] 7.1 Create `examples/bundle-agent/` — a single bundle-enabled `defineAgent` (Phase 2 demo at examples/bundle-agent-phase2)
- [x] 7.2 Host worker exports the `defineAgent` class plus `LlmService`, `TavilyService`, `SpineService` WorkerEntrypoint classes
- [x] 7.3 Wrangler config has `worker_loaders`, KV namespace for bundles, D1 database for registry, R2 bucket for sandbox, `AGENT_AUTH_KEY` secret, plus service bindings
- [x] 7.4 The agent has the `bundleWorkshop` capability and a starter system prompt that knows how to use it
- [ ] 7.5 Example README walks through:
  - Run wrangler dev, hit the agent, see static brain answer (no bundle yet)
  - Send a prompt asking the agent to add a `current_time` tool to itself
  - Agent runs `bundle_init` → `bundle_build` → `bundle_test` → `bundle_deploy` (self-edit)
  - Hit the agent again, see it can answer with the new tool
  - Send `bundle_disable` to revert to static brain
- [ ] 7.6 Include CLI/curl demo commands for the full sequence
- [ ] 7.7 Verify the example works end-to-end with all features active

### 7B. Final validation

- [x] 7.8 Run `bun run typecheck` across the whole workspace; verify no static-agent regressions
- [x] 7.9 Run `bun run test` across the whole workspace; verify no regressions
- [x] 7.10 Lint check: `bun run lint`

### 7C. Documentation

- [x] 7.11 Update root `README.md` packages table to include `agent-bundle`, `bundle-registry`, `bundle-workshop`, plus the new tavily subpath exports
- [x] 7.12 Update `CLAUDE.md` "What the SDK Provides Today" section with new packages
- [x] 7.13 Update `CLAUDE.md` "Project Structure" section with new package entries
- [x] 7.14 Update `CLAUDE.md` "Architecture Rules" with a new section: "Bundle brain override — opt-in per-agent runtime override via Worker Loader"
- [x] 7.15 Document the secrets-never-in-bundles contract and the host-service pattern in `CLAUDE.md`
- [x] 7.16 Document the capability token authorization model in `CLAUDE.md` (HKDF subkeys, TTL, nonce semantics, `AGENT_AUTH_KEY`)
- [x] 7.17 Write `packages/agent-bundle/README.md` — "authoring your first bundle" tutorial
- [x] 7.18 Document the `BundleEnv` constraint with explicit examples of what does and doesn't type-check
- [x] 7.19 Document the capability service pattern with the Tavily split as the reference
- [x] 7.20 Document the four-layer cache/storage model for operators (Worker Loader → KV → DO storage → D1 registry)
- [ ] 7.21 Archive the previous `add-agent-bundles` change once this change is approved
