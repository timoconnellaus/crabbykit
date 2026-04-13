## ADDED Requirements

### Requirement: defineLoaderAgent consumer API

The system SHALL provide a `defineLoaderAgent<Env>(config)` function that returns a `DurableObject` class registerable in `wrangler.jsonc`. Config accepts as top-level fields: `loader` (factory returning the `WorkerLoader` binding), `registry` (factory returning a `BundleRegistry` instance — the registry internally encapsulates D1 and KV access), `bundleEnv` (projects host env to bundle env), `fallback` (static bundle used on registry miss or load failure), `authKey` (factory returning the HMAC key for capability tokens), and optional `hostCapabilities` (factory returning host-side capabilities that may contribute tools and prompt sections only — no hooks).

#### Scenario: Minimal loader agent definition
- **WHEN** a host worker declares
  ```ts
  export const MyAgent = defineLoaderAgent<Env>({
    loader: (env) => env.LOADER,
    registry: (env) => new D1BundleRegistry(env.BUNDLE_DB, env.BUNDLE_KV),
    bundleEnv: (env) => ({ LLM: env.LLM_SERVICE }),
    fallback: { model: () => ({ provider: "workers-ai", modelId: "@cf/meta/llama-3.1-8b-instruct" }), prompt: { agentName: "Unconfigured" } },
    authKey: (env) => env.AGENT_AUTH_KEY,
  })
  ```
- **THEN** the returned class is a valid Durable Object that, when instantiated, loads its active bundle from the registry and runs turns against it with HMAC-signed capability tokens

### Requirement: Per-turn bundle dispatch

For each `fetch`, `webSocketMessage`, or `alarm` invocation that requires running an agent turn, the loader agent DO SHALL resolve the active bundle version for the session, mint a per-turn capability token, obtain a Worker Loader handle keyed by the bundle's content-addressed version ID, inject the token into the bundle env, and dispatch the turn into the loader isolate. The DO SHALL NOT execute agent tools, capability hooks, or LLM calls in its own isolate.

#### Scenario: Warm turn dispatch
- **WHEN** a session has an active bundle version already cached by Worker Loader and a new prompt arrives
- **THEN** the DO mints a fresh capability token, resolves the version from `ctx.storage`, invokes the loader with the cached key, and the loaded bundle handles the turn without the loader factory running

#### Scenario: Cold turn dispatch
- **WHEN** a session has an active bundle version whose Worker Loader cache entry has been evicted
- **THEN** the DO invokes the loader, the factory fetches the bundle bytes from KV using the version ID, the loader compiles and caches the module, the bundle env receives a fresh capability token, and the turn proceeds

### Requirement: Capability token minting per turn

For every turn dispatch into a loader isolate, the DO SHALL mint a fresh HMAC-signed capability token binding `{agentId, sessionId, expiresAt: now + ttlMs, nonce}` using `authKey(env)` as the HMAC secret. Default TTL: 5 minutes. The token SHALL be passed to the loader factory as part of the bundle env under the well-known key `__SPINE_TOKEN`. The DO SHALL NOT reuse tokens across turns.

#### Scenario: Token minted with correct identity
- **WHEN** the DO dispatches a turn for `agentId=A`, `sessionId=S`
- **THEN** the minted token's verified payload contains `aid=A`, `sid=S`, `exp` in the future, and a unique nonce; the token is injected into the bundle's `env.__SPINE_TOKEN`

#### Scenario: New token per turn
- **WHEN** two separate turns arrive on the same session
- **THEN** each gets a freshly minted token with a different nonce; tokens are not cached or reused

### Requirement: Content-addressed loader cache keys

The loader cache key for a bundle SHALL be the bundle's content-addressed version ID (hex-encoded SHA-256 of the compiled artifact bytes, or a stable prefix thereof). Two bundles with identical content SHALL share the same cache slot. A new deployment SHALL produce a new version ID that cannot collide with previous versions.

#### Scenario: Different content produces different keys
- **WHEN** two deployments produce artifacts with different byte content
- **THEN** their version IDs differ and the loader cache stores them as separate entries

#### Scenario: Rollback reuses cached entry
- **WHEN** an agent rolls back to a previously-active version whose cache entry has not been evicted
- **THEN** the loader returns the cached module without re-reading from KV

### Requirement: Active version caching in DO storage

The loader agent DO SHALL cache its active bundle version ID in its own `ctx.storage` to avoid a registry lookup on the hot path. The cached pointer SHALL be invalidated/updated whenever a deploy or rollback completes via a refresh signal from the workshop. Reading the active version from storage SHALL be the first operation on the turn hot path and SHALL NOT fall through to a registry query unless the stored value is missing.

#### Scenario: Warm turn bypasses registry
- **WHEN** a turn begins on a DO whose `ctx.storage` already contains `activeBundleVersionId`
- **THEN** no D1 query is issued during turn dispatch; the loader is invoked with the stored ID directly

#### Scenario: Deploy invalidates cached pointer
- **WHEN** the workshop signals the DO that a deploy has completed for this agent
- **THEN** the DO's `activeBundleVersionId` in `ctx.storage` is updated to the new version ID before the next turn begins

### Requirement: Fallback bundle semantics

If the loader agent's registry contains no active version for the agent, OR if the active version's KV bytes are missing, OR if loading the active version raises a load-time exception N consecutive times (default N=3), the DO SHALL load the configured fallback bundle and SHALL log a poison-bundle deployment row in the registry. The fallback bundle SHALL be treated as a read-only baseline and SHALL NOT be persisted to the registry as if it had been deployed.

#### Scenario: Cold start with empty registry
- **WHEN** a loader agent DO receives its first turn and the registry has no active version row for this agent
- **THEN** the DO loads the fallback bundle in a loader isolate and runs the turn against it

#### Scenario: Auto-revert on N consecutive load failures
- **WHEN** a bundle that loaded successfully at deploy time crashes during cold load on the next 3 consecutive turns
- **THEN** the DO calls `registry.rollback(agentId, { rationale: "auto-revert: poison bundle" })` if a previous version exists, OR loads the fallback bundle if not, AND logs a poison-bundle entry to `bundle_deployments`

#### Scenario: Fallback not registered
- **WHEN** the fallback bundle runs and the turn completes
- **THEN** no row is inserted into the registry's `bundle_versions` or `bundle_deployments` tables for the fallback (other than poison-bundle log entries that reference the failed version IDs)

### Requirement: bundleEnv projection

The host worker SHALL be the exclusive source of bundle env values. The `bundleEnv` factory function receives the host `env` and returns a new object that becomes the loaded bundle's env (with the capability token injected by the DO under `__SPINE_TOKEN`). The DO SHALL pass this projected env as the `env` field of the loader factory return value. Native bindings NOT explicitly proxied through a service binding SHALL NOT appear in the projected bundle env. The DO SHALL validate the projection's serializability before invoking the loader; non-serializable values trigger fallback bundle loading and log an error.

#### Scenario: Bundle env restricted to service bindings and primitives
- **WHEN** a host declares `bundleEnv: (env) => ({ LLM: env.LLM_SERVICE, TIMEZONE: "UTC" })`
- **THEN** the loaded bundle sees `{ LLM, TIMEZONE, __SPINE_TOKEN }` in its env and has no access to any other host binding

#### Scenario: Attempted native binding projection
- **WHEN** a host declares `bundleEnv: (env) => ({ AI: env.AI })` with `env.AI` being the raw Cloudflare Workers AI binding
- **THEN** the DO catches the projection failure (DataCloneError) and falls back per the fallback bundle semantics, logging the configuration error

### Requirement: Out-of-band factory-reset HTTP endpoint

`defineLoaderAgent` DOs SHALL expose an HTTP endpoint at `POST /bundle/factory-reset` that, when called, restores the DO's active bundle to the configured fallback bundle. This endpoint SHALL be authenticated via the existing `agent-auth` mechanism and SHALL be reachable independent of the bundle's load state — it MUST NOT be implemented inside the loaded bundle, so a broken bundle cannot disable its own recovery path. The endpoint SHALL log a factory-reset entry to `bundle_deployments` for audit.

#### Scenario: Privileged caller resets a bricked agent
- **WHEN** an authenticated operator sends `POST /bundle/factory-reset` to a DO whose active bundle is broken
- **THEN** the DO clears its `ctx.storage.activeBundleVersionId`, the next turn loads the fallback bundle, and a `bundle_deployments` row records the reset with rationale `"factory-reset"`

#### Scenario: Unauthenticated reset rejected
- **WHEN** an unauthenticated request hits `POST /bundle/factory-reset`
- **THEN** the DO returns 401 without modifying any state

### Requirement: Per-entry bundle version tagging

Session entries created during turns dispatched through a loader-backed agent SHALL be tagged with the bundle version ID that was active at the time the entry was created. Tagging SHALL use a custom metadata field on the session entry record. This enables session replay to reconstruct which bundle produced each entry, even after subsequent deploys.

#### Scenario: Entry tagged with active version
- **WHEN** a turn runs against bundle version `abc123` and produces a new assistant message entry
- **THEN** the entry's metadata includes `bundleVersionId: "abc123"`

#### Scenario: Replay across deploys
- **WHEN** a session has entries from multiple bundle versions over its lifetime
- **THEN** querying entries returns them with their original `bundleVersionId` tags intact, allowing reconstruction of which bundle authored each entry

### Requirement: Field-by-field translation from defineAgent

`defineLoaderAgent` SHALL document a translation table for every field accepted by `defineAgent`, indicating whether the field lives in the host config, the bundle, or is unsupported in loader-backed mode. Fields requiring host-side native bindings or live function references that cannot cross the loader boundary (`a2a.getAgentStub`, `validateAuth`, `getCommands`) SHALL live in the host config. Fields that the bundle controls (`model`, `prompt`, `tools`, `capabilities`) SHALL live in the bundle. Fields with no clean translation (`subagentProfiles`) SHALL be marked unsupported in this change with deferral notes.

#### Scenario: Translation table documented
- **WHEN** a developer reads the `defineLoaderAgent` documentation
- **THEN** every `defineAgent` field is listed with its loader-backed equivalent or marked deferred

### Requirement: Coexistence with static defineAgent

The introduction of `defineLoaderAgent` SHALL NOT alter the behavior, API, or performance characteristics of existing `defineAgent()` consumers. Both entry points SHALL remain available in the same worker and both SHALL produce runnable DO classes. The Phase 0.5 `SessionStore` async refactor SHALL preserve all existing static-agent test behavior.

#### Scenario: Mixed static and loader agents in one worker
- **WHEN** a host worker exports both a `defineAgent`-created class and a `defineLoaderAgent`-created class, registered in `wrangler.jsonc` as separate DO bindings
- **THEN** both DOs run correctly with no interference, and static agents exhibit no functional regression relative to the pre-change implementation
