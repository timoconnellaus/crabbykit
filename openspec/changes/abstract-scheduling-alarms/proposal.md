## Why

AgentDO's scheduling system is tightly coupled to Cloudflare Durable Object alarms (`ctx.storage.setAlarm/deleteAlarm/getAlarm`). This prevents the framework from running on non-Cloudflare platforms (Node.js, Bun, Deno). As part of making CLAW platform-agnostic (following the storage interface extraction in `extract-storage-interfaces`), the alarm mechanism needs a generic interface so alternative platforms can use `setTimeout`, `node-cron`, or other wake-up mechanisms.

## What Changes

- Define a `Scheduler` interface that abstracts the three alarm operations: set a wake time, cancel the pending wake, and query the current wake time.
- Create a Cloudflare adapter (`CfScheduler`) that wraps `ctx.storage.setAlarm/deleteAlarm/getAlarm` behind the `Scheduler` interface.
- Refactor `AgentDO.refreshAlarm()` to use the `Scheduler` interface instead of calling `ctx.storage` alarm methods directly.
- Refactor `AgentDO.alarm()` to delegate to a platform-agnostic `handleAlarmFired()` method that contains the schedule dispatch logic, so non-DO platforms can call it from their own wake mechanism.
- Export the `Scheduler` interface and CF adapter from the `agent-runtime` package barrel.

## Capabilities

### New Capabilities
- `scheduler-interface`: Defines the `Scheduler` interface for abstracting platform-specific wake/alarm mechanisms, plus the Cloudflare adapter implementation.

### Modified Capabilities

## Impact

- `packages/agent-runtime/src/agent-do.ts` -- `refreshAlarm()` and `alarm()` refactored to use `Scheduler` interface. `AgentDO` constructor (or initialization) accepts/creates a `Scheduler` instance.
- `packages/agent-runtime/src/scheduling/` -- New `scheduler.ts` for the interface and `cloudflare-scheduler.ts` for the CF adapter.
- `packages/agent-runtime/src/index.ts` -- Exports `Scheduler` type and `CfScheduler` adapter.
- Consumer code is unaffected -- `AgentDO` still extends `DurableObject`, and the CF adapter is wired internally. Consumers who don't override scheduling behavior see no API change.
