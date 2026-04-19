# scheduler-interface Specification

## Purpose
TBD - created by archiving change abstract-scheduling-alarms. Update Purpose after archive.
## Requirements
### Requirement: Scheduler interface defines platform-agnostic wake time operations

The `Scheduler` interface SHALL provide three async methods for managing a single pending wake time:
- `setWakeTime(time: Date): Promise<void>` -- Sets the time at which the agent should be woken to process due schedules.
- `cancelWakeTime(): Promise<void>` -- Cancels any pending wake time.
- `getWakeTime(): Promise<Date | null>` -- Returns the currently set wake time, or `null` if none is pending.

Only one wake time SHALL be active at a time. Calling `setWakeTime` when a wake time is already set SHALL replace the existing one.

#### Scenario: Set and retrieve a wake time
- **WHEN** `setWakeTime` is called with a future Date
- **THEN** `getWakeTime` SHALL return that same Date

#### Scenario: Cancel a pending wake time
- **WHEN** `cancelWakeTime` is called after a wake time has been set
- **THEN** `getWakeTime` SHALL return `null`

#### Scenario: Get wake time when none is set
- **WHEN** `getWakeTime` is called and no wake time has been set (or it was cancelled)
- **THEN** it SHALL return `null`

#### Scenario: Replace existing wake time
- **WHEN** `setWakeTime` is called with time T2 while time T1 is already pending
- **THEN** `getWakeTime` SHALL return T2

### Requirement: Cloudflare adapter wraps DO alarm APIs

A `createCfScheduler(storage: DurableObjectStorage): Scheduler` factory function SHALL create a `Scheduler` backed by Cloudflare Durable Object alarms.

- `setWakeTime` SHALL call `storage.setAlarm(time.getTime())`
- `cancelWakeTime` SHALL call `storage.deleteAlarm()`
- `getWakeTime` SHALL call `storage.getAlarm()` and convert the epoch milliseconds to a `Date`, returning `null` when no alarm is set

#### Scenario: CF adapter sets alarm
- **WHEN** `setWakeTime(new Date('2025-06-01T12:00:00Z'))` is called on a CF adapter
- **THEN** the underlying `storage.setAlarm` SHALL be called with the corresponding epoch milliseconds

#### Scenario: CF adapter cancels alarm
- **WHEN** `cancelWakeTime()` is called on a CF adapter
- **THEN** the underlying `storage.deleteAlarm()` SHALL be called

#### Scenario: CF adapter retrieves alarm as Date
- **WHEN** `getWakeTime()` is called on a CF adapter and an alarm is set
- **THEN** it SHALL return a `Date` object representing the alarm time

### Requirement: AgentDO uses Scheduler for alarm operations

`AgentDO.refreshAlarm()` SHALL use the `Scheduler` interface (`this.scheduler.setWakeTime` / `this.scheduler.cancelWakeTime`) instead of calling `ctx.storage.setAlarm` / `ctx.storage.deleteAlarm` directly.

The `Scheduler` instance SHALL be created in the `AgentDO` constructor and stored as a protected property.

#### Scenario: refreshAlarm sets wake time via scheduler
- **WHEN** `refreshAlarm()` is called and there are enabled schedules with future fire times
- **THEN** `this.scheduler.setWakeTime` SHALL be called with the earliest fire time

#### Scenario: refreshAlarm cancels wake time when no schedules
- **WHEN** `refreshAlarm()` is called and there are no enabled schedules with fire times
- **THEN** `this.scheduler.cancelWakeTime` SHALL be called

### Requirement: Schedule dispatch logic is extracted to handleAlarmFired

The schedule dispatch logic currently in `AgentDO.alarm()` SHALL be extracted to a protected method `handleAlarmFired()`. The DO `alarm()` lifecycle method SHALL delegate to `handleAlarmFired()`.

Non-DO platform base classes SHALL be able to call `handleAlarmFired()` from their own wake mechanism (e.g., setTimeout callback, node-cron handler).

#### Scenario: DO alarm delegates to handleAlarmFired
- **WHEN** the Cloudflare DO `alarm()` lifecycle method fires
- **THEN** `handleAlarmFired()` SHALL be called, which processes due schedules and refreshes the alarm

#### Scenario: handleAlarmFired processes due schedules
- **WHEN** `handleAlarmFired()` is called
- **THEN** it SHALL query `scheduleStore.getDueSchedules()`, execute each due schedule (prompt or callback), update schedule state, and call `refreshAlarm()`

### Requirement: Scheduler interface and CF adapter are exported

The `Scheduler` type and `createCfScheduler` function SHALL be exported from the `agent-runtime` package barrel (`index.ts`).

#### Scenario: Consumer imports Scheduler type
- **WHEN** a consumer imports from `@crabbykit/agent-runtime`
- **THEN** the `Scheduler` type SHALL be available as a named export

#### Scenario: Consumer imports CF adapter
- **WHEN** a consumer imports from `@crabbykit/agent-runtime`
- **THEN** the `createCfScheduler` function SHALL be available as a named export

