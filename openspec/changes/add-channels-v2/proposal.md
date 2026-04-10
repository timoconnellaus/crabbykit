## Why

CLAW agents can only talk to humans through the WebSocket UI today. External messaging surfaces (Telegram, Discord, Slack, email) have no supported path for driving inbound prompts or receiving outbound replies. `prompt-scheduler` already proves non-WebSocket inbound via `sendPrompt`, but there is no outbound story, no per-sender session routing, and no notion of "where to send the reply."

**This proposal supersedes `openspec/changes/add-channels`** (referred to here as v1). v1 was reviewed by four independent agents under multiple angles (technical, security, simplification, framing). The consensus was: v1 over-engineered the runtime surface (11 requirements for a one-channel v1), shipped opt-in rate-limiting for what the design itself called "the single highest risk," and manufactured a "channels" abstraction where what the runtime actually needed was a small lifecycle hook. v1's summary of critique lives in the review thread on 2026-04-09.

v2 reframes around two ideas:

1. **A capability `afterTurn` hook** — the minimum runtime primitive needed to let a capability observe the final assistant text of a turn and forward it somewhere. Channels are one user of this hook; the hook itself knows nothing about channels.
2. **A `defineChannel` policy-enforcing contract** — a thin factory whose purpose is to make it **structurally impossible to construct a channel capability without the security-critical pieces** (webhook verification, atomic per-sender rate limiting, Sybil-resistant per-account budget, correct `afterTurn` wiring). The helper's job is enforcement, not convenience.

The result is a smaller runtime surface, a safer default posture, and a contract that the second channel (when it arrives) can stretch or break explicitly rather than working around.

## What Changes

- **New capability hook** `Capability.afterTurn?(ctx, sessionId, finalText)` — fires once per `handleAgentPrompt` invocation at `agent_end`, on every registered capability. Errors caught and logged, never abort the turn. This is a generic lifecycle hook; any capability (debug, cost-tracker, cache) can use it, not just channels.
- **New runtime rate limiter** `ctx.rateLimit.consume({ key, perMinute, perHour? })` — a single shared implementation that is **atomic inside the DO** (wrapped in `blockConcurrencyWhile` or equivalent). Channels do not implement their own. One correctness-critical primitive, tested once.
- **New `Session.sender` column** — a single optional string field for routing channel-sourced sessions by remote identity. Comes with `SessionStore.findBySourceAndSender(source, sender)`. No `accountId` column, no `delivery` column, no mutable override fields on `Session`.
- **New `defineChannel(def)` factory** — a thin helper that returns a `Capability`. The `ChannelDefinition` interface has ~8 fields, of which 6 are required by the type system: `id`, `accounts`, `webhookPath`, `verifyWebhook`, `parseWebhook`, `rateLimit` (with both `perSender` AND `perAccount` buckets mandatory), `sendReply`. The optional two are lifecycle hooks `onAccountAdded` / `onAccountRemoved` for webhook registration. The helper does: webhook verify → rate-limit (both buckets) → parse → session routing via `findBySourceAndSender` → stash per-turn inbound payload in capability KV → `sendPrompt` under `waitUntil` → on `afterTurn`, look up the stash and call `def.sendReply`.
- **New reference package `packages/channel-telegram`** — ~80 lines of declarative channel definition using `defineChannel`. Demonstrates multi-account via TypeScript generics, inline group-chat handling (`sender = "group:<chatId>"`), secret-header verification, reply-to-message-id threading in the outbound payload.
- **New e2e test** covering the full webhook → inference → outbound loop via mocked `fetch`, plus rate-limit enforcement, Sybil-bucket enforcement, webhook secret rejection, hibernation-failure best-effort error reply, and per-turn inbound-stash isolation.

**No breaking changes.** The new `Session.sender` column defaults to NULL; existing WebSocket sessions are unaffected. `afterTurn` is an optional hook on `Capability` — existing capabilities compile without change. `ctx.rateLimit` is a new field on `AgentContext`; capabilities that don't read it see no behavior change. The runtime rate limiter is a new helper, not a replacement for anything.

**v1 is superseded in full.** If you're archiving v1 (`openspec/changes/add-channels`) after v2 lands, cut it — do not archive as a partially-applied change. See the migration note in `design.md`.

## Capabilities

### New Capabilities
- `channels`: `Capability.afterTurn` hook, runtime atomic rate limiter (`ctx.rateLimit.consume`), `Session.sender` column + `findBySourceAndSender` query, `defineChannel` policy-enforcing factory with the `ChannelDefinition` contract, and the `packages/channel-telegram` reference implementation. The contract enforces webhook verification, dual-bucket rate limiting, correct session routing, and correct `afterTurn` wiring at the type level.

### Modified Capabilities
<!-- None. Session schema, AgentContext, and the Capability interface hooks are not currently covered by dedicated spec requirements in openspec/specs/; all new behavior lands as ADDED requirements under the new `channels` capability. -->

## Impact

- `packages/agent-runtime/src/session/types.ts` — `Session` interface gains `sender: string | null`.
- `packages/agent-runtime/src/session/session-store.ts` — idempotent migration adding `sender` column (via `PRAGMA table_info` check, not `ALTER TABLE ... IF NOT EXISTS` which is invalid SQLite). Index `idx_sessions_source_sender` on `(source, sender) WHERE sender IS NOT NULL`. `findBySourceAndSender(source, sender)` method. `create(opts)` accepts optional `sender`.
- `packages/agent-runtime/src/capabilities/types.ts` — `Capability` gains optional `afterTurn?(ctx, sessionId, finalText)` hook. `CapabilityHttpContext.sendPrompt` gains optional `sender?: string`. `AgentContext` gains `rateLimit: RateLimiter`.
- `packages/agent-runtime/src/rate-limit/` — new module: atomic sliding-window `consume({ key, perMinute, perHour? }): Promise<{ allowed, reason? }>`, DO-serialized via whatever concurrency primitive the existing session-store uses (single-threaded execution is sufficient under the current architecture; `blockConcurrencyWhile` if stronger guarantees are needed).
- `packages/agent-runtime/src/agent-runtime.ts` — fire `afterTurn` on every capability with the hook at the `agent_end` event site (exact line to be identified during implementation; see design §7). Wire `ctx.rateLimit` into every `AgentContext` construction site. Extend `handleAgentPrompt` to accept `sender` and resolve session via `findBySourceAndSender` when `sessionId` is absent.
- `packages/agent-runtime/src/channels/define-channel.ts` — new module: `ChannelDefinition<TAccount, TInbound>` interface and `defineChannel` factory.
- `packages/agent-runtime/src/index.ts` — exports `afterTurn` hook type, `RateLimiter` interface, `ChannelDefinition`, `defineChannel`.
- `packages/channel-telegram/**` — new reference package (single-file definition ~80 lines + Bot API client + tests).
- `e2e/agent-runtime/telegram-channel.test.ts` — new integration test.
- **Deleted**: everything in `openspec/changes/add-channels/` once v2 lands — v1 is not partially implementable alongside v2.
- WebSocket clients, existing capabilities, and the Transport layer see no behavior change. The existing WebSocket UI path is completely untouched.
