## ADDED Requirements

### Requirement: SpineService WorkerEntrypoint

The system SHALL provide a `SpineService` class extending `WorkerEntrypoint` that exposes the `AgentRuntime` adapter surfaces as RPC methods callable from a loader-loaded bundle. The class SHALL be exportable from the host worker's main module and registerable in `wrangler.jsonc` as a service binding with a designated entrypoint name. The class SHALL hold the `AGENT_AUTH_KEY` HMAC secret in its own env and SHALL NOT expose it via any return value or error message.

#### Scenario: Spine service registered and callable
- **WHEN** a host worker exports `class SpineService extends WorkerEntrypoint` and declares a service binding `{ binding: "SPINE", service: "host-worker", entrypoint: "SpineService" }`
- **THEN** code in another isolate that receives `env.SPINE` as a service binding can invoke its methods via JSRPC

### Requirement: Per-turn capability token verification

Every method on `SpineService` (other than internal lifecycle methods) SHALL take a sealed capability token string as its first argument. The token SHALL be an HMAC-SHA256-signed envelope binding `{agentId, sessionId, expiresAt, nonce}` to a specific turn invocation. SpineService SHALL verify the token using the constant-time HMAC verification utility before performing any operation. Verification SHALL reject (a) tokens with invalid signatures, (b) tokens whose `expiresAt` is in the past, (c) tokens whose nonce has already been consumed (single-use enforcement). Identity for all session-scoped operations SHALL be derived from the verified token payload only — caller-supplied `sessionId` arguments SHALL NOT exist in the method signatures.

#### Scenario: Valid token accepted
- **WHEN** a bundle calls `env.SPINE.appendEntry(token, entry)` with a token whose HMAC verifies, whose `expiresAt > now`, and whose nonce has not been consumed
- **THEN** the spine extracts `agentId` and `sessionId` from the verified payload, persists the entry under that session, and marks the nonce as consumed

#### Scenario: Tampered token rejected
- **WHEN** a bundle calls any spine method with a token whose payload bytes have been modified after signing
- **THEN** the HMAC verification fails, the method returns a structured `ERR_BAD_TOKEN` error without performing any state change, and no log entry exposes the bundle's attempted target

#### Scenario: Expired token rejected
- **WHEN** a bundle calls any spine method with a token whose `expiresAt` is earlier than `Date.now()`
- **THEN** the method returns a structured `ERR_TOKEN_EXPIRED` error without performing any state change

#### Scenario: Replayed token rejected
- **WHEN** a bundle calls any spine method twice with the same token (same nonce)
- **THEN** the second call returns a structured `ERR_TOKEN_REPLAY` error

### Requirement: Session store RPC surface

`SpineService` SHALL expose async methods covering the `SessionStoreClient` async interface introduced in the Phase 0.5 adapter refactor: `appendEntry(token, entry)`, `getEntries(token, options)`, `getSession(token)`, `createSession(token, init)`, `listSessions(token, filter)`, `buildContext(token)`, `getCompactionCheckpoint(token)`. Each method derives its target session from the token. All arguments and return values SHALL be JSON-serializable.

#### Scenario: Bundle appends a session entry via spine
- **WHEN** a bundle calls `await env.SPINE.appendEntry(token, { role: "assistant", content: "..." })` with a valid token whose `sessionId` is `"session-1"`
- **THEN** the entry is persisted in the host DO's SQLite session store under `session-1` and is visible to a subsequent `getEntries(token, options)` call from any token with the same sessionId

#### Scenario: Bundle cannot write to a session it does not own
- **WHEN** a bundle holds a valid token for `sessionId: "session-A"` and constructs a separate token for `sessionId: "session-B"` (which it cannot do without the HMAC key)
- **THEN** there is no method signature that accepts a target sessionId, and the bundle has no path to write into `session-B`

### Requirement: KV store RPC surface

`SpineService` SHALL expose `kvGet(token, capabilityId, key)`, `kvPut(token, capabilityId, key, value, options?)`, `kvDelete(token, capabilityId, key)`, and `kvList(token, capabilityId, prefix)` methods that provide each capability with its scoped persistent KV storage. The token's verified identity SHALL scope the storage namespace; the `capabilityId` argument SHALL further scope per capability. Values SHALL be JSON-serializable.

#### Scenario: Capability persists state via spine KV
- **WHEN** a capability running in a bundle calls `env.SPINE.kvPut(token, "my-capability", "counter", 42)` and then `env.SPINE.kvGet(token, "my-capability", "counter")`
- **THEN** the second call returns `42`, scoped to the verified agent identity

### Requirement: Scheduler RPC surface

`SpineService` SHALL expose `scheduleCreate(token, schedule)`, `scheduleUpdate(token, scheduleId, patch)`, `scheduleDelete(token, scheduleId)`, `scheduleList(token)`, and `alarmSet(token, timestamp)` methods that allow a bundle to manage cron-based schedules and DO alarms owned by the host DO. Schedules SHALL be scoped by the token-derived agentId.

#### Scenario: Bundle sets an alarm via spine
- **WHEN** a bundle calls `await env.SPINE.alarmSet(token, timestamp)` with a valid token
- **THEN** the host DO's `alarm()` method is invoked at the specified time and the DO dispatches into the loader for alarm handling, scoped to the agent identified by the original token

### Requirement: Transport-out RPC surface (send-only)

`SpineService` SHALL expose `broadcast(token, message)` and `broadcastGlobal(token, message)` methods that deliver transport messages to connected WebSocket clients. The `broadcast` method's target session is derived from the token. Bundle-side streaming output SHALL be emitted via these RPC calls. The transport surface SHALL be send-only — bundles SHALL NOT have a method to register or receive incoming WebSocket messages via spine RPC. Incoming client messages are routed by the host DO to the bundle via the bundle's default-export `/client-message` endpoint, not through spine RPC.

#### Scenario: Bundle streams agent event to client
- **WHEN** a bundle produces an `agent_event` message during inference and calls `env.SPINE.broadcast(token, message)` with a valid token
- **THEN** all WebSocket clients subscribed to the token's session receive the message in real time

### Requirement: Cost emission RPC surface

`SpineService` SHALL expose a `emitCost(token, costEvent)` method that persists cost entries and broadcasts `cost_event` transport messages exactly as the in-DO `context.emitCost()` path does today. The `costEvent` argument SHALL include `capabilityId`, `toolName`, `amount`, `currency`, and optional `detail` / `metadata`. The `costEvent` SHALL NOT include a `sessionId` field — the session identity is derived from the verified token. Cost emission SHALL be unforgeable across sessions: a bundle holding a token for one session cannot cause a cost event to be attributed to a different session.

#### Scenario: Service-side capability emits cost
- **WHEN** a capability service class (e.g., `TavilyService`) calls `env.SPINE.emitCost(token, { capabilityId: "tavily-web-search", toolName: "search", amount: 0.01, currency: "USD" })` after a successful external API call
- **THEN** the cost appears as a custom session entry of type `cost` in the session store keyed to the token's sessionId, and is broadcast to clients of that session as a `cost_event` transport message

#### Scenario: Cost cannot be attributed to a foreign session
- **WHEN** a bundle attempts to emit a cost with metadata referencing a sessionId other than the one in its token
- **THEN** there is no method signature that accepts a target sessionId; only the token's verified sessionId is used

### Requirement: Per-turn RPC budget enforcement

`SpineService` SHALL enforce per-token RPC budgets to prevent denial-of-service from inside a single bundle's turn. Default budgets: 100 SQL ops, 50 KV ops, 200 broadcast events, 5 alarm sets per token. Exceeding any budget SHALL return a structured `ERR_BUDGET_EXCEEDED` error from the affected method. Budgets SHALL be configurable via host worker config but ship with safe defaults.

#### Scenario: Budget enforced
- **WHEN** a bundle calls `appendEntry(token, ...)` 101 times within a single turn (same token)
- **THEN** the 101st call returns `ERR_BUDGET_EXCEEDED` with the SQL ops counter exhausted, and the bundle's `AgentRuntime` surfaces this as a turn failure

### Requirement: RPC value serializability

All `SpineService` method arguments and return values SHALL be transmissible across Cloudflare Workers JSRPC boundaries. Binary data SHALL be passed as base64-encoded strings or `ReadableStream`/`ArrayBuffer` values. Functions, closures, Durable Object stubs (other than the spine itself), and native bindings SHALL NOT appear in any RPC method signature.

#### Scenario: Entry with binary payload serializes correctly
- **WHEN** a bundle appends a session entry containing a binary blob
- **THEN** the blob is transmitted as a base64-encoded string or `ArrayBuffer` and reconstructed without corruption on the spine side

### Requirement: Method signature absence as security boundary

`SpineService` method signatures SHALL be the structural enforcement of the authorization model. Any operation that targets a session, agent, capability storage namespace, or schedule SHALL derive its target from the verified token, NOT from a caller-supplied argument. Reviewers SHALL be able to verify the authorization model by reading method signatures alone.

#### Scenario: Method signature audit
- **WHEN** an auditor reads `SpineService` method signatures
- **THEN** no method takes a `sessionId`, `agentId`, or capability-namespace key as an argument that bypasses the token-derived identity
