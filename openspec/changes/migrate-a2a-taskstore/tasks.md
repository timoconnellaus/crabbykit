## 1. Migrate TaskStore constructor

- [ ] 1.1 Change `TaskStore` constructor in `packages/a2a/src/server/task-store.ts` to accept `SqlStore` (imported from `@crabbykit/agent-runtime`) instead of `SqlStorage`
- [ ] 1.2 Remove the `SqlRow` base type and the `extends SqlRow` from `TaskRow`, `ArtifactRow`, and `PushConfigRow` interfaces (no longer needed without `SqlStorageValue` constraint)

## 2. Update AgentDO wiring

- [ ] 2.1 Change `TaskStore` construction in `packages/agent-runtime/src/agent-do.ts` from `new TaskStore(ctx.storage.sql)` to `new TaskStore(sqlStore)` (using the already-created `SqlStore` adapter)

## 3. Verify

- [ ] 3.1 Run `bun run typecheck` to confirm no type errors across workspaces
- [ ] 3.2 Run `bun run test` to confirm all existing tests pass without modification
