## 1. Scheduler Interface & CF Adapter

- [x] 1.1 Create `packages/agent-runtime/src/scheduling/scheduler-types.ts` with the `Scheduler` interface (setWakeTime, cancelWakeTime, getWakeTime)
- [x] 1.2 Create `packages/agent-runtime/src/scheduling/cloudflare-scheduler.ts` with `createCfScheduler(storage: DurableObjectStorage): Scheduler` factory function
- [x] 1.3 Export `Scheduler` type and `createCfScheduler` from `packages/agent-runtime/src/index.ts`

## 2. AgentDO Refactoring

- [x] 2.1 Add `protected scheduler: Scheduler` property to AgentDO and initialize it in the constructor via `createCfScheduler(ctx.storage)`
- [x] 2.2 Refactor `refreshAlarm()` to use `this.scheduler.setWakeTime()` / `this.scheduler.cancelWakeTime()` instead of `ctx.storage.setAlarm()` / `ctx.storage.deleteAlarm()`
- [x] 2.3 Extract the schedule dispatch logic from `alarm()` into a protected `handleAlarmFired()` method
- [x] 2.4 Update `alarm()` to delegate to `this.handleAlarmFired()`

## 3. Tests

- [x] 3.1 Add unit tests for `createCfScheduler` adapter (set, cancel, get operations, null case, Date conversion)
- [x] 3.2 Verify existing scheduling integration tests still pass after the refactoring (no behavior changes)
- [x] 3.3 Add a test verifying `handleAlarmFired()` processes due schedules and calls `refreshAlarm()`

## 4. Cleanup & Verification

- [x] 4.1 Run `bun run typecheck` to confirm no type errors
- [x] 4.2 Run `bun run test` to confirm all tests pass
- [x] 4.3 Run `bun run lint` to confirm no lint violations
