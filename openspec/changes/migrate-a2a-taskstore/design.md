## Context

The extract-storage-interfaces change (completed) introduced `SqlStore` and `KvStore` interfaces in agent-runtime and migrated all runtime stores (`SessionStore`, `ScheduleStore`, `ConfigStore`, `McpManager`) to use them. The A2A package's `TaskStore` was explicitly listed as a follow-up in that change's design doc ("Abstracting the A2A `TaskStore` (separate package, follow-up)").

`TaskStore` currently accepts Cloudflare's `SqlStorage` in its constructor and calls `this.sql.exec()` throughout -- the exact same pattern that the other stores used before migration. The `SqlStore` interface was designed to match this usage, so the migration is mechanical.

`PendingTaskStore` (the other store in the A2A package) already uses the platform-agnostic `CapabilityStorage` interface and requires no changes.

## Goals / Non-Goals

**Goals:**
- `TaskStore` accepts `SqlStore` instead of `SqlStorage`
- `AgentDO` passes its existing `SqlStore` adapter to `TaskStore`
- Zero behavior changes to `TaskStore` methods
- Complete the storage abstraction so no store in the codebase directly depends on Cloudflare storage types

**Non-Goals:**
- Changing any `TaskStore` public API (method signatures, return types)
- Modifying `PendingTaskStore` (already platform-agnostic)
- Creating new test infrastructure (existing mocks work as-is)
- Extracting storage interfaces to a separate package (still premature)

## Decisions

### 1. Import SqlStore type from agent-runtime

**Decision**: `TaskStore` imports `SqlStore` from `@claw-for-cloudflare/agent-runtime` (already a peer dependency of the A2A package).

**Rationale**: The type is already exported from agent-runtime's barrel. Adding a new package for just the interface types is the declared non-goal from the prior change. The A2A package already depends on agent-runtime for `CapabilityStorage` and other types.

**Alternative considered**: Copy the `SqlStore` interface into the A2A package. Rejected -- duplicating the interface creates drift risk and defeats the purpose of a shared abstraction.

### 2. Remove SqlRow base type

**Decision**: Drop the `SqlRow` type alias (`Record<string, string | number | null | ArrayBuffer>`) from task-store.ts. The row interfaces (`TaskRow`, `ArtifactRow`, `PushConfigRow`) no longer need to extend it.

**Rationale**: The `SqlRow` type existed to satisfy Cloudflare's `SqlStorageValue` constraint on `SqlStorage.exec()`. The `SqlStore` interface uses `Record<string, unknown>` as its default generic, so the row types just need to be plain interfaces with their actual field types.

### 3. No test changes needed

**Decision**: Do not modify the A2A test files (`handler.test.ts`, `claw-executor.test.ts`).

**Rationale**: Both test files mock `TaskStore` at the class level -- they create objects implementing the `TaskStore` interface shape, not `SqlStorage`. The mocks use `as unknown as TaskStore` casts. Since `TaskStore`'s public API is unchanged, these mocks remain valid.

## Risks / Trade-offs

**[Risk] Import cycle** -> `a2a` imports type from `agent-runtime`, `agent-runtime` imports `TaskStore` from `a2a`. This is already the case today (agent-do.ts imports from @claw-for-cloudflare/a2a) and is a type-only import from a2a's side, so no circular runtime dependency exists.
-> *Mitigation*: The cross-package imports are already established. TypeScript handles type-only cross-references without issues.

**[Trade-off] Breaking change for direct TaskStore constructors** -> Anyone constructing `TaskStore` directly (outside AgentDO) will see a type error.
-> *Accepted*: Same trade-off as the original change. `TaskStore` is an internal implementation detail, not part of the consumer-facing API. Consumers extend `AgentDO` and never construct `TaskStore` themselves.
