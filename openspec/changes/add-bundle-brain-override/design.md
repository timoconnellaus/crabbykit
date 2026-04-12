## Context

CLAW's `packages/agent-runtime` already implements a static agent runtime: `defineAgent({...})` returns a `DurableObject` class with sync `SessionStore`, callback-based `Transport`, in-memory per-session `Agent` instances, and an LLM loop wired through pi-agent-core. The DO owns sessions, alarms, hibernation, WebSocket lifecycle, and all client-facing surfaces. This works well for the static case and we have no intent to change its public API.

A previous change `add-agent-bundles` attempted to introduce loader-backed (bundle) agents as a parallel SDK. Three rounds of adversarial review surfaced fundamental problems with that approach:

- **Public API breakage**: making `SessionStore` async to support RPC-backed adapters required changing `CapabilityHookContext.sessionStore` and `AgentSetup.sessionStore`, both public surfaces, breaking every existing capability package and `defineAgent` consumer.
- **Isolate pinning vs content addressing**: trying to share `AgentRuntime` warm state inside loader isolates required per-session pinning of the loader's cache key, which directly contradicted the content-addressed-versioning design goal that lets two agents share the same compiled bundle in the loader cache.
- **Per-turn token vs warm runtime**: capability tokens minted per turn embedded in adapter clients meant `AgentRuntime` couldn't outlive a single turn, but rebuilding it every turn destroyed the per-session warm state needed for steer/abort.

These were not patchable in the parallel-SDK framing. They were consequences of treating bundles as a peer of static agents and trying to share runtime infrastructure between them.

The reframing in this change resolves all three: **the bundle is not a separate runtime; it is an inference-loop override on the same agent.** The static `AgentRuntime` owns everything it owns today. The bundle, when registered, takes over only the inference loop for one turn at a time, runs its own small async runtime inside a loader isolate, calls back to the host DO via `SpineService` for state operations, and exits. The DO retains all warm state, all transport, all session ownership. Bundles are stateless per turn. There is no "bundle agent" type — there are agents, some of which optionally support brain override via bundles.

The key insight is that the static brain (defined at compile time via `defineAgent`) is *always* the agent's identity and is *always* available as the recovery path. Bundles are an additive override, not a replacement. Self-editing is safe by construction because removing an active bundle reverts to the static brain.

## Goals / Non-Goals

**Goals:**
- Add bundle support to CLAW as an **opt-in `defineAgent` config field** with zero impact on consumers who don't use it.
- Preserve the entire existing `agent-runtime` public API without modification — `SessionStore`, `Transport`, `AgentSetup`, `CapabilityHookContext`, `AgentRuntime`, `AgentDO`, every existing capability — all unchanged. No async migration.
- Provide a separate, smaller, async-by-default bundle runtime in `packages/agent-bundle` that runs inside Worker Loader isolates and uses RPC to talk to the host DO for state operations.
- Authorize all bundle ↔ host RPC via per-turn HMAC capability tokens that derive identity from the verified payload, not from caller arguments. Make session/cost forgery structurally impossible.
- Establish the static brain as the always-available fallback that runs whenever no bundle is registered AND as the automatic recovery path when a bundle becomes inactive.
- Provide a sandbox-based authoring workflow (bundle workshop) where agents can edit, build, test, deploy, and roll back their own bundles from inside their own session.
- Make self-editing safe by default. Bundle deploys default to deploying to the invoking agent's own bundle pointer; the static fallback ensures this is recoverable.
- Establish the capability service pattern (`index` + `service` + `client` + `schemas` subpaths) as the convention for capability packages that hold secrets, with Tavily as the pilot. Static-only consumers of those packages remain unaffected.

**Non-Goals:**
- Generic loader-host DO that dispatches many unrelated agents from a single class. That's a future architectural option built on top of this change, not delivered by it.
- Migration of existing static agents to bundle-based. Static agents stay static unless their authors explicitly add the `bundle` config field.
- GC / pruning of old KV bundle entries. The registry will accumulate; we add a GC tool later.
- Streaming bundle loading or partial evaluation. Bundles are whole-artifact loads keyed by content hash.
- Non-Tavily capability service splits. Tavily is the pilot; other packages stay static-only and are addressed on demand.
- Cross-worker bundle sharing beyond the registry-as-content-store. Agents on the same worker can share bundle bytes via content-addressed dedup; cross-worker sharing is a future concern.
- HMAC `AGENT_AUTH_KEY` rotation. Single secret with manual rotation via redeploy is acceptable for v1.
- Bundle source editing via the registry. The registry holds compiled artifacts; source editing happens in the sandbox container filesystem via existing sandbox file tools.
- Replacing the static brain with a bundle. The static fields on `defineAgent` are still required when bundle support is enabled; they define the agent's identity and recovery path. There is no "bundle-only agent" mode in this change.

## Decisions

### 1. The bundle is an inference-loop override, not a separate agent

**Decision:** A bundle-enabled agent is a single `defineAgent`-produced DO class with one new optional config field (`bundle`). The DO's `handleTurn` checks for an active bundle in the registry on every turn; if one exists, it dispatches the inference loop into that bundle via Worker Loader; if not, it runs the existing static `AgentRuntime` path unchanged. The DO retains ownership of session state, alarms, transport, hibernation, WebSocket connections, and per-session warm state. The bundle is invoked stateless-per-turn and exits when the turn completes. From outside the DO — clients, sessions, observers — there is no observable difference between an agent running its static brain and the same agent running a registered bundle, except that the produced events may differ in content.

**Alternatives considered:**
- **Bundles as a peer SDK** with their own DO class, runtime, and adapter interfaces (the previous `add-agent-bundles` approach). Rejected after three review rounds: required public API breakage of `SessionStore` and `Transport`, created an isolate-pinning vs content-addressing contradiction, and broke per-session warm state.
- **Bundles as subagents of a parent static agent** (one of the previous proposal's framings). Rejected: introduces a parent-child indirection that has no client-facing meaning, requires routing requests through a parent before reaching a "subagent," and fragments the agent identity.
- **Bundles replace the entire `defineAgent`** (the brief "everything is a bundle" framing). Rejected: forces every static-agent consumer to author bundles even if they don't need self-editing, taxes the 95% case for the 5% case, creates a build-step dependency for trivial agents.
- **Chosen: brain override on the same agent.** Bundle support is opt-in via one config field. The DO is unchanged externally. The runtime path is "if bundle, dispatch; else static." The static brain is the agent's identity and its safety net.

**Rationale:** This is the smallest possible API change that delivers the use case. The static side gains one config field and one dispatch check. The bundle side is a separate runtime in a separate package that consumers opt into. Static-only consumers see literally nothing different. Bundle-enabled consumers add one field and pay only for what they use.

### 2. Two runtimes, no shared interfaces, bridged by a service binding

**Decision:** The static `AgentRuntime` (in `packages/agent-runtime`) is unchanged: sync `SessionStore`, callback `Transport`, today's adapter interfaces. The bundle runtime (in `packages/agent-bundle`) is a new, separate, smaller runtime designed clean-sheet for the loader-isolate use case: async `SessionStoreClient`, send-only `SessionChannel` for outgoing events, incoming client events delivered as method calls on the bundle's default export. The two runtimes share concepts (capabilities, tools, sessions, costs, agent events) but not interfaces. They communicate via JSRPC across a service binding boundary: the bundle's async `SessionStoreClient` calls `SpineService.appendEntry(token, entry)` on the host worker, which on the host side invokes the DO's existing sync `sessionStore.appendEntry(entry)` and returns. The async/sync impedance is resolved at the service binding edge, not in shared types.

**Why this works where the previous design failed:** the previous design tried to make the static `SessionStore` itself async-compatible by introducing a `SessionStoreClient` interface that both the static side and the bundle side would implement. That forced the public capability API surface to change. In this design, the static `SessionStore` does not change at all. The bundle side has its OWN `SessionStoreClient` that is *internal to the bundle runtime* and not exposed to capability authors. Capability authors who write bundle-side hooks see the bundle's hook context (which has an async `sessionStore`); capability authors who write static-side hooks see the existing static hook context (which has a sync `sessionStore`). Same capability concept, two implementation surfaces, no public-API merge required.

**Alternatives considered:**
- **Shared async interface**: rejected, breaks public API.
- **Shared sync interface**: impossible, sync calls cannot cross JSRPC.
- **Chosen: parallel interfaces, bridge at the service binding boundary.**

**Rationale:** Each runtime can be optimized for its host environment without compromise. The static runtime stays simple and sync. The bundle runtime is small and async by design. The bridge is one method-by-method translation in `SpineService` — about as small as it can possibly be.

### 3. Per-turn capability token authorization

**Decision:** Every method on `SpineService`, `LlmService`, and capability service classes takes a sealed HMAC-SHA256 capability token as its first argument. The token binds `{agentId, sessionId, expiresAt, nonce}` to a specific turn. The host DO mints the token at turn dispatch time using `AGENT_AUTH_KEY`. Services verify the token on receive and derive identity (agentId, sessionId) from the verified payload. **Method signatures do NOT accept `sessionId` as an argument** — identity is structural, not advisory. A bundle cannot forge a token (it lacks the HMAC key) and cannot tamper with the verified identity (the token IS the identity).

**Token format:**
```
token = base64url(payload) + "." + base64url(hmac_sha256(subkey, base64url(payload)))
payload = { aid: string, sid: string, exp: number, nonce: string }
```

**HKDF-derived per-service subkeys:** the host DO holds the master `AGENT_AUTH_KEY`. Each service entrypoint (`SpineService`, `LlmService`, `TavilyService`, etc.) gets its own verify-only subkey derived via HKDF (`subkey = HKDF(AGENT_AUTH_KEY, "claw/spine-v1")`, etc.) at startup. The host DO holds all subkeys for minting; each service holds only its own subkey. A compromised service cannot mint tokens for itself or any other service — it can only verify tokens minted for it.

**Replay protection:** TTL is ~5 minutes. Within TTL, single-use enforcement via per-session nonce tracking in DO `ctx.storage` with bounded LRU eviction. Nonce store growth is bounded by per-agent quotas; exceeding the quota returns a structured error.

**Alternatives considered:**
- **Trust caller-supplied identity** (the original draft of `add-agent-bundles`). Rejected: enables forgery from inside an adversarial bundle.
- **Single shared HMAC key across all services**. Rejected: a compromise of any one service is a universal forgery primitive. HKDF subkeys bound the blast radius.
- **Long-lived tokens** (per-session, not per-turn). Rejected: expands the replay window to the session lifetime.
- **Stateful opaque tokens stored in a registry**. Rejected: requires cross-isolate state lookups on every RPC. HMAC verification is stateless and faster.
- **Chosen: stateless HKDF-subkey HMAC tokens, one per turn, used by all RPC surfaces.**

**Rationale:** The smallest mechanism that makes the "bundles are untrusted" invariant enforceable. Microsecond verification cost per RPC. Structural impossibility of identity forgery rather than disciplined convention.

### 4. Static brain is the always-available fallback

**Decision:** A bundle-enabled agent's static `defineAgent` fields (`model`, `prompt`, `tools`, `capabilities`) are still required when `bundle` support is added. They define the agent's static brain, which (a) runs whenever no bundle is registered for this agent, and (b) automatically takes over when a deployed bundle becomes inactive (manual disable, automatic poison-bundle revert, registry corruption). There is no separate "fallback bundle" config because the static fields ARE the fallback. There is no "factory reset to fallback" because the static brain is always present.

**What this means concretely:**
- A bundle-enabled agent with no registered bundle behaves identically to a pure static agent. Same code path, same performance.
- A bundle-enabled agent with a registered-but-broken bundle reverts to the static brain after N consecutive load failures (default N=3) by setting `active_version_id = NULL` in the registry and logging a poison-bundle entry.
- A bundle-enabled agent with a registered-and-working bundle runs the bundle on each turn, but the static brain is one config flip away.
- The privileged `POST /bundle/disable` HTTP endpoint clears the active version pointer for the agent, forcing the static brain on the next turn.

**Why this matters:** the previous design's "factory reset endpoint" was a separate piece of infrastructure required to recover from broken bundles. In the brain-override model, the static brain is always there — disabling the bundle is the recovery, and the static brain is what runs after recovery. No additional safety infrastructure is needed beyond clearing a registry pointer.

**Rationale:** Self-editing is safe by construction. The agent can author bundles for itself, deploy them, and even break itself, and the recovery path (static brain) is always available. No separate "Option A vs Option B" decision because Option B (self-editing) is safe by default.

### 5. Content-addressed bundle version IDs

**Decision:** Bundle version IDs are SHA-256 hashes (hex-encoded) of compiled bundle artifact bytes. The version ID is the KV key suffix (`bundle:{versionId}`) AND the Worker Loader cache key. Two bundles with identical content share the same version ID, the same KV entry, and the same Worker Loader cache slot.

**Important constraint surfaced by previous review:** Two agents that end up with the same content-addressed version ID share a Worker Loader cache slot, which means they share an isolate. This is **safe in this design** because **bundles are stateless across turns** — they hold no per-session state in the loader isolate. Every turn rebuilds whatever it needs from the verified token-derived identity and from spine-fetched session context. There is no `sessionAgents: Map` in the bundle. There is no warm state to leak between tenants sharing the same isolate. Module-level mutable state in bundle code is still discouraged (lint rule, documentation), but the security model does not depend on bundle code being well-behaved with module state — the capability token model ensures all spine operations are structurally scoped to the verified caller.

**Alternatives considered:** monotonic versions, semver, UUIDs — all rejected for the reasons in the previous proposal. Content addressing wins on determinism, dedup, and cache invalidation race elimination.

### 6. KV readback verification on deploy

**Decision:** `bundle_deploy` does not consider a deploy successful when `kv.put()` returns. After writing, the workshop polls `kv.get()` with exponential backoff (50ms, 100ms, 200ms, 400ms, 800ms, 1600ms, 2000ms; capped at ~5s) until the bytes are visible, THEN inserts the `bundle_versions` row in D1, THEN updates the active pointer via `setActive`. If readback times out, the deploy fails and the registry pointer is unchanged. Orphan KV entries from failed deploys are tolerated and cleaned up by the eventual GC tool.

**Why:** Cloudflare KV is documented as eventually consistent across locations with up to a 60-second window. The previous proposal incorrectly assumed write-your-own-reads consistency within the same DO. Polling readback before flipping the active pointer ensures the next turn's loader factory finds the bytes.

### 7. Sandbox container with read-only vendored snapshot and integrity verification

**Decision:** The `SandboxContainer` Dockerfile vendors a snapshot of `@claw-for-cloudflare/*` bundle-authoring packages at `/opt/claw-sdk/`, mounted **read-only** at runtime. The image build generates `/opt/claw-sdk/INTEGRITY.json` with SHA-256 hashes of every vendored file. `bundle_build` verifies the integrity manifest before running `bun build`. `bundle_init` scaffolds `package.json` with `file:/opt/claw-sdk/...` references so `bun install --ignore-scripts` resolves offline.

**Why read-only and integrity-checked:** an adversarial bundle has access to the sandbox container's filesystem via existing sandbox file tools. Without read-only and integrity checks, a malicious bundle could modify the vendored packages between builds, compromising any subsequent build. Read-only mount + hash verification + `--ignore-scripts` close this attack surface.

### 8. Bundle workshop self-editing as default (with safety net)

**Decision:** `bundle_deploy` defaults to deploying to the invoking agent's own bundle pointer. There is no `selfEditingEnabled` flag because self-editing is safe by default — the static brain is always available as recovery. The workshop accepts an optional `targetAgentId` argument for cross-agent deploys (an agent authors a bundle for a different agent), but the common case is self-editing.

**Why this is safer than the previous "Option A only" framing:** the previous design deferred self-editing because a bricked self-editing agent had no recovery path. In the brain-override model, the recovery path is built in — disabling the bundle reverts to the static brain. A bricked deploy is recoverable via `bundle_disable` from inside the agent (if it can still run a turn) OR via the privileged `POST /bundle/disable` HTTP endpoint (if the bundle is failing to even load). Either path restores the static brain.

### 9. Capability service pattern via four subpath exports

**Decision:** Capability packages that hold secrets adopt a four-subpath layout: `index.ts` (legacy static-agent factory, unchanged), `service.ts` (host WorkerEntrypoint with credentials, token-verifying), `client.ts` (bundle-side capability factory taking `Service<T>`), `schemas.ts` (shared tool schemas with content hash for drift detection). Tool execute logic lives in `service.ts`. The bundle-side client thin-proxies to the service via JSRPC with the bundle's capability token as the first argument. Cost emission lives in the service, attributed via the verified token. Capability packages without secrets get only a `bundle.ts` (or equivalent) subpath alongside their `index.ts`, sharing logic via a private internal module.

**Why four subpaths:** the package's `exports` field physically enforces the security boundary. The bundle subpath cannot import the service subpath. The shared schemas subpath gives both sides access to tool definitions without forcing the bundle to import the service implementation.

### 10. Bundle replaces the static brain entirely for the duration of one turn

**Decision:** When a bundle is active and a turn dispatches into it, the bundle's brain (model, prompt, tools, capabilities) entirely replaces the static brain for that turn. The static `defineAgent` capabilities are dormant when a bundle is running; only the bundle's capabilities are active. This is cleaner than trying to merge static and bundle capabilities.

**Why not merge:** merging would require running both the static and bundle capability hook chains in some order, which raises ordering questions, conflict-resolution questions, and observability questions. "The bundle is the brain right now" is a simpler and more defensible mental model. If a consumer wants both static and bundle capabilities, they include both in the bundle.

**Alternatives considered:**
- **Merged hook chains** (static hooks + bundle hooks). Rejected: ordering ambiguity, capability conflict resolution, harder to reason about.
- **Static capabilities always run, bundle adds extra**. Rejected: same problem in different shape, plus the static side needs to know which capabilities to skip when the bundle provides equivalents.
- **Chosen: bundle brain replaces static brain for the duration of its turn.**

### 11. Steer/abort routing

**Decision:** The DO continues to own the WebSocket and the in-flight turn tracking. When a turn dispatches into a bundle, the DO retains a handle to the in-flight bundle invocation (the underlying `ReadableStream` of agent events from `bundle.handleTurn`). When a steer or abort message arrives via WebSocket, the DO either (a) cancels the underlying stream (abort) or (b) calls a separate `POST /client-event` endpoint on the bundle with the steer message (steer). The bundle's runtime handles the client event by adjusting the in-flight inference loop or returning a noop. If the bundle's isolate has been evicted between the original turn and the steer, the steer is lost — this is a known limitation, documented, and matches today's behavior under static-agent isolate restart.

**Alternatives considered:**
- **Bundle exposes a long-lived stream that the DO writes into** via JSRPC. Rejected: complicates the bundle contract, requires bidirectional streams across JSRPC.
- **Chosen: separate `POST /client-event` endpoint on the bundle, called by the DO when client events arrive.**

## Risks / Trade-offs

- **[Per-turn RPC chatter]** Every session entry append, every broadcast, every KV get from inside the bundle becomes a service binding RPC back to the host DO's `SpineService`. A typical turn does 10-30 of these. → **Mitigation:** measure in Phase 1 demo. Add batching to bundle-side adapter clients (e.g., flush appendEntry calls at end of turn) if numbers warrant. Same-worker service binding latency is typically single-digit milliseconds; total RPC overhead per turn should be under 200ms.

- **[Worker Loader cold-start latency]** First-turn dispatch into a freshly-uploaded bundle pays the loader compile cost. For bundles around 100-500 KB, this is single-digit milliseconds. → **Mitigation:** Phase 0 baseline measurement on a realistic bundle. Warm cache hits are essentially free.

- **[pi-agent-core import inside loader isolate]** The known `loadPiSdk()` workaround in `agent-do.ts` may or may not compose with Worker Loader's module resolution. → **Mitigation:** Phase 0 spike verifies before any other implementation. If the import fails, the bundle runtime ships without pi-agent-core integration and provides its own thinner inference loop wrapper for v1 (still routed through `LlmService`); pi-agent-core integration becomes follow-up work.

- **[Capability token nonce store growth]** Tracking single-use nonces in DO storage accumulates state. → **Mitigation:** bounded LRU per session with TTL eviction; per-agent nonce quota; structured error on quota exhaustion. Nonces older than the token TTL are safe to evict (they cannot be replayed against an expired token).

- **[Bundle module-level state across content-addressed isolate slots]** Two agents with the same bundle content share an isolate. → **Mitigation:** capability tokens make all spine operations structurally tenant-scoped, so module state cannot affect the wrong agent at the operation level. Bundle authoring documentation discourages module-level mutable state. Lint rule may be added.

- **[bundle_test container isolation]** The candidate bundle under test runs in a scratch loader isolate, but the parent's sandbox container is shared. → **Mitigation:** the candidate bundle's env is constructed with no parent credentials, no parent capability service stubs, and a fresh scratch sessionId. The bundle has no access to the parent's session, credential store, or filesystem at the spine level. Container-level isolation (separate namespace, fresh container instance) is a Phase 4 design point — if simple "scratch env, no parent bindings" is insufficient, a fresh container instance per test is the fallback.

- **[Read-only mount on Cloudflare Containers]** The sandbox container's `/opt/claw-sdk/` mount needs to be read-only at runtime. Cloudflare Containers documentation does not explicitly cover per-path read-only mounts. → **Mitigation:** verified in Phase 4 with a small spike before Phase 4 implementation lands. If read-only mount is not achievable, fallback is integrity verification at every `bundle_build` call (TOCTOU is still possible but the window is small).

- **[Schema hash forgery]** The bundle-side client passes a schema content hash to the service for drift detection. A malicious client could pass a forged hash. → **Mitigation:** schema hash is a defensive consistency check, not a security boundary. The service independently validates incoming arguments against its own schema using TypeBox Check. The hash is for early-error detection, not authentication.

- **[KV-then-D1 race orphans]** Deploy writes to KV, polls readback, then writes to D1. If D1 fails after KV succeeds, there's an orphan in KV. → **Mitigation:** orphans are unreferenced (no pointer points at them), they consume KV quota but do not affect agent behavior, and the eventual GC tool will clean them up. Deploy rate limiting bounds the orphan accumulation rate.

- **[D1 batch atomicity]** Multi-statement registry operations (setActive + insert deployment log) require D1 `db.batch([...])`, not sequential `.run()` calls. → **Mitigation:** registry implementation uses `db.batch()` for any multi-statement operation. Code review and tests verify this.

- **[Loader factory exception during cold turn]** If a deployed bundle fails to load, the DO cannot dispatch the turn. → **Mitigation:** N consecutive load failures (default N=3) trigger automatic fallback to the static brain plus poison-bundle log entry. Out-of-band `POST /bundle/disable` endpoint provides a privileged manual recovery path.

## Migration Plan

This change is purely additive. No existing static agents are migrated. Phases:

**Phase 0 — Spikes (gating).**
  - **Spike 0.A**: pi-agent-core import inside a Worker Loader isolate. Hand-write a minimal bundle, compile via `bun build`, load, verify. Outcome: green proceeds; red triggers fallback design (bundle runtime without pi-agent-core integration; provide thinner inference loop wrapper directly).
  - **Spike 0.B**: Cold-start latency baseline. Compile a representative bundle (`pi-agent-core` + `pi-ai` + 2-3 capabilities), measure size and cold-load latency. Compare against static `AgentDO` baseline.
  - **Spike 0.C**: Read-only mount feasibility on Cloudflare Containers. Verify that `/opt/claw-sdk/` can be mounted read-only inside the SandboxContainer at runtime, and that writes to it produce EROFS. If not, document the alternate (per-build integrity check) and accept the smaller TOCTOU window.
  - **Decision checkpoint**: green/red on each spike → proceed to Phase 1.

**Phase 1 — `packages/agent-bundle` core.**
  - Bundle authoring API (`defineBundleAgent`), `BundleEnv` constraint type, bundle default-export contract (handleTurn, handleClientEvent, handleAlarm, handleSessionCreated, metadata).
  - Bundle-side small async runtime: `SessionStoreClient` interface, `SessionChannel` send-only, async `CapabilityHookContext`, capability registration, hook chain execution.
  - Capability token mint/verify utilities (HMAC, HKDF subkey derivation, nonce tracking helpers).
  - End-to-end test: a hand-compiled bundle runs one turn against an in-process mock spine.

**Phase 2 — `bundle` field on `defineAgent`, dispatch, and `SpineService`.**
  - Add optional `bundle` config field on `AgentSetup` in `packages/agent-runtime`.
  - Add per-turn dispatch check inside `AgentDO.handleTurn` (and `webSocketMessage` for client events). When `bundle` config is present and an active version is registered, dispatch into the bundle; else run the static path unchanged.
  - Add `SpineService` WorkerEntrypoint class in `packages/agent-bundle` with token verification and methods that bridge to the host DO's existing sync `SessionStore`, `KvStore`, `Scheduler`, `Transport`, and cost emission.
  - Per-turn capability token minting on the host DO side; HKDF subkey derivation at host startup.
  - End-to-end test: a real `defineAgent`-produced DO with bundle config loads a hand-compiled bundle from a hardcoded source and runs a turn.
  - **Decision gate**: per-turn RPC count and total turn latency vs static baseline. If loader latency > 3× static, add batching before continuing.

**Phase 3 — `LlmService` and capability service pattern (Tavily pilot).**
  - `LlmService` WorkerEntrypoint in `packages/agent-bundle`. Multi-provider routing, token verification, error sanitization, per-agent rate limiting, cost emission via spine RPC.
  - Bundle-side `ServiceLlmProvider` adapter wired to `env.LLM_SERVICE`.
  - `packages/tavily-web-search` gains `service`, `client`, `schemas` subpath exports. Legacy `index.ts` unchanged. Cost emission via spine.
  - Phase 2 demo upgraded: bundle uses OpenRouter via `LlmService` and Tavily search via the client subpath, with zero secrets in bundle source.

**Phase 4 — `packages/bundle-registry`.**
  - D1 schema with self-seeding migration (`bundle_versions`, `agent_bundles`, `bundle_deployments`).
  - Content-addressed version IDs, KV bundle bytes storage, KV readback verification on deploy.
  - D1 `db.batch()` for atomic multi-statement operations.
  - `D1BundleRegistry` and `InMemoryBundleRegistry` (test) implementations.
  - DO `ctx.storage` cache of active bundle version per agent, refreshed on deploy/rollback signal.
  - Wire `defineAgent`'s bundle field to the registry.

**Phase 5 — `packages/bundle-workshop`.**
  - Six tools: `bundle_init`, `bundle_build`, `bundle_test`, `bundle_deploy`, `bundle_disable`, `bundle_rollback`, `bundle_versions`.
  - Sandbox container Dockerfile update: read-only `/opt/claw-sdk/` mount, integrity manifest, vendored bundle-authoring packages.
  - `bundle_deploy` defaults to invoking-agent's-own-bundle target (self-editing); accepts optional `targetAgentId`.
  - Pre-deploy smoke test, deploy rate limiting per agent, workshop tool audit logging.
  - Out-of-band `POST /bundle/disable` HTTP endpoint on bundle-enabled DOs.

**Phase 6 — Example, polish, docs.**
  - `examples/bundle-agent`: a single bundle-enabled agent demonstrating workshop, self-editing, fallback to static brain.
  - Per-entry bundle version tagging in session entries (DO stamps the tag).
  - CLAUDE.md updates: brain-override architecture section, bundle authoring tutorial, capability service pattern, secrets-and-token security model, four-layer cache hierarchy.
  - Final cross-workspace typecheck and test runs; verify zero static-agent regressions.

**Rollback strategy:** every phase is a discrete set of additive changes. Reverting a phase reverts only its changes, with no impact on prior phases. Static-only consumers are unaffected throughout. The `agent-runtime` change in Phase 2 is the most invasive single change but is small (one optional config field, one dispatch check); reverting it is mechanical.

## Open Questions

1. **Bundle replaces vs. merges with static capabilities.** Decision 10 says replaces. Confirm during Phase 2 implementation; if there's a real use case for "bundle adds tools on top of static capabilities," revisit, but the cleaner default is replacement.

2. **Capability token nonce storage location and eviction policy.** Decision 11 mentions per-session DO storage with bounded LRU. Specific bounds and eviction algorithm are open until Phase 2 implementation. The invariant must be: no nonce evicted before its token's exp time.

3. **Steer/abort routing across loader boundary.** Decision 11 specifies separate `POST /client-event` endpoint. Confirm this works under hibernation; if hibernation interacts badly with cold loader invocations on every client message, consider keeping lightweight client events (ping, abort) on the host DO path and only routing prompt/steer/command into the bundle.

4. **Bundle module-level state lint rule.** Decision 5 notes that bundles should not hold module-level mutable state because of content-addressed isolate sharing. A lint rule (or runtime warning) is mentioned but not specified. Defer to Phase 1 / Phase 6 docs unless there's an early-warning need.

5. **Bundle `metadata` field shape.** The bundle's optional metadata (declared model, capability list, name, description, version) is what the registry stores. Define the exact shape during Phase 1 / Phase 4 — likely `{ id, name?, description?, declaredModel?, capabilityIds?: string[], authoredBy? }`.

6. **Default deploy target — invoking agent's own bundle or first-class subagent concept?** The proposal says default is "invoking agent's own bundle" (self-editing), with optional `targetAgentId` for cross-agent. This is the simpler first ship. If subagent-as-first-class becomes a real use case, revisit in a follow-up. For now, deploying to a different agent ID is just a parameter, not a separate concept.

7. **What does the bundle's `metadata` endpoint return when the bundle declares no metadata?** Empty object? Default-derived from the declared model and tool names? Defer to Phase 1.

8. **Session entry tagging schema.** Per-entry `bundleVersionId` is stamped by the DO. Where in the entry shape does it live — top-level field, custom metadata, separate audit table? Defer to Phase 6.

9. **Cold-start vs warm-cache eviction policy on Cloudflare Worker Loader.** Out of our control. Phase 0 baseline records observed behavior; Phase 2 measures hot vs cold turn latency separately.

10. **What happens when a bundle is deployed that requires a capability service the host doesn't expose?** E.g., bundle imports `tavilyClient` and references `env.TAVILY` but the host's `bundleEnv` factory doesn't include it. The bundle's load-time validation should catch this and return a clear error before the bundle is registered as active. Implementation: smoke test verifies the bundle can construct its capability list against the projected `bundleEnv` without runtime errors.
