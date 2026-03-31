## Context

CLAW's scheduling system has two layers:

1. **ScheduleStore** -- CRUD for schedule records (already abstracted to use `SqlStore` from the `extract-storage-interfaces` change).
2. **Alarm mechanism** -- The wake-up trigger that fires `alarm()` at the right time. Currently hardcoded to CF Durable Object alarms via `ctx.storage.setAlarm()`, `ctx.storage.deleteAlarm()`, and `ctx.storage.getAlarm()`.

The alarm mechanism is the only remaining CF-specific coupling in the scheduling subsystem. CF DO alarms have a specific constraint: only one alarm can be active at a time per DO. The framework works within this by always setting the alarm to the earliest `next_fire_at` across all schedules.

The `extract-storage-interfaces` change established the pattern: define a minimal interface matching the actual usage, create a CF adapter, and wire it in the `AgentDO` constructor.

## Goals / Non-Goals

**Goals:**
- Define a `Scheduler` interface that abstracts set/cancel/get for a single pending wake time
- Cloudflare adapter wrapping DO alarm APIs behind the interface
- `AgentDO.refreshAlarm()` uses `Scheduler` instead of `ctx.storage` directly
- Schedule dispatch logic in `alarm()` extracted to a reusable `handleAlarmFired()` method so non-DO platforms can invoke it from their own wake mechanism
- Zero changes to consumer-facing API

**Non-Goals:**
- Building a Node.js/Bun adapter (only the interface + CF adapter)
- Abstracting the DO lifecycle (`alarm()` method itself remains as the CF entry point)
- Changing ScheduleStore, cron parsing, or schedule types
- Multi-alarm support (the single-alarm model is correct for the scheduling pattern used)

## Decisions

### 1. Scheduler interface has three async methods

**Decision**: The `Scheduler` interface provides `setWakeTime(time: Date)`, `cancelWakeTime()`, and `getWakeTime()`.

```ts
interface Scheduler {
  setWakeTime(time: Date): Promise<void>;
  cancelWakeTime(): Promise<void>;
  getWakeTime(): Promise<Date | null>;
}
```

**Rationale**: This maps 1:1 to the three DO alarm operations (`setAlarm`, `deleteAlarm`, `getAlarm`). The naming avoids "alarm" because that is CF-specific terminology. "Wake time" describes the concept: a point in time when the scheduler should wake the agent to process due schedules.

**Alternative considered**: A `schedule(callback, delay)` pattern like `setTimeout`. Rejected because the framework's scheduling model is persistence-based (schedules survive restarts), not callback-based. The scheduler only needs to set the next wake time; the dispatch logic already lives in `handleAlarmFired()`.

### 2. All methods are async

**Decision**: All three `Scheduler` methods return Promises, even though CF's `setAlarm`/`deleteAlarm` are already async and `getAlarm` returns `Promise<number | null>`.

**Rationale**: A Node.js adapter using a persistent store (e.g., writing next-wake-time to a file or database) would need async I/O. Making the interface uniformly async costs nothing for the CF adapter (already async) and keeps the door open for all adapter types.

### 3. Extract handleAlarmFired() as a protected method

**Decision**: The schedule dispatch logic currently inside `alarm()` moves to a protected `handleAlarmFired()` method. The DO `alarm()` method simply calls `this.handleAlarmFired()`.

**Rationale**: Non-DO platforms need a way to trigger schedule processing when their wake mechanism fires. By making it a protected method on the base class, a future `AgentNode` (or equivalent) can call `handleAlarmFired()` from a `setTimeout` callback or `node-cron` handler. The `alarm()` method stays as the CF-specific DO lifecycle entry point.

### 4. Scheduler lives in the scheduling module, not storage

**Decision**: The interface goes in `packages/agent-runtime/src/scheduling/scheduler-types.ts` and the CF adapter in `packages/agent-runtime/src/scheduling/cloudflare-scheduler.ts`.

**Rationale**: The scheduler is conceptually part of the scheduling subsystem, not the storage subsystem. It is tightly coupled to `ScheduleStore` and `refreshAlarm()`. Placing it alongside `schedule-store.ts` and `cron.ts` keeps related code together.

**Alternative considered**: Putting it in `src/storage/` alongside `SqlStore`/`KvStore`. Rejected because the scheduler is not a storage interface -- it is a scheduling/timer interface. The storage module handles data persistence; the scheduler handles temporal triggers.

### 5. CfScheduler adapter is a plain function, not a class

**Decision**: `createCfScheduler(storage: DurableObjectStorage): Scheduler` -- a factory function returning an object implementing the interface, consistent with the `createCfSqlStore` / `createCfKvStore` pattern.

**Rationale**: The adapter is trivially thin (three one-liners). A class would add unnecessary ceremony. The factory function pattern was established in `extract-storage-interfaces` and should be reused for consistency.

### 6. AgentDO constructor creates the scheduler

**Decision**: The `AgentDO` constructor calls `createCfScheduler(ctx.storage)` and stores the result as `this.scheduler`. This is stored as a protected property so tests and subclasses can access it.

**Rationale**: Same wiring pattern as `this.kvStore = createCfKvStore(ctx.storage)`. The scheduler is initialized once and used throughout the DO's lifetime.

## Risks / Trade-offs

**[Risk] getAlarm return type mismatch** -- CF's `getAlarm()` returns `Promise<number | null>` (milliseconds since epoch), not a `Date`. The adapter must convert.
-> *Mitigation*: The adapter converts `number | null` to `Date | null` internally. The interface uses `Date` for type safety and ergonomics.

**[Risk] Non-DO platforms need an alarm() equivalent** -- A Node.js adapter would need to call `handleAlarmFired()` when the wake time arrives, but there is no framework-level mechanism to wire this up automatically.
-> *Mitigation*: This is expected and acceptable. The `Scheduler` interface only handles the "when to wake" side. The "what to do when woken" side is `handleAlarmFired()`. A future Node.js base class would wire its own timer to call `handleAlarmFired()`. This change provides the building blocks; the platform-specific wiring is out of scope.

**[Trade-off] Single wake time model** -- The interface only supports one pending wake time, mirroring CF's one-alarm constraint. Platforms that support multiple concurrent timers cannot take advantage of that.
-> *Accepted*: The framework's scheduling model is inherently single-alarm (always pick the earliest `next_fire_at`). Supporting multiple timers would complicate the interface without benefiting the scheduling pattern. If a future platform adapter wants to optimize by avoiding unnecessary wake-ups, it can do so internally while still implementing the single-wake-time interface.
