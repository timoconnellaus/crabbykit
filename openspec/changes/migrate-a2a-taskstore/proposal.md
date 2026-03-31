## Why

The extract-storage-interfaces change decoupled all agent-runtime stores from Cloudflare-specific types, but explicitly deferred the A2A package's `TaskStore` as a follow-up. `TaskStore` still takes `SqlStorage` directly in its constructor, making it the last store with a hard Cloudflare dependency. Migrating it to use the `SqlStore` interface completes the storage abstraction story and makes the A2A package usable on non-Cloudflare platforms.

## What Changes

- Change `TaskStore` constructor to accept `SqlStore` (from `@claw-for-cloudflare/agent-runtime`) instead of Cloudflare's `SqlStorage`
- Update `AgentDO` constructor to pass the already-created `SqlStore` adapter to `TaskStore` instead of the raw `ctx.storage.sql`
- **BREAKING**: `TaskStore` constructor parameter type changes from `SqlStorage` to `SqlStore`

## Capabilities

### New Capabilities

_None -- this is a straightforward migration of an existing class to an already-defined interface._

### Modified Capabilities

- `storage-interfaces`: Extends the scope of the `SqlStore` interface to cover the A2A `TaskStore`, completing the migration that was explicitly deferred in the original change

## Impact

- **`packages/a2a/src/server/task-store.ts`**: Constructor changes from `SqlStorage` to `SqlStore`. All `this.sql.exec()` calls remain unchanged since `SqlStore.exec()` has the same signature.
- **`packages/agent-runtime/src/agent-do.ts`**: One line change -- pass `sqlStore` instead of `ctx.storage.sql` to `TaskStore`.
- **Tests**: The mock `TaskStore` in `handler.test.ts` and `claw-executor.test.ts` already mock at the class interface level (not `SqlStorage`), so they are unaffected.
- **`PendingTaskStore`**: Already uses the platform-agnostic `CapabilityStorage` interface -- no changes needed.
- **Consumer API**: No change -- consumers never construct `TaskStore` directly.
- **Dependencies**: A2A package gains a dependency on `SqlStore`/`SqlResult` types from agent-runtime (already a peer dependency).
