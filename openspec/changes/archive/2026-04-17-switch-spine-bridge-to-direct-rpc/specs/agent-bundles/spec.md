## MODIFIED Requirements

<!-- Section: Spine bridge mechanism -->

### Requirement: SpineService dispatches to the host DO via direct RPC method calls

SpineService (the `WorkerEntrypoint` in `@claw-for-cloudflare/bundle-host`) SHALL dispatch all bridged calls to the host `AgentDO` using direct method calls on a typed `DurableObjectStub<SpineHost>`. SpineService SHALL NOT construct `Request` objects or invoke `host.fetch(...)` for any spine operation. The previously-used HTTP-style routing pattern (pathing such as `https://internal/spine/appendEntry` with JSON-serialized bodies) is removed entirely.

Each SpineService method SHALL:

1. Verify the incoming capability token via `this.verify(token)` and derive `(agentId, sessionId, nonce)` from the verified payload.
2. Invoke `this.budget.check(nonce, category)` to enforce the per-turn RPC budget.
3. Obtain the DO stub via `this.getHost(agentId)`, which SHALL return a `DurableObjectStub<SpineHost>` — a stub typed to the spine host surface.
4. Call the corresponding method on the stub directly: `host.spineAppendEntry(sid, entry)`, `host.spineKvGet(capabilityId, key)`, etc.
5. Wrap the call in a `try { ... } catch (err) { throw this.sanitize(err); }` block that returns a sanitized `SpineError` to the bundle on any failure.

The capability token verification, budget enforcement, identity derivation from verified payload, and error sanitization invariants SHALL be preserved byte-for-byte across this change. Only the dispatch mechanism (HTTP routing vs direct method call) changes.

#### Scenario: SpineService.appendEntry issues a direct method call
- **WHEN** a bundle calls `env.SPINE.appendEntry(token, entry)` via service binding RPC
- **AND** SpineService verifies the token and checks the budget
- **THEN** SpineService invokes `host.spineAppendEntry(sessionId, entry)` on the typed `DurableObjectStub<SpineHost>` — NOT `host.fetch(new Request("https://internal/spine/appendEntry", ...))`

#### Scenario: Token verification still runs first
- **WHEN** SpineService receives an invalid or expired token
- **THEN** verification fails and SpineService throws a `SpineError` before any DO method is called — the host is never contacted on a bad token

#### Scenario: Budget enforcement still runs before the DO call
- **WHEN** a bundle's per-turn RPC budget for a category (e.g., `sql`, `kv`, `alarm`, `broadcast`) is exhausted
- **THEN** the budget check throws a `SpineError("ERR_BUDGET_EXCEEDED")` before any DO method is called

#### Scenario: Thrown DO exception is sanitized before returning to the bundle
- **WHEN** `AgentRuntime.spineAppendEntry` throws an exception (e.g., session not found)
- **THEN** SpineService catches the exception in its `try/catch` block and throws a sanitized `SpineError("ERR_INTERNAL")` — the bundle does NOT see the original error message, stack trace, or DO-internal state

### Requirement: AgentDO structurally satisfies `SpineHost` at compile time

The `AgentRuntime<TEnv>` class (and therefore `AgentDO<TEnv>` via the delegating runtime) SHALL expose a public method surface that structurally matches every method declared on the `SpineHost` interface. The matching SHALL be enforced by a compile-time type-level assertion in `packages/runtime/agent-runtime/src/agent-do.ts` (or a dedicated `spine-host-check.ts` file) that fails to compile if any `SpineHost` method is missing from, misnamed on, or has a mismatched signature against `AgentRuntime`.

Every method on `SpineHost` SHALL have a real implementation on `AgentRuntime`. No method SHALL return a "not implemented" sentinel or throw an "ERR_NOT_IMPLEMENTED" error. The interface and the implementation SHALL be coextensive: if a method is declared, it works.

#### Scenario: Drift introduces a compile error
- **WHEN** a developer adds a method `spineGetMode(sessionId: string)` to the `SpineHost` interface
- **AND** the developer forgets to implement it on `AgentRuntime`
- **THEN** the compile-time assertion fails to type-check, blocking the build at the point of the edit

#### Scenario: Every SpineHost method has a real implementation
- **WHEN** a bundle calls any method on `env.SPINE` (e.g., `getCompactionCheckpoint`, `scheduleCreate`, `scheduleUpdate`, `scheduleDelete`, `scheduleList`, `alarmSet`)
- **THEN** the method returns a real result from the underlying `sessionStore` / `scheduleStore` / `scheduler` subsystem — not a `501 Not Implemented` sentinel

#### Scenario: Method rename triggers compile error on stale call sites
- **WHEN** a developer renames `spineBroadcast` to `spineEmitBroadcast` on `AgentRuntime` without updating `SpineHost`
- **THEN** the compile-time assertion fails because `AgentRuntime` no longer satisfies `SpineHost`, AND `SpineService.broadcast`'s call to `host.spineBroadcast` also fails to type-check against `DurableObjectStub<SpineHost>` (if the stub type is narrowed)

### Requirement: Previously-501 spine methods are implemented end-to-end

The `SpineHost` methods `spineGetCompactionCheckpoint`, `spineScheduleCreate`, `spineScheduleUpdate`, `spineScheduleDelete`, `spineScheduleList`, and `spineAlarmSet` (which returned `501 Not Implemented` in the HTTP-routing era) SHALL be fully implemented on `AgentRuntime`. Each method SHALL delegate to the corresponding existing subsystem that static agents already use — `sessionStore.getCompactionCheckpoint`, `scheduleStore.create/update/delete/list`, `scheduler.setAlarm` — without duplicating logic or inventing new subsystems.

Bundles calling these methods SHALL receive correct results and SHALL NOT receive any "not implemented" error or sentinel.

#### Scenario: Bundle calls spineGetCompactionCheckpoint
- **WHEN** a bundle calls `env.SPINE.getCompactionCheckpoint(token)` via service binding
- **AND** a compaction checkpoint exists for the session
- **THEN** the method returns the checkpoint object from `sessionStore.getCompactionCheckpoint(sessionId)` — not an error

#### Scenario: Bundle schedules work via spine
- **WHEN** a bundle calls `env.SPINE.scheduleCreate(token, schedule)` via service binding
- **THEN** the schedule is persisted via `scheduleStore.create(schedule)` and reflected in subsequent `scheduleList()` calls
- **AND** the scheduler's alarm is updated to fire at the next schedule trigger

#### Scenario: Bundle alarm set via spine
- **WHEN** a bundle calls `env.SPINE.alarmSet(token, timestamp)`
- **THEN** the DO's next alarm fires at the provided timestamp via `scheduler.setAlarm(timestamp)`

### Requirement: The fetch handler on AgentDO no longer routes `/spine/*` paths

`AgentRuntime`'s fetch handler (`AgentRuntime.fetch(request)`) SHALL NOT contain any branch that routes `/spine/*` paths. The `handleSpineRequest` method SHALL be deleted entirely. Any request hitting a `/spine/*` URL SHALL fall through to the fetch handler's default behavior (which returns a 404 or equivalent, per the existing non-match handling).

#### Scenario: A stale caller hitting /spine/* gets 404
- **WHEN** an external caller issues an HTTP request to a `/spine/appendEntry` path on the DO
- **THEN** the DO responds with its generic not-found behavior; no spine operation is performed
- **AND** no internal state is mutated

#### Scenario: handleSpineRequest is gone
- **WHEN** a reviewer greps the `agent-runtime` package source for `handleSpineRequest`
- **THEN** zero hits are returned — the method has been removed along with all its helper functions that were local to it

### Requirement: SpineService.getHost returns a typed stub

The internal helper `SpineService.getHost(agentId)` SHALL return `DurableObjectStub<SpineHost>`, not the unrefined `DurableObjectStub`. This narrowing enables the TypeScript compiler to verify that every `host.spineX(...)` call in SpineService matches a real method on the `SpineHost` surface, turning any method-name typo or signature mismatch into a compile error.

#### Scenario: Typo caught at compile time
- **WHEN** a developer writes `host.spineAppndEntry(sid, entry)` (typo) in SpineService
- **THEN** TypeScript reports an error — the property does not exist on `DurableObjectStub<SpineHost>`, blocking the build
