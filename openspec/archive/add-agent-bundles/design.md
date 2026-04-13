## Context

CLAW's `packages/agent-runtime` already implements a three-layer architecture: `AgentRuntime` is the platform-agnostic runtime, `AgentDO` is the Cloudflare DO shell, and `defineAgent` is the declarative consumer API. `AgentRuntime` takes its effects via adapter interfaces (`SqlStore`, `KvStore`, `Scheduler`, `Transport`, `RuntimeContext`) so it can be hosted in something other than a DO. This was always intended to support alternative runtime hosts; it has not yet been exercised.

A POC in `examples/loader-agent` has demonstrated the load-bearing plumbing: a thin `DurableObject` subclass that owns SQL persistence, reads a JS source file from R2, loads it via Cloudflare Worker Loader with an `AiProxy` service binding in the loader's env, and successfully routes chat turns through loaded code. The POC proved that Worker Loader works under `wrangler dev`, that etag-based cache keying invalidates correctly on source change, that service bindings cross the loader boundary, and that native `Ai` bindings do NOT (`DataCloneError: Could not serialize object of type "Ai"`).

The POC stops short of being a first-class feature in several critical ways: (1) the loaded code is a plain fetch handler, not a CLAW agent runtime; (2) the R2 source is the runtime read path on every turn, with no runtime cache; (3) nothing enforces that the bundle cannot hold secrets; (4) no authorization model — the loaded code could call any spine method with any sessionId; (5) there is no build story for TypeScript source; (6) there is no version history or rollback; (7) there is no way for an agent to author a bundle from inside its own session.

This change turns the POC's architecture into a supported consumer API with security, authorization, build, registry, and workshop infrastructure. The scope is deliberately Option A (the workshop produces bundles for *subagents*, not for the parent's own runtime) for the first ship; the self-editing switch is deferred but the factory-reset endpoint that unblocks it ships in this change.

A multi-lens adversarial review of the original draft of this design surfaced three categories of issues now baked into this revision: (a) the security model stopped at credentials and left authorization undefined, (b) the "adapters are RPC-ready" claim was wrong because `SqlStore.exec()` is synchronous with iterator returns and `Transport` registers function callbacks, and (c) the KV consistency story assumed write-your-own-reads which Cloudflare's docs explicitly do not guarantee even within the same DO. Decisions 11 and 12 below, and the new Phase 0.5 in the migration plan, address these directly.

## Goals / Non-Goals

**Goals:**
- Ship a `defineLoaderAgent()` API that is structurally peer to `defineAgent()` in the consumer's mental model — same declarative shape, same mental load, different runtime backing.
- Make bundles authorable in TypeScript, buildable with `bun build`, deployable via a registry, and reloadable without worker redeploy.
- Guarantee that bundles cannot hold provider API keys or capability secrets, enforced both at the type system level and at the runtime projection level.
- Guarantee that bundles cannot forge identity to read or write into other agents' sessions or fabricate cost events for sessions they do not own. Authorization is structural, not advisory.
- Provide a sandbox-based authoring workflow where an agent can init, edit, build, test, and deploy a bundle from inside its own session, using tools that compose with existing sandbox, subagent, and file-editing capabilities.
- Establish a cost-tracking model for loader-backed agents that cannot be suppressed or fabricated by the bundle itself.
- Preserve full backwards compatibility: every existing `defineAgent` consumer works unchanged, with no functional regression. The Phase 0.5 adapter refactor introduces an async boundary in `SessionStore` that requires call-site updates inside `AgentRuntime` but does not change static-agent behavior.

**Non-Goals:**
- Self-editing agents whose own runtime is a loader-loaded bundle. Option B is deferred to a follow-up change; it is not blocked by this design but also not delivered by it. The factory-reset endpoint and per-entry version tagging that ship in this change are the prerequisites it will need.
- Cross-worker bundle sharing beyond the registry-as-content-store. A future change may add cross-agent bundle discovery UX; this change only requires that two agents using the same bundle content share a KV entry via content-addressed version IDs.
- GC / pruning of old KV bundle entries. The registry will accumulate versions; we accept this and add a GC tool later.
- Streaming bundle loading (partial evaluation, module-by-module). Bundles are whole-artifact loads keyed by content hash.
- Non-Tavily capability service splits. Only `tavily-web-search` is piloted as the first split package; other capability packages remain static-only and are addressed in follow-up work as demand dictates.
- Migration of existing static agents to loader-backed. Static agents stay static unless their authors explicitly opt in by switching to `defineLoaderAgent`.
- Bundle source editing via the registry. The registry holds compiled artifacts; source editing happens in the sandbox container filesystem (via existing sandbox tools) or in R2 scratch (via existing r2-storage tools).
- HMAC key rotation. The capability token model in Decision 11 uses a single `AGENT_AUTH_KEY` secret. Rotation is a follow-up concern — this change only requires that the key can be rotated by re-deploying the worker.

## Decisions

### 1. Spine/loader split — and the adapter refactor that makes it possible

**Decision:** Move `AgentRuntime` into the loader bundle. The DO becomes a persistence-and-transport spine that exposes a stable RPC surface (NOT the existing adapter interfaces directly) on a `SpineService` WorkerEntrypoint. Inside the loader bundle, `AgentRuntime` is constructed with new RPC-backed adapter implementations that wrap a `Service<SpineService>` binding injected into the bundle's env.

**The original draft of this decision claimed the adapter interfaces were "value-in/value-out" and that constructing them from RPC stubs was "mechanical." The architecture review proved this wrong on two counts:**

- `SqlStore.exec(query, ...bindings)` is **synchronous** and returns a `SqlResult<T>` exposing `toArray()` / `one()` / `[Symbol.iterator]()`. Synchronous methods cannot cross JSRPC; iterator-bearing return values are not structured-cloneable. `SessionStore` is built directly on `SqlStore` and calls `.exec()` synchronously throughout — every method (`create`, `get`, `appendEntry`, `buildContext`, `getEntries`) goes through this path. `SessionStore` cannot be instantiated inside a loader bundle as currently shaped.
- `Transport.onMessage(handler)` / `onClose(handler)` / `onOpen(handler)` register **local function callbacks**. Functions don't survive JSRPC. `AgentRuntime` wires these in its constructor to route incoming client WebSocket messages into the agent loop. A bundle-side runtime cannot do this against an RPC-stub Transport.

**What this actually requires (Phase 0.5):**
- `SessionStore` becomes async across its entire surface. `SqlStore` stays synchronous as a host-side primitive but is no longer touched by anything that runs in a bundle. The bundle gets a `SessionStoreClient` whose methods (`appendEntry`, `getEntries`, `buildContext`, etc.) are async RPC calls into `SpineService`. `AgentRuntime` call sites that previously assumed sync access (e.g., `agent-runtime.ts:1532` in `ensureAgent` calling `sessionStore.buildContext()`) get awaited.
- `Transport`'s incoming-message routing moves entirely to the host DO. The DO continues to own WebSocket lifecycle and hibernation. When a client message arrives, the DO calls a new method on the loaded bundle's default export (`POST /client-message` or equivalent) that delivers the message into the bundle's `AgentRuntime`. The bundle-side `Transport` adapter is **send-only** — it implements `broadcast` / `broadcastGlobal` as RPC into `SpineService`, and rejects any attempt to register `onMessage`/`onClose`/`onOpen` handlers because there's nothing for those handlers to receive locally.
- Per-session pi-agent-core `Agent` instances (today held in `sessionAgents: Map`) are rebuilt inside the loader isolate per turn from session history via `buildContext()`. CLAUDE.md already documents that context is rebuilt every turn, so the in-memory `Agent` is conceptually stateless across turns; what is lost is whatever warm state the per-session map provided across mid-turn calls (steer/abort). Mitigation: **isolate pinning is mandatory, not optional** — the host DO and the loader use a sticky cache key per session so one isolate handles a session's full turn lifecycle. If isolates are evicted mid-turn, the in-flight steer/abort target is lost; the design accepts this and documents it as a known limitation, addressable by buffering pending steer requests in the spine until the bundle picks them up.

**Alternatives still considered (and still rejected):**
- **Line A** (prompt + model config only in loader; tools/capabilities/LLM loop stay in the DO). Rejected: doesn't let the agent add tools without a worker redeploy, which is the central use case.
- **Line B** (prompt + tool implementations in loader; capabilities and hook chains stay in the DO). Rejected: creates an ugly asterisk in the consumer story ("you can edit tools but not hooks"), requires the DO to RPC into the loader for every tool execute, and the gain over Line C is marginal because the RPC chatter is similar.
- **Line C / chosen** (full runtime in loader). Higher RPC count per turn but the mental model is clean — the bundle *is* the agent definition, the DO *is* a state provider, and there are no partial-split edges. The cost of Line C is that the adapter refactor is real work, not free.

**Rationale:** The three-layer architecture was designed for exactly this. The delegation plumbing (`runtime-delegating.ts`, `AgentDelegate`, `createDelegatingRuntime`) can be reused by `defineLoaderAgent` — that part holds. What does not hold is the assumption that the adapter interfaces below the delegation layer are RPC-ready as-is. Phase 0.5 fixes this; Phase 1 then wires up cleanly.

### 2. Content-addressed bundle version IDs

**Decision:** Bundle version IDs are SHA-256 hashes (hex-encoded) of the compiled artifact bytes. The version ID is both the KV key suffix (`bundle:{versionId}`) and the Worker Loader cache key. Two bundles with identical content share the same version ID, the same KV entry, and the same Worker Loader cache slot.

**Alternatives considered:**
- **Monotonic version numbers** (v1, v2, v3...). Rejected: requires coordination to allocate, suffers race conditions on concurrent deploys, doesn't deduplicate identical content across agents, and requires an explicit invalidation signal when updating.
- **Semver strings** (authored by the deploying agent). Rejected: LLM-authored version strings are unreliable, and the registry has to dedupe anyway.
- **UUID / random IDs.** Rejected: doesn't deduplicate content, wastes KV entries when the same bundle is re-deployed.
- **Content hash / chosen.** Deterministic, collision-proof (modulo SHA-256 assumptions), automatic deduplication, and eliminates cache invalidation races. A new deploy produces a new hash → new cache key → guaranteed fresh load. A rollback to old content produces the same hash it had originally → cache hit if still present.

**Rationale:** Content addressing is the simplest correctness argument available. The alternative is a tower of invalidation logic that is all solved for free by hashing.

**Important constraint surfaced by review:** Two agents that end up with the same content-addressed version ID share a Worker Loader cache slot, which means they share an isolate. Bundle code MUST NOT rely on module-level mutable state for tenant isolation, because that state will be shared across tenants by construction. This is a documentation-and-lint concern, not an architecture concern, but it must be called out in bundle authoring docs. Capability tokens (Decision 11) provide the per-call tenant isolation — bundle module state is only safe when it's tenant-independent (e.g., a memoization cache keyed by token-derived agent ID is fine; a global "current user" variable is not).

### 3. Four-layer cache/storage model

**Decision:** The storage hierarchy is Worker Loader cache (in-memory, per-isolate) → KV (authoritative runtime store, keyed by content hash) → R2 (sandbox scratch only, not on the runtime read path) → D1 registry (pointers and metadata). Per-turn reads hit only the Worker Loader cache on the warm path; on cold path they add one KV read and one D1-backed pointer read (which is itself cached in DO `ctx.storage`). R2 is read only during deploy operations when the workshop copies built artifacts into KV.

**Alternatives considered:**
- **R2 as the primary runtime store** (mirroring the POC and vibe-coder's deploy-server pattern). Rejected: R2 was designed for object storage, not low-latency metadata. The POC's hot-path R2 read works but accumulates unnecessary latency on every cold load, and R2 is where agents edit source — conflating edit-time and runtime storage makes atomic deploy harder.
- **KV only** (no D1 registry, store bundle bytes and pointers both in KV). Rejected: KV's eventual consistency makes pointer updates racy, and KV lacks the indexed query support needed for deployment history and cross-agent bundle listing. D1 provides both.
- **DO SQLite for the registry** instead of D1. Rejected: a registry is shared across agents, and putting it in a single DO creates a bottleneck. D1 is the right tool for shared, indexed metadata at the edge.
- **Chosen:** R2 for authoring, KV for runtime bytes, D1 for pointers and metadata, DO `ctx.storage` as a hot-path pointer cache.

**Rationale:** Each layer is used for what it's best at. R2 handles the messy "I'm editing a project" storage pattern the agent interacts with via existing tools. KV serves compiled bundles at edge-replicated low latency. D1 serves the small, structured metadata queries. DO storage eliminates the D1 hop on the warm path. No single layer is asked to do two jobs.

### 4. Secrets never cross the loader boundary

**Decision:** Provider API keys, capability credentials, HMAC keys, and any other secrets are forbidden from `BundleEnv`. The bundle-authoring subpath's `BundleEnv` type constraint excludes native binding types (`Ai`, `R2Bucket`, `DurableObjectNamespace`, `VectorizeIndex`, `D1Database`, `WorkerLoader`) and accepts only `Service<T>` service bindings plus structurally-serializable values. The host worker's `bundleEnv` projection factory is the ultimate gatekeeper at runtime; the type system is the first line of defense at authoring time. Any operation that requires a secret is lifted into a host-side service class (`LlmService`, `TavilyService`, etc.) that holds the secret in its own `this.env` and exposes only non-credentialed methods via JSRPC.

**Alternatives considered:**
- **Trust the bundle** (pass keys through, assume bundle authors are not adversarial). Rejected: the self-editing use case necessarily involves LLM-authored bundle code. Treating the bundle author as untrusted is the only coherent threat model for this feature.
- **Encrypted secrets** that the bundle decrypts with a host-provided key. Rejected: the decryption key is itself a secret, and the bundle code can log both ciphertext and plaintext. No crypto story makes secrets-in-the-bundle safe.
- **Short-lived scoped tokens** (e.g., a bundle gets a time-limited Tavily token). Rejected as a credential-replacement strategy, but adapted in Decision 11 as the *authorization* mechanism for spine RPC — capability tokens carry identity, not credentials.
- **Chosen:** structural enforcement at the type level plus runtime enforcement via host-side services.

**Rationale:** The only credible safety story for self-editing agents is "the bundle never sees the secret in any form." Every alternative either weakens the guarantee or adds complexity that's strictly worse than the service pattern.

### 5. Host-side LlmService as the inference entry point

**Decision:** A new `LlmService` WorkerEntrypoint class lives in `packages/agent-bundle`. It holds provider API keys in its own env and routes `infer(token, request)` calls to OpenRouter, Anthropic, OpenAI, or Workers AI. The first argument is always a sealed capability token (Decision 11) which the service verifies and uses to derive `agentId`/`sessionId` for budget enforcement, cost attribution, and audit. Bundles declare models as `{provider, modelId}` with no apiKey, and `AgentRuntime` inside the bundle uses a `ServiceLlmProvider` adapter that RPCs through `env.LLM_SERVICE`.

**Alternatives considered:**
- **Workers-AI-only path** (use only the existing `AiProxy` pattern from the POC). Rejected: restricts loader-backed agents to Cloudflare's model catalog, which excludes frontier models most CLAW agents use via OpenRouter. We want loader-backed agents to be functional peers of static agents.
- **Per-provider services** (separate OpenRouterService, AnthropicService, etc.). Rejected: bundles would have to declare one binding per provider they might use, and changing provider at runtime would require reconfiguring host bindings. A single routed service is simpler.
- **Chosen:** one LlmService that routes by provider, with token-derived identity on every call.

**Rationale:** Consolidation is correct here — the service's job is credential lookup, RPC, and audit, not provider-specific logic beyond a switch statement. pi-ai already abstracts providers; LlmService is a thin wrapper that selects a pi-ai provider with credentials from its own env, plus a Workers AI branch.

**Open Question 1 resolved:** `LlmService` lives in `packages/agent-bundle`. Extraction to its own package can happen later if cross-consumer demand emerges; premature extraction adds a dep without benefit.

### 6. Capability service pattern via three subpath exports

**Decision:** Capability packages that hold secrets adopt a three-subpath layout: `index.ts` (legacy static-agent factory, unchanged), `service.ts` (WorkerEntrypoint class holding secrets, implementing tool execution, emitting costs via spine RPC), `client.ts` (bundle-side capability factory that takes a `Service<T>` and produces a capability whose tools thin-proxy to the service). Tool schemas live in a shared `schemas.ts` imported by both sides. The `exports` field in `package.json` enforces the separation physically. Every `service.ts` method takes a sealed capability token as its first argument and verifies it before doing any work.

**Alternatives considered:**
- **Single export with conditional credentialing.** Rejected: the capability has to work in two very different runtime hosts (host worker vs loader isolate); a single export can't serve both without leaking one into the other.
- **Registry-declared capabilities** where the bundle references capabilities by string ID and the host resolves them. Rejected: loses static tool schemas, weakens type safety, and makes LLM-authored bundles harder (no import-time autocomplete for available capabilities).
- **Chosen:** three subpath exports, shared schema module, physical package.json boundary.

**Rationale:** The split is explicit and enforceable. Tool schemas are a compile-time artifact of the bundle, not a runtime-resolved object, which matters for bundle author ergonomics and for the LLM's ability to write correct bundle code.

### 7. Sandbox container as the bundle authoring environment

**Decision:** Bundle source lives in the agent's existing sandbox container filesystem. The workshop tools (`bundle_init`, `bundle_build`, `bundle_test`, `bundle_deploy`) run inside the container via the existing `packages/sandbox` `exec` tool. `bun build` runs in the container against a TypeScript project scaffolded by `bundle_init`. Workspace package dependencies are resolved via a vendored snapshot of `@claw-for-cloudflare/*` packages **mounted read-only** into the `SandboxContainer` Docker image at a known path; `package.json` uses `file:` references. Package integrity hashes are verified before `bun build` runs. `bun install` is invoked with `--ignore-scripts` to disable lifecycle hooks.

**Alternatives considered:**
- **Bundle source in R2, build in the worker via esbuild-wasm.** Rejected: esbuild-wasm in a Worker isolate is cold-start heavy, the agent's existing sandbox already has `bun` and TypeScript, and vibe-coder's sandbox pattern is a proven model for this.
- **Publish workspace packages to a private npm registry.** Rejected: introduces a release cadence dependency on an external registry, complicates self-hosting, and delays the feature behind a publishing story.
- **Publish workspace packages to the public npm registry.** Possible eventually, but premature for the first ship — the surface is still stabilizing.
- **Writable vendored snapshot** (the original draft). Rejected after security review: an adversarial bundle could modify the vendored packages between init and build, compromising the next build for any co-tenant. Mounting read-only with hash verification closes this attack surface.
- **Chosen:** vendor a snapshot into the container image, mount read-only, verify hashes, `bun install --ignore-scripts`, offline build.

**Rationale:** The sandbox container is already under our control, rebuilding the image on SDK changes is acceptable (the image build is not on any critical path), and this gives us a fully offline, supply-chain-hardened bundle build. It also keeps the workshop flow close to vibe-coder's proven pattern.

### 8. Option A first: workshop produces subagent bundles

**Decision:** The first shipped iteration of the workshop defaults to producing bundles for *subagents*, not for the parent agent's own runtime. The parent is a static `defineAgent` agent that has the `bundleWorkshop` capability. When the parent's agent calls `bundle_deploy`, the workshop creates or updates a subagent's active bundle. Self-editing the parent's own runtime is gated behind an explicit `selfEditingEnabled` flag on the workshop capability instantiation, which remains unset by default in this change and will be enabled in a follow-up once the necessary additional invariants are agreed.

**The factory-reset endpoint that ships in this change is also useful for Option A**, not just as Option B groundwork: a subagent whose bundle deploy succeeds the smoke test but turns out broken on real traffic still needs an out-of-band recovery path. The endpoint provides that path for both deployment models.

**Alternatives considered:**
- **Option B** (parent is itself loader-backed; workshop edits its own runtime). Deferred: requires careful design of "the agent that edits itself" invariants beyond what's ready now.
- **Chosen:** ship A, with the factory-reset infrastructure that B will need already in place.

**Rationale:** A is strictly safer and proves every piece of the architecture except the self-replacement invariant. B is a configuration flip on top of A — no core architecture is redone. Shipping A first de-risks B's eventual delivery.

### 9. Content-addressed version IDs enable zero-coordination bundle sharing

**Decision (follow-on from Decision 2):** Because version IDs are deterministic content hashes, two different agents that deploy the same bundle bytes automatically share the same `bundle_versions` row, the same KV entry, and the same Worker Loader cache slot. The registry schema leverages this with `agent_bundles.active_version_id` as a foreign key to `bundle_versions.version_id`. A future "bundle marketplace" feature can build on this primitive without any storage changes.

**Rationale:** This is a free win from content addressing and worth calling out so the eventual cross-agent discovery story has a foundation to build on. No work in this change is required to unlock it beyond the schema. Note the constraint from Decision 2: shared isolates require tenant-independent module-level state in bundles.

### 10. Pre-deploy smoke test in the workshop

**Decision:** `bundle_deploy` runs a mandatory smoke test before updating the active version pointer. The smoke test loads the candidate bundle in a scratch Worker Loader invocation with a throwaway spine, issues a minimal ping invocation, and verifies the bundle returns a well-formed response. Failure aborts the deploy before any KV write or registry update occurs.

**Alternatives considered:**
- **No smoke test, deploy always succeeds if KV write succeeds.** Rejected: a bundle that fails to load will brick the target agent on the next turn.
- **Full test-suite run.** Rejected: slow and requires an author-supplied test corpus. Smoke test catches load-time crashes and dispatch-time crashes with minimal latency.
- **Chosen:** mandatory pre-deploy smoke test at the ping level.

**Rationale:** Deploy is the one operation that absolutely must not half-succeed. The smoke test is the cheapest insurance against an unloadable or dispatch-broken bundle, and it runs automatically so the agent doesn't have to remember to test.

### 11. Per-turn capability token authorization (NEW)

**Decision:** Every RPC method on `SpineService`, `LlmService`, and capability service classes takes a sealed capability token as its first argument. The token is an HMAC-signed envelope binding `{agentId, sessionId, expiresAt, nonce}` to a specific turn invocation. The host worker mints the token when dispatching a turn into the loader and injects it into the bundle's env as a string under a well-known key (`__SPINE_TOKEN`). The bundle never reads the token directly — the bundle-side adapter implementations (`SessionStoreClient`, `ServiceLlmProvider`, capability clients) read it from env and pass it on every RPC call. Services verify the HMAC using their own access to `this.env.AGENT_AUTH_KEY` and **derive `agentId`/`sessionId` from the verified payload only** — caller-supplied session IDs in other arguments are ignored or absent from the method signature entirely.

**Token shape:**
```
token = base64url(payload) + "." + base64url(hmac_sha256(AGENT_AUTH_KEY, base64url(payload)))
payload = { aid: string, sid: string, exp: number, nonce: string }
```

**Verification:**
1. Split on `.`, decode payload and signature.
2. Recompute HMAC-SHA256 over the payload using `AGENT_AUTH_KEY`.
3. Constant-time compare against the signature; reject on mismatch.
4. Reject if `exp < now` (TTL of ~5 minutes from mint time, sufficient for one turn).
5. Use only `payload.aid` and `payload.sid` as the operating identity. Drop the nonce after a single use (optional anti-replay; nonces are tracked in the spine's session-scoped state).

**What this prevents:**
- Cross-session writes (`spine.appendEntry(victimSid, forgedEntry)` — `victimSid` is no longer an argument; the spine uses the token's `sid`).
- Cross-agent reads (same reasoning).
- Cost forgery (`emitCost({sessionId: victimSid, amount: 9999})` — the cost event's session is derived from the token, not from a body field).
- LlmService budget bypass (every infer call carries identity; per-agent budgets are enforced centrally).

**What this does NOT prevent:**
- A bundle calling spine methods many times within its own session (still possible; rate limits handle this — see Decision 11.5 below).
- A bundle returning fabricated content to the LLM (this is just normal LLM hallucination — out of scope).
- A bundle leaking tool *results* (the bundle has access to data the user gave it; what it does with the data is a product question, not a security one).

**Alternatives considered:**
- **Trust caller-supplied identity** (the original draft). Rejected: enables forgery from inside a malicious bundle. This was the central security finding from the review.
- **Mint a long-lived token per session and let the bundle reuse it.** Rejected: turns a per-turn authorization into a session-scoped credential, expanding the blast radius if a bundle exfiltrates the token. Per-turn tokens with ~5min TTL bound the window.
- **Issue a separate token per service** (one for spine, one for LLM, one for Tavily). Rejected: complicates the bundle-side env projection and offers no real security benefit since all services verify against the same HMAC key. One token, used by all RPC surfaces.
- **Use opaque random tokens stored in a token store.** Rejected: requires a stateful token registry and cross-isolate lookups on every RPC. HMAC signatures are stateless and verifiable without registry hits.
- **Chosen:** stateless HMAC capability tokens, one per turn, used by all RPC surfaces.

**Rationale:** This is the smallest mechanism that makes the "bundles are untrusted" invariant enforceable. The cost is one HMAC verification per RPC call (microseconds) and one extra string field in the bundle env. The benefit is structural impossibility of identity forgery rather than relying on convention.

### 11.5. RPC budgets and rate limits

**Decision:** Spine and LLM service RPCs are subject to per-turn and per-agent budgets enforced server-side. Default per-turn budgets: 100 SQL ops, 50 KV ops, 200 broadcast events, 5 alarm sets. Default per-agent rate limits: 10 deploys per minute, 100 inference calls per minute. Exceeding a budget returns a structured error from the spine that the bundle's `AgentRuntime` surfaces as a turn failure. These are configurable in the host worker config but ship with safe defaults.

**Rationale:** Capability tokens prevent forgery; budgets prevent denial-of-service from inside the bundle's own session. A misbehaving bundle can still consume resources within its own quota, which is fine — it's its own session, not anyone else's.

### 12. KV readback verification on deploy (NEW)

**Decision:** `bundle_deploy` does NOT consider a deploy successful when `kv.put()` returns. Instead, after writing the bundle bytes to KV, the workshop polls `kv.get(bundleKey)` until it returns the expected bytes (or until a timeout, ~5 seconds max), and only then proceeds to update the D1 registry pointer. The "active version" pointer is the consistency boundary: a deploy is not visible to the running agent until KV readback confirms the bytes are reachable AND the D1 row has been written.

**Why this exists:** The original draft assumed KV provided write-your-own-reads consistency within the same DO. Cloudflare's documentation explicitly contradicts this — KV is eventually consistent across locations with up to a 60-second window, even within a single account. A deploy that flips the active version pointer immediately after `kv.put()` can leave the agent reading a stale or absent value on the next turn.

**Implementation:**
1. `kv.put("bundle:" + versionId, bytes)`.
2. Poll `kv.get("bundle:" + versionId, "arrayBuffer")` with exponential backoff (50ms, 100ms, 200ms, 400ms, 800ms, 1600ms, 2000ms — capped at ~5s total).
3. If readback succeeds with matching bytes, proceed to D1 update.
4. If readback fails after timeout, the deploy fails. The KV bytes remain (orphan, harmless), the registry is unchanged, the active pointer is unchanged. The agent retries the deploy.

**Alternative considered:**
- **Stage bytes in DO `ctx.storage` for first N turns post-deploy** so the loader factory reads from DO storage if the KV entry isn't visible yet. Rejected: complicates the loader factory's read path with two sources of truth, and the DO storage entry has to be cleaned up eventually anyway.
- **Chosen:** poll-then-flip. Adds bounded latency to deploy (typically <500ms, worst case <5s); zero impact on the runtime read path.

**Rationale:** Deploy is not on the agent's interactive critical path — the agent is running the workshop, then immediately the deploy. A few hundred milliseconds of polling is acceptable in exchange for guaranteed read-after-write consistency on the runtime side.

## Risks / Trade-offs

- **[RPC latency accumulates]** Every session entry append, every broadcast, every KV get becomes a cross-isolate RPC in the loader-backed path. A typical turn does 10-30 of these. → **Mitigation:** batch where possible (append entries in groups at turn end, broadcast multiple events in one RPC for high-frequency streaming), pin-warm the loader isolate per session via sticky cache keys, measure early. Phase 1 demo (Task 4.5) records the actual per-turn RPC count and total latency vs a static-agent baseline.

- **[Worker Loader isolate recycling evicts the warm cache]** Each eviction forces a KV read and bundle recompile. → **Mitigation:** Worker Loader's cache behavior is not fully under our control, but KV reads are single-digit milliseconds and compilation is fast for bundles in the expected size range (100 KB - 2 MB). Phase 0 records cold-start latency on a realistic bundle so we have a number before committing.

- **[Bundle size exceeds KV 25 MB limit]** Unlikely for bundles containing only the runtime and a few capabilities, but possible if an author inlines something large. → **Mitigation:** `bundle_deploy` fails fast with a clear error identifying size as the cause. No partial writes. Splitting bundles across multiple KV entries is a future-work option that doesn't need to exist now.

- **[pi-agent-core lazy-load workaround transitively breaks in the loader]** The known `loadPiSdk()` workaround in `agent-do.ts` exists because of a partial-json CJS issue in the Workers test pool. → **Mitigation:** Phase 0 spike verifies this before any other implementation work. If the import fails, the fallback design is dramatic — drop back to Line A or Line B partial splits. This is a true STOP signal, not a workaround opportunity.

- **[Adapter refactor scope creep]** Phase 0.5 may turn out larger than estimated once `SessionStore` async-conversion starts touching `AgentRuntime` call sites. → **Mitigation:** the spike in Phase 0.5 (Task 0.5.1) converts ONE call path end-to-end (e.g., `handlePrompt`) before committing to converting all of them. If the call-site update count is much larger than expected, the phase is rescoped and timeline-revised before Phase 1 starts.

- **[Bundle build requires network for first-time install]** Bun install normally downloads packages from the registry. Vendoring in the container image means offline install, but the image build itself needs network. → **Mitigation:** image build is a release-time operation with full network access. Runtime builds inside running containers are offline because all deps are pre-vendored.

- **[Read-only vendored packages may break bun install]** Bun install may want to write to `node_modules` in the vendored path. → **Mitigation:** bun install writes to the workspace's local `node_modules` (the LD_PRELOAD intercept in the existing sandbox container redirects this to local disk, not FUSE/R2). The vendored source path is read-only; the workspace's resolved deps are not. Verify in Phase 4 that this composes correctly.

- **[LlmService becomes a bottleneck]** Every loader-backed inference goes through one worker entrypoint. → **Mitigation:** worker entrypoints are horizontally scalable. The only bottleneck is upstream provider rate limits, which exist regardless.

- **[Sandbox elevation becomes a prerequisite for bundle authoring]** Agents must elevate a sandbox session before running `bundle_init` or `bundle_build`. → **Mitigation:** the workshop capability's tool descriptions instruct the agent on elevation, and the first workshop tool call returns a clear error if sandbox is not elevated.

- **[Capability token replay within TTL]** A token stolen and used within its 5-minute TTL is indistinguishable from the original. → **Mitigation:** nonces tracked in spine session state for single-use enforcement. This is best-effort — a malicious bundle running in its own isolate cannot meaningfully "steal" a token because it already has it; the threat is logging tokens to external systems for later use, which the egress restrictions on the bundle isolate's `globalOutbound` mitigate.

- **[Module-level state shared across content-addressed isolate slots]** Two agents with the same bundle content share an isolate; bundle code with module-level mutable state leaks across tenants. → **Mitigation:** documented as a bundle authoring rule, enforced via lint warning if practical, and the capability token model ensures no operation can affect the wrong agent even if module state leaks. The leak surface is limited to data that already crossed the loader boundary into the bundle (i.e., not secrets).

- **[Cost emission relies on the host service's trust boundary]** If a capability service forgets to emit a cost before returning, the cost is lost. → **Mitigation:** centralizing cost emission in service classes (rather than spread across many static-agent capabilities) makes code review more tractable. Test harnesses for capability services include cost-emission assertions.

- **[Bundles can be fooled about tool schemas if service and client drift]** If `service.ts` and `client.ts` declare different schemas for the same tool, the bundle will advertise one shape to the LLM while the service expects another. → **Mitigation:** enforce a shared `schemas.ts` module imported by both sides. Drift is caught at compile time. For cross-version drift (vendored bundle vs deployed host), include a schema hash in every RPC request and reject mismatches.

- **[Registry writes are not atomic across D1 and KV]** `bundle_deploy` writes to KV then to D1. If the KV write succeeds and the D1 write fails, we have orphaned bytes in KV but no registry entry. → **Mitigation:** orphaned KV entries are harmless (no pointer references them), eventual GC tool cleans them up, and rate limits on `bundle_deploy` bound the orphan accumulation rate.

- **[D1 multi-statement atomicity requires `db.batch()`]** Naive sequential `.run()` calls are not transactional in D1. Rollback (UPDATE pointer + INSERT audit log) must be one batch call. → **Mitigation:** registry implementation uses `db.batch([...])` for any multi-statement operation. Code review and tests verify this.

## Migration Plan

This change is additive. No existing static agents are migrated. Rollout proceeds in phases, each of which leaves the repo in a working state:

**Phase 0 — Spikes (gating).** Three independent spikes that gate Phase 0.5 and Phase 1, plus a baseline measurement. Each is time-boxed; outcomes are recorded as decision artifacts. If any spike returns red, the dependent phases are replanned before any code lands.

  - **Spike 0.A: pi-agent-core import inside a loader isolate.** Hand-write a minimal bundle that does `import { AgentRuntime } from "@claw-for-cloudflare/agent-runtime"`, compile with `bun build`, load via Worker Loader, log success. Verifies the `loadPiSdk()` workaround composes with loader isolate module resolution.
  - **Spike 0.B: DurableObjectStub as a JSRPC argument.** Two-worker setup: worker A exports a `WorkerEntrypoint` with a method that takes a `DurableObjectStub` and calls a method on it; worker B holds a DO namespace and calls the method with a stub. Verifies whether option (a) or option (c) in Open Question 10 is feasible.
  - **Spike 0.C: Adapter async refactor feasibility.** Pick `handlePrompt` as a target call path. Manually rewrite its `SessionStore` access points to async, using a stub `SessionStoreClient` that resolves immediately. Verify: (i) the rewrite compiles, (ii) the existing `handlePrompt` test (or a synthetic equivalent) passes, (iii) document the count of touched call sites and any propagation depth (does awaiting `appendEntry` cause cascading async conversions in callers?). The output of this spike is the input to Phase 0.5's task estimate.
  - **Baseline 0.D: Cold-start latency measurement.** Compile a realistic bundle (`AgentRuntime` + pi-agent-core + pi-ai + 2-3 capabilities), measure the size and the cold-load latency in a fresh Worker Loader isolate. Compare against the static-agent equivalent. Record numbers as a baseline for Phase 1 comparison.
  - **Decision checkpoint:** four green or near-green outcomes → proceed to Phase 0.5. Any red → re-plan that area before continuing.

**Phase 0.5 — Adapter layer refactor (NEW).** The architectural prerequisite. Cannot start until Spike 0.C is green.

  - Audit every `SessionStore` call site in `AgentRuntime`. Convert each to async, propagating `await` outward through callers.
  - Introduce a `SessionStoreClient` interface (async, JSRPC-friendly: `appendEntry`, `getEntries`, `getSession`, `createSession`, `listSessions`, `buildContext`, `getCompactionCheckpoint`, etc.). The host-side `SessionStore` remains for use by `AgentDO`; the client interface is what the bundle-side `AgentRuntime` consumes.
  - Refactor the existing `SessionStore` to fully implement the new async client interface, even when running in-process inside a static `AgentDO`. (Static agents use the same async interface, just via in-process awaits — preserves a single code path.)
  - Move all `Transport` incoming-message routing into the host DO. Add a new bundle-side default-export entry point: `POST /client-message` (or equivalent) that the DO calls when a client message arrives. The bundle's `AgentRuntime` receives messages via this entry, not via `Transport.onMessage`.
  - Define the bundle-side `Transport` interface as send-only: `broadcast`, `broadcastGlobal`. Reject `onMessage`/`onClose`/`onOpen` registration with a clear error in the bundle build.
  - Document isolate lifecycle: static agents always use a single isolate per DO; loader-backed agents use sticky cache keys (one isolate per active session-version pair) with documented eviction behavior.
  - Tests: every existing `agent-runtime` test still passes after the refactor. Per-capability tests still pass. No behavioral change for static agents.

**Phase 1 — Spine extraction and bundle host.** Now that the adapter layer is refactored:

  - Implement `SpineService` WorkerEntrypoint exposing the new async client interfaces, plus `LlmService` integration (Phase 2 lands the LLM body), plus cost emission. Every method takes a capability token first argument.
  - Implement `SpineSqlStoreClient` (now misnamed — should be `SpineSessionStoreClient` per Phase 0.5 naming), `SpineKvStoreClient`, `SpineSchedulerClient`, `SpineTransportClient` (send-only) — RPC-backed implementations that call `SpineService` with the bundle's capability token.
  - Implement `packages/agent-bundle` with `defineLoaderAgent` + `defineAgentBundle` + the bundle default-export contract.
  - Implement capability token mint/verify utilities. Host DO mints on dispatch, services verify on receive.
  - End-to-end demo: a hand-written, hand-compiled bundle runs one prompt-to-response turn via spine RPC with token authorization. LLM keys still live in the bundle's model declaration at this phase — the secret-free model comes in Phase 2.
  - Measure per-turn RPC count and total latency vs a static agent. Decision gate: if loader latency is more than 3× static latency at this point, stop and add batching/buffering before Phase 2.

**Phase 2 — `LlmService`.** Ship the host-side LLM provider proxy with token verification on every call, update `AgentRuntime` to prefer a service-backed provider adapter when bundles declare a model without apiKey. Type-level enforcement of the no-apiKey rule. The Phase 1 demo gets rewritten to use `env.LLM_SERVICE`, confirming OpenRouter inference works without the key being in the bundle.

**Phase 3 — Capability service pattern (Tavily pilot).** Add `service` and `client` subpath exports to `packages/tavily-web-search`. Shared schemas module. Spine-backed cost emission with token-derived session attribution. The Phase 2 demo gains Tavily search via the service pattern. No other capabilities are split in this change.

**Phase 3.5 — `packages/bundle-registry`.** D1 schema with self-seeding migration, KV wiring, interface + D1 implementation, KV readback verification on deploy, D1 batch atomicity for rollback. `defineLoaderAgent` switches from Phase 1 fallback-only to registry-backed lookup. `ctx.storage` hot-path pointer cache. Factory-function registry argument so tests can pass in-memory implementations.

**Phase 4 — `packages/bundle-workshop`.** Six tools (`bundle_init`, `bundle_build`, `bundle_test`, `bundle_deploy`, `bundle_rollback`, `bundle_versions`). Sandbox container Dockerfile update to mount read-only vendored workspace package snapshot with hash verification. Starter project templates. Pre-deploy smoke test. Deploy rate limiting. Workshop tool audit logging. Option A subagent target default; `selfEditingEnabled` flag accepted but rejected in this change.

**Phase 5 — Example, safety rails, docs.** New example `examples/bundle-workshop-agent` demonstrating the full edit → build → test → deploy → run loop. Out-of-band factory-reset HTTP endpoint on `defineLoaderAgent` DOs (privileged, authenticated via agent-auth). Per-entry bundle version tagging in session entries. Final cross-workspace typecheck and test runs. CLAUDE.md and README updates.

**Rollback strategy:** each phase is a discrete set of new packages and additive exports, except Phase 0.5 which modifies `agent-runtime` adapters. Rolling back Phase 0.5 means reverting the async conversion commits, which is mechanical but invasive — it's the riskiest rollback in the plan and is the reason Phase 0.5 has its own end-to-end test gate before Phase 1 starts. Rolling back any later phase means reverting that phase's commits with no effect on prior phases. Static agents are unaffected throughout. The sandbox container image version is bumped only at Phase 4; rolling back that phase requires also reverting the image tag.

## Open Questions

1. **~~Where does `LlmService` live~~** — **Resolved:** `packages/agent-bundle`. Decision 5.

2. **~~Where does `SpineService` live~~** — **Resolved:** `packages/agent-runtime/src/spine/`, exported via `@claw-for-cloudflare/agent-runtime/spine`. Decision 1.

3. **~~Does the bundle-side `AgentRuntime` need code changes, or do existing adapter interfaces work as-is?~~** — **Resolved:** yes, significant changes. `SessionStore` becomes async, `Transport` becomes send-only with separate client-message entry, isolate lifecycle is pinned. This is now Phase 0.5. Decision 1.

4. **What's the RPC batching strategy?** A naive implementation makes one RPC per state operation. Defer measurement to Phase 1 demo (Task 4.5); add batching only if numbers demand it. Phase 1's decision gate: if loader latency > 3× static latency, stop and batch before continuing. Open until measurement.

5. **~~How does `bundle_test` spawn a subagent with a loader-backed runtime?~~** — **Resolved:** `bundle_test` does its own scratch loader invocation, bypassing the existing `subagent` package. Adding a loader-backed profile to `subagent` is follow-up work. Decision 8 / proposal Modified packages.

6. **~~How is bundle metadata extracted?~~** — **Resolved:** option (a). Bundle author adds an optional `metadata` field to `defineAgentBundle({ metadata: { name, description, ... } })`. The workshop reads it from a dedicated metadata export when reading the compiled artifact. Phase 4 task.

7. **~~What is the exact contract for "the loaded bundle handles a turn"?~~** — **Resolved:** fetch handler that discriminates on URL path. Endpoints: `POST /turn` (prompt), `POST /alarm` (alarm fire), `POST /client-message` (incoming WebSocket message from DO transport), `POST /tool-execute-smoke` (smoke test), `POST /metadata` (metadata extraction). Decision 1 references this; spec details in `agent-bundle` and `loader-agent` specs.

8. **~~Does `defineLoaderAgent` need to accept `getCommands` / `validateAuth`?~~** — **Resolved:** yes, as host-side sibling config (NOT forwarded into the bundle). These are HTTP-route and auth concerns the host owns. The bundle has no equivalent. The `loader-agent` spec documents the field-by-field translation table from `defineAgent` to `defineLoaderAgent`.

9. **What happens on a loader factory exception during a cold turn?** Pinned partial answer: on N consecutive load failures of the active version (default N=3), the DO auto-reverts to `previous_version_id` from the registry and logs a poison-bundle deployment row. If no previous version exists, the DO loads the configured fallback bundle. Mid-turn dispatch failures return 5xx to clients with a structured error code that loader-aware clients can recognize. Specifics codified in `loader-agent` spec.

10. **~~Cost emission addressing between capability service and spine~~** — **Partially resolved, pending Spike 0.B:** the chosen path is option (a) — bundles pass their own capability token to capability services, capability services use the token to address the correct spine via a global SpineService binding (one entrypoint, identity from token). This requires that DurableObjectStub-as-RPC-arg is NOT needed because the spine is a WorkerEntrypoint, not a DO stub. Spike 0.B confirms whether stubs can be passed if we ever need option (c). Decision 11 obsoletes the original framing.

11. **NEW: Capability token TTL and clock skew.** Tokens have ~5min TTL. What happens if the host worker and the loader isolate are in different regions with clock skew? Workers run on Cloudflare's edge with NTP-synced clocks; clock skew is bounded. 5 minutes should be safely larger than any expected skew. Verify in Phase 1 testing.

12. **NEW: Capability token nonce tracking storage.** Single-use nonces require state. Where? Options: (a) DO `ctx.storage` (per-session nonce set with TTL eviction), (b) skip nonce enforcement entirely and rely on TTL alone. Lean: (a) for Phase 1, with TTL-based eviction to bound storage growth. Open until Phase 1 implementation.
