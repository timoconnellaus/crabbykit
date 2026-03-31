## Why

Every store in agent-runtime (`SessionStore`, `ScheduleStore`, `ConfigStore`, `McpManager`) and the A2A `TaskStore` directly import and depend on Cloudflare's `SqlStorage` or `DurableObjectStorage` types. This makes the runtime impossible to use outside Cloudflare Workers. Extracting platform-agnostic storage interfaces is the foundational step toward making CLAW a generic agent framework with Cloudflare as one adapter among many.

This is the right first step because storage is the deepest and most pervasive coupling point — it touches every store, every test, and the capability system — but it's also the most self-contained. It can be done without touching WebSocket handling, DO lifecycle, or the alarm system.

## What Changes

- Define two storage interfaces (`SqlStore` and `KvStore`) in a new `storage/` module within agent-runtime
- Refactor `SessionStore`, `ScheduleStore`, and `McpManager` to accept `SqlStore` instead of Cloudflare's `SqlStorage`
- Refactor `ConfigStore` to accept `KvStore` instead of Cloudflare's `DurableObjectStorage`
- Refactor `createCapabilityStorage()` to accept `KvStore` instead of `DurableObjectStorage` (the `CapabilityStorage` interface itself is already platform-agnostic)
- Create Cloudflare adapter functions that wrap `SqlStorage` → `SqlStore` and `DurableObjectStorage` → `KvStore`
- Update `AgentDO` constructor to create adapters from CF primitives and pass them to stores
- **BREAKING**: `SessionStore`, `ScheduleStore`, `ConfigStore`, `McpManager` constructors change parameter types from CF-specific to generic interfaces
- Update the existing `createMockSqlStorage()` test helper to implement `SqlStore` instead of mimicking CF's `SqlStorage`

## Capabilities

### New Capabilities
- `storage-interfaces`: Platform-agnostic `SqlStore` and `KvStore` interfaces that decouple all stores from Cloudflare primitives, plus Cloudflare adapter implementations

### Modified Capabilities

_None — no existing spec-level behaviors change. Stores retain identical public APIs; only their constructor parameter types change from CF-specific to generic._

## Impact

- **`packages/agent-runtime/src/`**: All 4 stores change constructor signatures. `AgentDO` constructor updated to wrap CF types in adapters before passing to stores.
- **`packages/a2a/src/server/task-store.ts`**: Also uses `SqlStorage` directly — should adopt `SqlStore` for consistency, but can be done as a follow-up since A2A is a separate package.
- **Test helpers**: `mock-sql-storage.ts` simplified — implements the new `SqlStore` interface directly instead of faking CF's full `SqlStorage` type with `as unknown as` casts.
- **Tests**: Constructor calls in unit tests update to use mock implementations of new interfaces. Integration tests in Workers pool are unaffected (they use real CF storage via the pool runner).
- **Consumer API**: No change — consumers extend `AgentDO` and never touch stores directly.
- **Dependencies**: No new external dependencies. The interfaces are pure TypeScript.
