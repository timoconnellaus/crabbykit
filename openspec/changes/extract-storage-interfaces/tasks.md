## 1. Define Storage Interfaces

- [x] 1.1 Create `packages/agent-runtime/src/storage/types.ts` with `SqlResult<T>`, `SqlStore`, and `KvStore` interfaces
- [x] 1.2 Create `packages/agent-runtime/src/storage/cloudflare.ts` with `createCfSqlStore` and `createCfKvStore` adapter functions
- [x] 1.3 Create `packages/agent-runtime/src/storage/index.ts` barrel re-exporting interfaces and adapters
- [x] 1.4 Add storage exports to `packages/agent-runtime/src/index.ts` barrel

## 2. Migrate Stores to Generic Interfaces

- [x] 2.1 Update `SessionStore` constructor to accept `SqlStore` instead of `SqlStorage`
- [x] 2.2 Update `ScheduleStore` constructor to accept `SqlStore` instead of `SqlStorage`
- [x] 2.3 Update `McpManager` constructor to accept `SqlStore` instead of `SqlStorage`
- [x] 2.4 Update `ConfigStore` constructor to accept `KvStore` instead of `DurableObjectStorage`
- [x] 2.5 Update `createCapabilityStorage()` to accept `KvStore` instead of `DurableObjectStorage`

## 3. Update AgentDO Constructor

- [x] 3.1 Import adapter functions in `agent-do.ts` and create `SqlStore`/`KvStore` from `ctx.storage.sql` and `ctx.storage` in the constructor
- [x] 3.2 Pass generic store instances to `SessionStore`, `ScheduleStore`, `McpManager`, `ConfigStore`, and `createCapabilityStorage`
- [x] 3.3 Verify no other references to `SqlStorage` or `DurableObjectStorage` remain in agent-do.ts beyond the adapter creation point

## 4. Update Test Helpers and Unit Tests

- [x] 4.1 Rename `createMockSqlStorage()` to `createMockSqlStore()` in `mock-sql-storage.ts` and update return type to `SqlStore` (remove `as unknown as SqlStorage` cast)
- [x] 4.2 Create `createMockKvStore()` in-memory test helper implementing `KvStore`
- [x] 4.3 Update `session-store.test.ts` to use `createMockSqlStore()`
- [x] 4.4 Update `schedule-store.test.ts` to use `createMockSqlStore()`
- [x] 4.5 Update `mcp-manager.test.ts` to use `createMockSqlStore()`
- [x] 4.6 Update `storage.test.ts` (capability storage tests) to use `createMockKvStore()`

## 5. Verify

- [x] 5.1 Run `bun run typecheck` — no type errors across workspaces
- [x] 5.2 Run `bun run test` — all existing tests pass (8 pre-existing failures unrelated to this change)
- [x] 5.3 Run `bun run lint` — no lint violations in changed files (pre-existing violations in other packages)
- [x] 5.4 Verify no remaining imports of `SqlStorage` or `DurableObjectStorage` outside of `storage/cloudflare.ts` and `agent-do.ts`
