## 1. Phase 0 — Spikes (gating)

### 1A. pi-agent-core import inside loader isolate

- [ ] 1.1 Create a throwaway worker `spike/pi-import/` with `worker_loaders` binding and a minimal `WorkerEntrypoint` host
- [ ] 1.2 Hand-write a minimal bundle source that does `import { AgentRuntime } from "@claw-for-cloudflare/agent-runtime"` and logs `typeof AgentRuntime`
- [ ] 1.3 Compile the bundle with `bun build --target=browser --format=esm --outfile=bundle.js` against the workspace
- [ ] 1.4 Load the compiled bundle via `LOADER.get(...)` and invoke its default fetch handler
- [ ] 1.5 Verify the import resolves without hitting the pi-agent-core partial-json CJS issue or other transitive failures
- [ ] 1.6 Record findings: import chain status, any required upstream fixes, baseline bundle size after `bun build`

### 1B. DurableObjectStub as JSRPC argument

- [ ] 1.7 Create a throwaway two-worker setup `spike/do-stub-rpc/` — worker A exports a `WorkerEntrypoint` with a method `useStub(stub: DurableObjectStub): Promise<string>` that calls `stub.fetch(...)`
- [ ] 1.8 Worker B holds a DO namespace, gets a stub, calls `env.A.useStub(stub)` via service binding
- [ ] 1.9 Verify whether the stub crosses the JSRPC boundary and remains callable
- [ ] 1.10 Record outcome and impact on Open Question 10 / Decision 11 fallback paths

### 1C. Adapter async refactor feasibility

- [ ] 1.11 Pick `handlePrompt` in `packages/agent-runtime/src/agent-runtime.ts` as the target call path
- [ ] 1.12 In a scratch branch, create a stub `SessionStoreClient` interface with async equivalents of the methods `handlePrompt` invokes on `SessionStore`
- [ ] 1.13 Manually rewrite `handlePrompt`'s `SessionStore` access points to async, propagating `await` outward through callers as needed
- [ ] 1.14 Verify the rewrite compiles against the rest of agent-runtime
- [ ] 1.15 Run the existing `agent-runtime` test suite (or the subset that exercises `handlePrompt`) and verify it passes
- [ ] 1.16 Record: count of touched call sites, propagation depth, any unexpected sync-assumption discoveries

### 1D. Cold-start latency baseline

- [ ] 1.17 Compile a representative bundle: `AgentRuntime` + pi-agent-core + pi-ai + 2-3 representative capabilities (compaction-summary, prompt-scheduler) inlined via `bun build`
- [ ] 1.18 Measure the compiled bundle size in bytes
- [ ] 1.19 Measure cold-load latency: time from `LOADER.get(newKey, factory)` to first successful `getEntrypoint().fetch()` response on a fresh isolate
- [ ] 1.20 Compare against a static `AgentDO` instantiation cold start under `wrangler dev`
- [ ] 1.21 Record numbers as the Phase 1 baseline reference

### 1E. Phase 0 decision checkpoint

- [ ] 1.22 Aggregate spike results into a decision record at `openspec/changes/add-agent-bundles/phase-0-results.md`
- [ ] 1.23 Decision: four green or near-green outcomes → proceed to Phase 0.5. Any red → re-plan that area before continuing.

## 2. Phase 0.5 — Adapter layer refactor

- [ ] 2.1 Audit every `SessionStore` call site in `packages/agent-runtime/src/agent-runtime.ts` and dependent files; produce a spreadsheet of touched files and propagation depth
- [ ] 2.2 Define `SessionStoreClient` interface in `packages/agent-runtime/src/session/session-store-client.ts` — async equivalents of all `SessionStore` public methods used by `AgentRuntime`
- [ ] 2.3 Refactor host-side `SessionStore` to implement `SessionStoreClient` (every method becomes async, even when running in-process); verify SqlStore stays sync as a host-side primitive
- [ ] 2.4 Convert `AgentRuntime` to take `SessionStoreClient` instead of `SessionStore` directly; update constructor injection sites
- [ ] 2.5 Walk the touched call sites and add `await` where needed; run `tsc --noEmit` until clean
- [ ] 2.6 Run the full `packages/agent-runtime` test suite — every existing test must still pass
- [ ] 2.7 Define bundle-side `Transport` interface as send-only: `broadcast(token, sessionId, message)`, `broadcastGlobal(token, message)`. Document that `onMessage`/`onClose`/`onOpen` are not part of this interface
- [ ] 2.8 Refactor host-side `Transport` to keep its existing callback registration for the DO's WebSocket handling; this is unchanged
- [ ] 2.9 Add a new entry point on the bundle's default export contract: `POST /client-message` — receives `{token, sessionId, message}` from the host DO when a WebSocket message arrives
- [ ] 2.10 In `AgentDO`, refactor `webSocketMessage` to (a) for static agents, route to in-process AgentRuntime as today; (b) for loader-backed agents, call into the loaded bundle's `/client-message` endpoint
- [ ] 2.11 Document isolate lifecycle expectations in `packages/agent-runtime/src/spine/ISOLATE-LIFECYCLE.md`: static = single isolate per DO, loader-backed = sticky cache key per (sessionId, activeBundleVersionId), eviction caveats
- [ ] 2.12 Run all `agent-runtime` tests + every dependent package's tests (basic-agent, e2e/agent-runtime). No regressions.
- [ ] 2.13 Update CLAUDE.md "Architecture Rules" with the new SessionStoreClient and send-only Transport contracts

## 3. Phase 1 — Capability tokens, spine extraction, bundle host

### 3A. Capability token mint and verify utilities

- [ ] 3.1 Create `packages/agent-runtime/src/spine/capability-token.ts` — `mintToken({agentId, sessionId, ttlMs}, key)` and `verifyToken(token, key): {agentId, sessionId, exp, nonce} | null` using HMAC-SHA256 via Web Crypto SubtleCrypto
- [ ] 3.2 Token format: `base64url(payload).base64url(signature)` where payload is `{aid, sid, exp, nonce}`
- [ ] 3.3 Verification uses constant-time comparison via SubtleCrypto's `verify`
- [ ] 3.4 Unit tests: round-trip mint+verify, expired token rejection, tampered payload rejection, tampered signature rejection, wrong key rejection
- [ ] 3.5 Add nonce tracking helper for single-use enforcement (per-session set with TTL eviction in DO storage)

### 3B. SpineService and bundle-side adapter clients

- [ ] 3.6 Create `packages/agent-runtime/src/spine/spine-service.ts` exposing `SpineService extends WorkerEntrypoint<SpineEnv>` where `SpineEnv` includes `AGENT_AUTH_KEY` and the host DO namespace binding
- [ ] 3.7 SpineService methods take `token: string` as first argument; first action is `verifyToken` against `this.env.AGENT_AUTH_KEY`. Any session-scoped operation derives `sessionId` from the verified token, NOT from method arguments
- [ ] 3.8 Implement SessionStoreClient RPC surface: `appendEntry(token, entry)`, `getEntries(token, options)`, `getSession(token)`, `createSession(token, init)`, `listSessions(token, filter)`, `buildContext(token)`, `getCompactionCheckpoint(token)`
- [ ] 3.9 Implement KvStoreClient RPC surface: `kvGet(token, capabilityId, key)`, `kvPut(token, capabilityId, key, value, options?)`, `kvDelete(token, capabilityId, key)`, `kvList(token, capabilityId, prefix)`
- [ ] 3.10 Implement Scheduler RPC surface: `scheduleCreate(token, schedule)`, `scheduleUpdate(token, scheduleId, patch)`, `scheduleDelete(token, scheduleId)`, `scheduleList(token)`, `alarmSet(token, timestamp)`
- [ ] 3.11 Implement Transport-out RPC surface: `broadcast(token, message)`, `broadcastGlobal(token, message)` (token's sessionId is used implicitly for the sessionId-scoped broadcast)
- [ ] 3.12 Implement `emitCost(token, costEvent)` — costEvent has no `sessionId` field; the verified token provides it
- [ ] 3.13 Implement per-turn budget enforcement in SpineService: counters per token nonce, configurable defaults (100 SQL ops, 50 KV ops, 200 broadcasts, 5 alarm sets)
- [ ] 3.14 Create `packages/agent-runtime/src/spine/clients/` with bundle-side client implementations: `SpineSessionStoreClient`, `SpineKvStoreClient`, `SpineSchedulerClient`, `SpineTransportClient`. Each takes a `Service<SpineService>` binding and a token in its constructor; methods forward calls with the token as first argument
- [ ] 3.15 Add `@claw-for-cloudflare/agent-runtime/spine` subpath export in `packages/agent-runtime/package.json`
- [ ] 3.16 Unit tests for each client — fake SpineService stub, verify each method round-trips the token correctly and propagates the verified identity
- [ ] 3.17 Integration test: in-process SpineService with a real (in-memory) SessionStore, real bundle-side clients, run a synthetic prompt through the full RPC pipeline, verify entries land correctly and tokens are enforced

### 3C. packages/agent-bundle scaffolding

- [ ] 3.18 Create `packages/agent-bundle` with `package.json`, `tsconfig.json`, `src/index.ts`, `src/host/`
- [ ] 3.19 Create `packages/agent-runtime/src/bundle/` with `define-agent-bundle.ts`, `bundle-env.ts`, `default-export-contract.ts`
- [ ] 3.20 Implement `defineAgentBundle<BundleEnv>(setup)` returning a descriptor wrapped as a fetch handler with the documented endpoints
- [ ] 3.21 Define the `BundleEnv` constraint type that excludes native CF binding types and accepts only `Service<T>` + serializable values
- [ ] 3.22 Add `@claw-for-cloudflare/agent-runtime/bundle` subpath export — re-exports `defineAgentBundle`, `defineTool`, `Type`, the bundle-compatible type surface (NO `AgentDO`, NO `defineAgent`, NO native bindings)
- [ ] 3.23 Add `package.json` `exports` rules that physically prevent DO-only types from being imported via the bundle subpath
- [ ] 3.24 Type-level tests: `interface BundleEnv { AI: Ai }` fails to compile; `interface BundleEnv { LLM: Service<unknown> }` succeeds; `interface BundleEnv { TIMEZONE: string }` succeeds
- [ ] 3.25 Implement `defineLoaderAgent<Env>(config)` in `packages/agent-bundle/src/host/define-loader-agent.ts` — returns a DO class
- [ ] 3.26 The DO class on each per-turn dispatch: reads active version from `ctx.storage`, mints a capability token, calls `LOADER.get(...)` with `bundleEnv` projected from host env plus the token under `__SPINE_TOKEN`
- [ ] 3.27 The DO class implements `webSocketMessage` to call into the loaded bundle's `/client-message` endpoint with a fresh token
- [ ] 3.28 Implement default-export contract in the bundle subpath: a fetch handler that discriminates on URL path (`/turn`, `/alarm`, `/client-message`, `/tool-execute-smoke`, `/metadata`) and dispatches to the appropriate `AgentRuntime` method
- [ ] 3.29 Implement cold-start fallback bundle loading — if `getActiveForAgent` returns no active version, load the inline `config.fallback` directly (synthetic version ID for loader cache key)
- [ ] 3.30 Implement `bundleEnv` projection — DO constructs the loader env from `config.bundleEnv(env)` plus the token; rejects with a clear error if a non-serializable value is detected

### 3D. Phase 1 end-to-end milestone demo

- [ ] 3.31 Create `examples/loader-agent-phase1/` with a minimal loader-backed agent wired to `defineLoaderAgent`, a hand-written bundle source, and a build script (bun build)
- [ ] 3.32 Demo script: start `wrangler dev`, the example uses an inline fallback bundle (no registry yet), send a prompt via curl, see a response via the loader path
- [ ] 3.33 Verify spine RPC calls in DO logs: token verification on every call, entry appends going through SpineService, transport broadcasts going through SpineService
- [ ] 3.34 Document the demo flow in `examples/loader-agent-phase1/README.md`
- [ ] 3.35 Measure and record: cold-load latency, per-turn RPC count, total turn latency vs the existing static `examples/basic-agent` baseline
- [ ] 3.36 **Phase 1 decision gate**: if loader latency > 3× static latency, stop and add batching/buffering to the spine clients before continuing to Phase 2

## 4. Phase 2 — LlmService

- [ ] 4.1 Create `packages/agent-bundle/src/host/llm-service.ts` with `LlmService extends WorkerEntrypoint<LlmEnv>` where `LlmEnv` includes `AGENT_AUTH_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `AI` (Workers AI binding)
- [ ] 4.2 `LlmService.infer(token, request)` verifies the token first; rejects on bad token
- [ ] 4.3 Implement OpenRouter branch — `fetch` to OpenRouter API using `this.env.OPENROUTER_API_KEY`
- [ ] 4.4 Implement Anthropic branch — direct Anthropic API with `this.env.ANTHROPIC_API_KEY`
- [ ] 4.5 Implement OpenAI branch — direct OpenAI API with `this.env.OPENAI_API_KEY`
- [ ] 4.6 Implement Workers AI branch — routes to `this.env.AI.run(...)`
- [ ] 4.7 Unknown-provider branch returns a structured error that does NOT echo upstream response bodies (sanitization to prevent credential leakage)
- [ ] 4.8 Wrap all provider calls in try/catch; sanitize errors before returning to caller (whitelisted error code + generic message; no upstream response body forwarding)
- [ ] 4.9 Add tool-call request support — accept tool schemas in the request, return tool-call responses in pi-ai-compatible shape
- [ ] 4.10 Add streaming response support via `ReadableStream` return value (verified supported per platform review)
- [ ] 4.11 Per-agent inference rate limiting (default 100 calls/min per token-derived agentId) with structured error on limit hit
- [ ] 4.12 Cost emission for inference calls — `LlmService` calls `SpineService.emitCost` via its own SPINE binding, using the same token
- [ ] 4.13 Create `ServiceLlmProvider` adapter in `packages/agent-runtime/src/spine/clients/` that implements pi-ai's provider interface by RPCing through `env.LLM_SERVICE` with the bundle's token
- [ ] 4.14 Update `AgentRuntime`'s provider resolution: when a bundle's model declaration has no `apiKey`, select `ServiceLlmProvider`; when it has `apiKey`, use the direct pi-ai provider (static-agent path)
- [ ] 4.15 Make `apiKey` a compile-time error in bundle-side `defineAgentBundle`'s `model` type (type-level enforcement via subpath-restricted ModelConfig type)
- [ ] 4.16 Unit tests for each LlmService provider branch with credential redaction assertions in error paths
- [ ] 4.17 Integration test: bundle using `provider: "openrouter", modelId: "..."` runs a complete tool-calling turn without any OpenRouter key in bundle source or bundle env

### 4A. Phase 2 demo upgrade

- [ ] 4.18 Update `examples/loader-agent-phase1/` bundle to declare an OpenRouter model without apiKey
- [ ] 4.19 Add `LlmService` entrypoint and wrangler service binding to the example's host worker
- [ ] 4.20 Verify the demo runs end-to-end using OpenRouter inference, with the key stored only in the host worker's secret
- [ ] 4.21 Grep the bundle source + compiled artifact for the key string and OpenRouter URL to confirm zero leakage

## 5. Phase 3 — Capability service pattern (Tavily pilot)

- [ ] 5.1 Add `packages/tavily-web-search/src/schemas.ts` — static tool schemas (search, fetch) shared between service and client
- [ ] 5.2 Add `packages/tavily-web-search/src/service.ts` — `TavilyService extends WorkerEntrypoint<TavilyEnv>` with `search(token, args)` and `fetch(token, args)` methods
- [ ] 5.3 Each service method verifies the token first via the shared verify utility, then derives sessionId from the token
- [ ] 5.4 Service methods use `this.env.TAVILY_API_KEY` to call Tavily; sanitize errors before returning
- [ ] 5.5 Service methods call `this.env.SPINE.emitCost(token, {capabilityId, toolName, amount, currency})` before returning success — cost emission cannot be suppressed by the bundle
- [ ] 5.6 Add `packages/tavily-web-search/src/client.ts` — `tavilyWebSearchClient({service})` capability factory whose tool execute functions read the token from `ctx.bundleEnv.__SPINE_TOKEN` and RPC to the service
- [ ] 5.7 Update `packages/tavily-web-search/package.json` `exports` to expose `/service`, `/client`, and `/schemas` subpaths; keep `.` unchanged
- [ ] 5.8 Verify the legacy `tavilyWebSearch({apiKey})` factory still builds and tests pass — static agents unaffected
- [ ] 5.9 Unit tests for `TavilyService` methods (mocked fetch + mocked spine, verify cost emission is called before return, verify token rejection)
- [ ] 5.10 Unit tests for `tavilyWebSearchClient` (mocked service stub, verify tools RPC correctly with token and never see credentials)
- [ ] 5.11 Schema-hash header on every RPC call: client computes a hash of the imported schemas at build time; service compares against its own; mismatch returns a structured error
- [ ] 5.12 Integration test: loader-backed agent with `tavilyWebSearchClient` capability runs a search via the service, cost event lands in session store keyed to the correct sessionId, bundle source grepped for `TAVILY_API_KEY` returns zero matches

## 6. Phase 3.5 — packages/bundle-registry

- [ ] 6.1 Create `packages/bundle-registry` with `package.json`, `tsconfig.json`, `src/index.ts`
- [ ] 6.2 Define the `BundleRegistry` interface: `createVersion`, `getVersion`, `getActiveForAgent`, `setActive`, `rollback`, `listDeployments`
- [ ] 6.3 Write the D1 schema — `bundle_versions`, `agent_bundles`, `bundle_deployments` tables plus indexes
- [ ] 6.4 Implement `D1BundleRegistry` class with self-seeding migration following the `skill-registry` pattern (verified pattern: `ensureTable()` runs CREATE IF NOT EXISTS on first call)
- [ ] 6.5 Implement KV bundle bytes read/write via the registry's bound KV namespace — `putBytes(versionId, bytes)`, `getBytes(versionId)`
- [ ] 6.6 Implement content-addressed version ID computation (SHA-256 hex of artifact bytes via Web Crypto)
- [ ] 6.7 Implement KV readback verification: after `kv.put`, poll `kv.get` with exponential backoff (50ms, 100ms, 200ms, 400ms, 800ms, 1600ms, 2000ms; capped at ~5s) until bytes are visible; deploy fails if not visible within timeout
- [ ] 6.8 Implement atomic `rollback()` using D1 `db.batch([...])` — single batch wrapping the UPDATE + INSERT for the deployment log entry
- [ ] 6.9 Implement atomic `setActive()` using D1 `db.batch([...])` — single batch for UPDATE pointer + INSERT deployment log
- [ ] 6.10 Implement `InMemoryBundleRegistry` for unit tests (no D1 required)
- [ ] 6.11 Unit tests for both registry implementations — version CRUD, set/get active, rollback with and without previous version, deployment log ordering, KV size limit enforcement (25 MB)
- [ ] 6.12 Unit tests for KV readback verification — happy path, simulated lag (mock KV that delays visibility), timeout failure
- [ ] 6.13 Unit test for D1 batch atomicity — partial failure simulation
- [ ] 6.14 Update `defineLoaderAgent` to accept a `registry` factory and prefer it over the Phase 1 fallback-only path
- [ ] 6.15 Implement `ctx.storage` active-version pointer cache in the loader agent DO — read on cold start, written by the deploy signal RPC, invalidated on rollback signal
- [ ] 6.16 Add a method on the loader agent DO that the workshop can call to signal "your active version changed" (RPC method on the DO from the workshop)
- [ ] 6.17 Integration test: two deploys in sequence, verify both versions land in KV and D1 with correct content hashes, verify DO pointer updates after each, verify old version remains cacheable for rollback, verify KV readback is enforced

## 7. Phase 4 — packages/bundle-workshop

- [ ] 7.1 Create `packages/bundle-workshop` with `package.json`, `tsconfig.json`, `src/index.ts`
- [ ] 7.2 Define the workshop capability factory `bundleWorkshop({ registry, sandboxNamespace, authKey, selfEditingEnabled?: false, deployRateLimitPerMinute?: 5 })`
- [ ] 7.3 Implement `bundle_init` tool — scaffolds `package.json`, `tsconfig.json`, `src/index.ts`, `README.md` in the sandbox container at `/workspace/bundles/{name}/`
- [ ] 7.4 Scaffold `package.json` uses `file:` references to vendored workspace packages at `/opt/claw-sdk/` (read-only mount)
- [ ] 7.5 `bundle_init` runs `bun install --ignore-scripts` in the container via the sandbox `exec` tool; returns failure with stderr if install fails
- [ ] 7.6 Implement `bundle_build` tool — verifies vendored package integrity hashes against a known manifest, then runs `bun build src/index.ts --target=browser --format=esm --outfile=dist/bundle.js` via sandbox exec, captures stdout/stderr
- [ ] 7.7 Implement `bundle_test` tool — reads built `dist/bundle.js` from the container, does a scratch Worker Loader invocation with a throwaway in-memory spine and a synthetic capability token, sends a test prompt, returns the transcript
- [ ] 7.8 `bundle_test` isolates state — no writes to the parent's session store; the throwaway spine has its own in-memory storage discarded after the test
- [ ] 7.9 `bundle_test` runs in a separate sandbox namespace from the parent (no access to parent credentials, parent file state, or parent network identity)
- [ ] 7.10 Implement `bundle_deploy` tool — reads artifact, computes hash, runs pre-deploy smoke test, calls `registry.createVersion()` (which handles KV write + readback verify), calls `registry.setActive()`, signals target DO to refresh its pointer
- [ ] 7.11 Pre-deploy smoke test — loads candidate bundle in scratch loader with throwaway spine + synthetic token, sends a `ping` to `POST /tool-execute-smoke`, verifies a well-formed response; aborts deploy on any failure (no KV write, no D1 write)
- [ ] 7.12 `bundle_deploy` honors `selfEditingEnabled` flag — when false (default), rejects `targetAgentId` matching the invoking parent's agentId
- [ ] 7.13 `bundle_deploy` extracts metadata via the bundle's `/metadata` endpoint (the bundle's default export exposes a metadata-extraction path) — includes name, description, declared model, capability list
- [ ] 7.14 `bundle_deploy` enforces per-agent rate limit (default 5 deploys/minute per token-derived agentId) — backed by a token-nonce-keyed counter in DO storage
- [ ] 7.15 Implement `bundle_rollback` tool — calls `registry.rollback(targetAgentId)`, records rationale, signals target DO
- [ ] 7.16 Implement `bundle_versions` tool — queries `bundle_deployments` joined with `bundle_versions.metadata`, returns recent deployment history (default limit 20, max 100)
- [ ] 7.17 Add sandbox elevation guard to all workshop tools — if sandbox not elevated, return a clear error
- [ ] 7.18 KV size limit check in `bundle_deploy` — fails fast with a clear error if artifact > 25 MB
- [ ] 7.19 Implement workshop tool audit logging — every `bundle_*` tool invocation appends a structured custom session entry recording tool name, args summary, result, timestamp
- [ ] 7.20 Unit tests for each workshop tool — mocked sandbox, mocked registry, mocked KV; verify correct calls, error handling, rate limiting, audit logging
- [ ] 7.21 Integration tests (pool-workers): full init → build → test → deploy loop against a real (mocked-network) sandbox container and a real D1+KV registry

## 8. Phase 4 — Container image update

- [ ] 8.1 Update `packages/cloudflare-sandbox/container/Dockerfile` to copy vendored `@claw-for-cloudflare/*` packages to `/opt/claw-sdk/` during image build
- [ ] 8.2 Mount `/opt/claw-sdk/` read-only at runtime via the container's filesystem configuration
- [ ] 8.3 Generate `/opt/claw-sdk/INTEGRITY.json` at image build time with SHA-256 hashes of every vendored file; this is the manifest `bundle_build` verifies before running
- [ ] 8.4 Copy only the subpaths needed for bundle authoring: `agent-runtime/bundle`, `agent-runtime/spine` (client side), `tavily-web-search/client`, `tavily-web-search/schemas`, plus any other capability `client` subpaths that exist
- [ ] 8.5 Update the `bundle_init` scaffolder to write `package.json` with `file:/opt/claw-sdk/...` references that resolve against the vendored snapshot
- [ ] 8.6 Verify `bun install --ignore-scripts` and `bun build` work inside the container with no outbound network access
- [ ] 8.7 Document the image rebuild process in `packages/cloudflare-sandbox/README.md`
- [ ] 8.8 Add a CI check that the sandbox container image builds successfully after SDK changes
- [ ] 8.9 Add a CI check that `INTEGRITY.json` is regenerated whenever any vendored file changes

## 9. Phase 5 — Example, safety rails, polish

- [ ] 9.1 Create `examples/bundle-workshop-agent/` — a new example demonstrating Option A end-to-end
- [ ] 9.2 Host worker declares a static parent agent with `bundleWorkshop`, `LlmService`, `TavilyService`, `SpineService`, and the sandbox capability
- [ ] 9.3 Wrangler config has `worker_loaders`, KV namespace for bundles, D1 database for registry, R2 bucket for sandbox, plus the `AGENT_AUTH_KEY` secret
- [ ] 9.4 Example README walks through the flow: seed prompt asks the agent to create a weather-answering subagent; the agent runs init/build/test/deploy in its sandbox; the subagent is then invokable via a separate route
- [ ] 9.5 Include CLI/curl demo commands for the full sequence
- [ ] 9.6 Implement `POST /bundle/factory-reset` HTTP endpoint on `defineLoaderAgent` DOs — privileged (authenticated via `agent-auth`), restores DO to fallback bundle, logs a factory-reset entry in `bundle_deployments`
- [ ] 9.7 Implement per-entry bundle version tagging — each session entry that originated from a turn through a loader-backed agent records `bundleVersionId` in its custom metadata; session replay can reconstruct which bundle produced each entry
- [ ] 9.8 Verify the example works end-to-end with all safety rails active
- [ ] 9.9 Final cross-workspace validation: run `bun run typecheck` across the whole workspace, run `bun run test` across the whole workspace, verify no regressions in any static agent or e2e test

## 10. Phase 5 — Documentation

- [ ] 10.1 Update root `README.md` packages table to include `agent-bundle`, `bundle-registry`, `bundle-workshop`, and the new capability package subpath exports
- [ ] 10.2 Update `CLAUDE.md` "What the SDK Provides Today" section with descriptions of new packages
- [ ] 10.3 Update `CLAUDE.md` "Project Structure" section with new package entries
- [ ] 10.4 Update `CLAUDE.md` "Architecture Rules" with new sections: "Spine/loader split for loader-backed agents", "Capability tokens for spine RPC authorization", "Capability service pattern", "SessionStore async refactor"
- [ ] 10.5 Add a section to `CLAUDE.md` documenting the secrets-never-in-bundles contract and the host-service pattern
- [ ] 10.6 Write `docs/bundles.md` or `packages/agent-bundle/README.md` — "authoring your first bundle" tutorial
- [ ] 10.7 Document the `BundleEnv` contract with explicit examples of what does and doesn't type-check
- [ ] 10.8 Document the capability service pattern with the Tavily split as the reference example
- [ ] 10.9 Document the four-layer cache/storage model for operators
- [ ] 10.10 Document the capability token authorization model including TTL, nonce semantics, and the `AGENT_AUTH_KEY` secret rotation story (for follow-up)
- [ ] 10.11 Document the deferred self-editing story (Option B) and point at the follow-up change proposal that will introduce it
