## Context

CLAW has no supported path for external messaging surfaces (Telegram, Discord, Slack, email) to drive inbound prompts or receive outbound replies. Sessions today all flow through the WebSocket UI. The `prompt-scheduler` capability has already proven non-WebSocket inbound works via `sendPrompt({ source: "scheduled" })`, but there is no outbound story and no per-sender routing.

This change (v2) supersedes `openspec/changes/add-channels` (v1). v1 was reviewed by four independent opus agents — a contrarian, a technical architect, an adversarial security reviewer, and a ruthless simplifier. The panel's consensus was:

- v1 over-engineered for a one-channel v1 launch (11 requirements, ~400+ new runtime LOC, most of it future-channel scaffolding)
- v1 shipped opt-in rate-limiting for what its own design called "the single highest risk"
- v1's `NotificationRegistry` had a correctness bug (clearing on `agent_end`, which fires per-turn in CLAW, not per-DO)
- v1's rate limiter had a check-then-act race (spec exposed `check()` instead of `consume()`)
- v1's `Session.delivery` mutable column violated the append-log discipline for a use case no v1 caller had
- v1's `requesterSenderId` was dead code — populated, never read
- v1 cited a false precedent (design claimed `prompt-scheduler` used `waitUntil` for webhooks; it does not — the scheduler awaits inside `handleAlarmFired`)
- v1's `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` is invalid SQLite syntax and would have failed at implementation time
- v1 framed "channels" as a new runtime concept when what the runtime actually needed was a small capability lifecycle hook

v2 adopts the contrarian's reframe (`afterTurn` as a generic capability hook) and combines it with a policy-enforcing `defineChannel` factory that makes the security-critical pieces (webhook verification, dual-bucket rate limiting, correct lifecycle wiring) **mandatory at the TypeScript level**. The result is a smaller runtime surface (4 requirements vs. 11) that simultaneously has a safer default posture.

## Goals / Non-Goals

**Goals:**

- Add the minimum runtime primitive needed to support external messaging surfaces: an `afterTurn` capability hook that fires once per `handleAgentPrompt` invocation at `agent_end`.
- Add a runtime-owned, atomic, DO-serialized rate limiter (`ctx.rateLimit.consume`) that channels cannot implement incorrectly because they don't implement it at all.
- Add `Session.sender` + `findBySourceAndSender` for remote-identity routing, in a schema-minimal way.
- Provide a `defineChannel` factory whose `ChannelDefinition` interface enforces webhook verification, per-sender rate limiting, per-account (Sybil-resistant) rate limiting, and correct `afterTurn` wiring at the type level. Channel authors cannot ship an unsafe channel because the types refuse to compile.
- Ship `packages/channel-telegram` as the reference implementation, demonstrating the full pipeline in ~80 lines of declarative code.
- Preserve CLAW's append-log discipline — no mutable fields on `Session` rows beyond the metadata (`updatedAt`) that already mutates.
- Preserve the existing `Capability` extension model — channels are capabilities, `defineChannel` is sugar over `defineCapability`, nothing in the runtime treats channels specially except that `afterTurn` happens to be the primitive channels rely on.
- Address as many of the v1 review findings as possible by construction rather than by documentation discipline.

**Non-Goals:**

- A `NotificationRegistry` or any cross-capability outbound dispatch abstraction. Channels own their own outbound; cross-capability outbound is done via tool calls (visible in the transcript) or by calling a channel's exported sending function directly.
- A `DeliveryContext` type on `AgentContext`. The per-turn inbound stash lives in capability KV, owned by the channel that created it.
- A mutable `Session.delivery` column or any three-layer delivery precedence. The channel's `afterTurn` reads the inbound stash it wrote at webhook time — one source of truth, no precedence.
- A `Session.accountId` column. `accountId` lives inside the capability's own stash, keyed per-turn. Multi-account is supported via `defineChannel`'s generic `TAccount extends { id: string }`, not via session schema.
- A `requesterSenderId` field on `AgentContext` or `ToolExecuteContext`. This can be added when the first channel tool needs per-user authorization (e.g., "react as user X"). Until a tool reads it, the field would be dead code.
- Pairing flows (Signal/WhatsApp/iMessage QR codes).
- Channel status snapshot UI or runtime status types.
- Native platform commands (Discord slash commands, Telegram `/`-commands) as a first-class concept.
- `ChannelGroupAdapter`, `ChannelMessageActionAdapter`, `ChannelAuthAdapter`, `ChannelCapabilities` feature matrix — all the openclaw plugin slots.
- Media upload/download as a first-class concept.
- Cross-channel delivery redirection ("reply on Discord when the inbound was Telegram"). The agent can do this by calling an explicit tool the other channel exposes. No runtime routing required.
- Pre-extracting `defineChannel` into a separate package. It lives in `agent-runtime` alongside the hook it depends on.
- Sanitization of untrusted inbound content before it enters session entries. This is a broader CLAW concern (prompt injection via any user content, not just channels), tracked separately.
- Compaction-aware `afterTurn` (compaction operates on entries; `afterTurn` operates on turns; the two are orthogonal).
- Automatic session TTL / GC for channel-sourced sessions. Remains a follow-up as in v1.

## Decisions

### 1. `afterTurn` is a generic capability lifecycle hook, not a channel-specific hook

**Decision:** Add `afterTurn?(ctx, sessionId, finalText): Promise<void>` to the `Capability` interface. Fire it on every registered capability at `agent_end`, once per `handleAgentPrompt` invocation. Errors caught, logged, and swallowed.

**Why:** The runtime should not know what a "channel" is. It should know how to fire a hook after a turn ends. Any capability can use this — debug logging, cost reporting, caching, analytics — and channels are one user among several possible. This matches the shape of existing capability hooks (`beforeInference`, `beforeToolExecution`, `afterToolExecution`) and requires no new vocabulary.

**Alternatives considered:**

- *v1's `NotificationRegistry`:* Rejected. Channels register notifiers into a shared map, runtime resolves by `(channel, accountId)` on final message. The registry has a broken lifecycle (clearing on `agent_end` means the next inbound finds an empty map), and it's cross-capability ambient authority (any capability can dispatch via any notifier). `afterTurn` gives each capability a private, scoped dispatch path with no cross-capability leakage.
- *Per-turn `ctx.replyTo` field:* Rejected. Requires the runtime to know about "reply targets," which is exactly the vocabulary we're trying to avoid. Capabilities stash their own per-turn state.
- *Event subscription (`ctx.on("turn_end", ...)`):* Rejected. CLAW's hooks are declarative fields on `Capability`, not an event emitter. Consistency with the existing extension model.

### 2. Runtime owns the rate limiter; channels don't

**Decision:** The runtime exposes `ctx.rateLimit.consume({ key, perMinute, perHour? })` as a single, atomic implementation. Channels call it; they do not implement their own.

**Why:** Rate limiting is a correctness-critical primitive (the reviews called this out as the single highest-risk part of the whole change). If every channel implements its own sliding window, every channel has its own bugs. A single runtime implementation is tested once, audited once, and benefits from the DO's single-threaded execution for atomicity. Channels that opt out of the runtime limiter are forcing the author to rewrite a known-good implementation — which is the wrong incentive.

**Atomicity model:** Inside a DO, `consume` performs a read-modify-write against the sliding-window counter. The DO's single-threaded execution serializes `fetch` invocations, so the only interleaving hazard is `await` points inside a single handler. The implementation either uses a fully-synchronous code path against `sqlStore.exec` (no interleaving possible) or wraps the critical section in `blockConcurrencyWhile`. Both strategies produce genuine atomicity, not check-then-act theater.

**Alternatives considered:**

- *v1's opt-in helper as a separate module:* Rejected. "Shared helper the caller must remember to invoke" is the same pattern as "opt-in security" — easy to forget, hard to audit.
- *Per-capability rate limiter instance:* Rejected. Multiple implementations means multiple bugs; also precludes cross-capability fairness (e.g., a future "global inference budget" would be impossible).

### 3. `defineChannel` is a policy-enforcing factory, not convenience sugar

**Decision:** Ship `defineChannel(def): Capability` and `ChannelDefinition<TAccount, TInbound>` in v1. The interface's type system makes `verifyWebhook`, `parseWebhook`, `sendReply`, `rateLimit.perSender`, and `rateLimit.perAccount` all mandatory.

**Why:** CLAUDE.md says "Don't create helpers, utilities, or abstractions for one-time operations." That rule is about *convenience* helpers. A helper whose purpose is "the compiler refuses to let you construct a channel without the mandatory security pieces" is a different thing — it's a contract enforcer. The v1 review found that opt-in security (webhook verification, rate limiting, Sybil protection) is trivially forgotten in practice. Moving enforcement into the type system eliminates the whole category of "capability author forgot to verify the webhook" bugs.

**The helper is ~60 lines.** Every line is load-bearing — verification, two rate-limit buckets, session routing, inbound stash, `afterTurn` dispatch, best-effort error reply. There is no scope for the helper to grow into ceremony because its surface is fixed by the contract.

**What the contract does NOT include:** threading, reactions, edits, unsend, pairing, status snapshots, native commands, OAuth, media. These are channel-specific features that don't generalize, and forcing them into a shared contract would be the Procrustean bed that simplicity arguments warn against. Channels that want them expose them as their own tools or via their own methods — outside the contract.

**Alternatives considered:**

- *Build Telegram first with raw primitives, extract `defineChannel` as v1.5 (original memo recommendation):* Rejected after the v1 review. The core argument for deferral was "you don't know the right shape until you've built ≥2 channels." That's true for a convenience helper. For a policy-enforcing contract, the shape is driven by what you want to make impossible (unsafe channels), not by what's shared across implementations. You can design the policy without knowing every implementation detail.
- *Contrarian's zero-helper version (`afterTurn` only, no factory):* Rejected. It leaves rate limiting as capability-implemented, which was the v1 review's biggest finding. The contrarian frame is the right *primitive*, but the right *packaging* is the contract factory on top of it.

### 4. Session schema is one column (`sender`), not three

**Decision:** Add exactly one column to `Session`: `sender: string | null`. No `accountId`, no `delivery`, no `lastDelivery` mirror.

**Why:** The only session-level information the runtime needs to route channel inbound is "who is this session talking to on the remote side." `accountId` is per-turn data owned by the channel's inbound stash. `delivery` was v1's override mechanism for "agent chooses to reply elsewhere"; that's better expressed as an explicit tool call (visible in the transcript, append-log-compatible) than as mutable session state.

**Migration:** Uses `PRAGMA table_info(sessions)` introspection to detect the column, then conditionally runs `ALTER TABLE sessions ADD COLUMN sender TEXT`. This is the idempotent, SQLite-valid pattern — unlike v1's invalid `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

**Alternatives considered:**

- *Zero columns, stash everything in capability KV (contrarian position):* Rejected. `Session.source` already exists; `Session.sender` is the natural completion for inspector UX and cross-capability session queries. One column is cheap and the partial index makes lookups fast.
- *v1's three-column schema:* Rejected. `accountId` belongs in capability-private state (it's part of the inbound stash keyed per-turn). `delivery` doesn't need to exist — see the "delivery precedence" rejection below.

### 5. No delivery precedence; inbound stash is the single source of truth

**Decision:** The channel's webhook handler writes `{ accountId, inbound }` to capability KV at key `channel-inbound:${sessionId}` before calling `sendPrompt`. `afterTurn` reads the same key. There is no three-layer precedence, no session-level override, no per-turn `ctx.delivery` field. One source of truth.

**Why:** v1's three-layer delivery precedence (`session.delivery` > `ctx.delivery` > none) was the most-criticized piece of v1 across the review panel. It introduced mutable session state, silent fallthrough behavior, stale-override data leaks, and ambiguous semantics under mixed inbound (what happens if a WebSocket prompt lands in a channel-sourced session?). Collapsing to a single per-turn stash eliminates all of this:

- **No mutable session state** — the stash is capability KV, which is the legitimate home for per-capability state.
- **No silent fallthrough** — if the stash isn't there, `afterTurn` returns. No dispatch. The WebSocket broadcast path handles everything else.
- **No stale overrides** — the stash is overwritten on every webhook. If the session hasn't had a recent channel inbound, there's no dispatch; the last channel inbound is always the relevant one.
- **WebSocket prompt into a channel-sourced session** — `afterTurn` reads the stash written by the last channel webhook; the WebSocket user sees their reply via the existing broadcast path; the Telegram user sees the reply because the stash is still there. This is the correct behavior (both users see the conversation they're participating in) and it's expressible with no special-casing.

**Trade-off acknowledged:** if a channel-sourced session goes a long time between channel inbounds, the stash is still there from the last one. A future cron-triggered turn on that session would re-dispatch to the last-known channel target. This is either a feature (scheduled reminders reach the user on their preferred channel) or a bug (stale stash reaches a changed target). Current answer: acceptable, because the channel author can choose to clear the stash in `afterTurn` after dispatch if they want one-shot semantics, or leave it for reminder-style flows.

**Alternatives considered:**

- *v1's three-layer precedence:* Rejected in full. See above.
- *Stash on `AgentContext` only (no persistence):* Rejected. Doesn't survive hibernation. Capability KV is the right home.

### 6. The inbound stash is not deleted after `afterTurn`

**Decision:** `afterTurn` reads `channel-inbound:${sessionId}` but does not delete it. The next turn (chat message, cron fire, another inbound) overwrites it or reads the prior value.

**Why:** This is the simplest reachable behavior and it has useful side effects. Chat flows overwrite naturally. Cron-triggered outbound finds the last-known channel target and delivers to it. Sessions that haven't had a channel inbound in months have a stale stash, but `afterTurn` dispatching to a stale chatId is usually fine (Telegram may return an error, which is caught and logged) — or if the channel author wants one-shot semantics, they delete the stash inside their own `afterTurn` implementation.

**Alternatives considered:**

- *Delete after dispatch (one-shot):* Rejected as the default. Breaks cron-style flows. Channel authors can implement this themselves via `ctx.storage.delete` in their `sendReply` wrapper if they want.
- *TTL on stash entries:* Deferred. Adds complexity for a speculative benefit. Add later if stale-stash becomes a real problem.

### 7. Dispatch site is `agent_end`, once per `handleAgentPrompt`

**Decision:** `afterTurn` fires exactly once per `handleAgentPrompt` invocation, at the point where the runtime processes the `agent_end` event. The `finalText` is the concatenated text content of the final assistant message (natural stop, error, abort, or max-iterations — in all four cases, whatever was actually produced).

**Why:** Multi-turn inference produces multiple assistant messages (tool call → reply → tool call → reply → final reply). Firing `afterTurn` on each would mean N Telegram messages per user message — wrong. Firing at `agent_end` gives the user one reply per message they sent, which is the only behavior that makes sense for chat-like channels. Error-terminated turns still fire `afterTurn` because "sorry, I ran out of retries" is still text the user should see.

**Exact code site:** TBD during implementation. The v1 review correctly flagged that v1's tasks hand-waved about "handleAgentEvent → agent_end handling." The v2 implementation task must identify the precise site, write a comment explaining why it's the right site, and cover the four termination modes (natural_stop, error, aborted, max_iterations) with scenarios.

### 8. Errors during `afterTurn` never abort the turn

**Decision:** Each capability's `afterTurn` is invoked inside a try/catch. Exceptions are caught, logged with capability id and session id, and swallowed. Subsequent capabilities' `afterTurn` hooks still fire. The turn completes normally from the WebSocket perspective.

**Why:** Channel dispatch is a best-effort send to an external service. If Telegram's API is down, the agent shouldn't crash. If the Discord capability's `afterTurn` throws, the Telegram capability's `afterTurn` should still run. This is the standard "best-effort outbound" pattern.

**Best-effort error reply:** the channel-telegram reference implementation additionally catches errors *during* `sendPrompt` (not just during `sendReply`) and attempts a best-effort "sorry, something went wrong" reply via `def.sendReply` with the stashed inbound. This closes the "hibernation drops messages silently" failure mode flagged by the v1 reviewers: the user either gets a real reply or an error acknowledgment, never silence.

### 9. `runtimeContext.waitUntil` precedent comes from A2A, not scheduler

**Decision:** The webhook handler calls `sendPrompt` inside `ctx.runtimeContext.waitUntil(...)` to extend DO request lifetime past the HTTP 200 response. The precedent for this pattern is the A2A callback handler at `packages/agent-runtime/src/agent-runtime.ts:~2499`, NOT `prompt-scheduler` (which awaits inside `handleAlarmFired` — a different code path with different lifetime guarantees).

**Why:** The v1 design cited `prompt-scheduler` as the precedent for `waitUntil`, but reading the actual code reveals that scheduler awaits inference directly inside the alarm handler — it doesn't use `waitUntil` at all. The only existing runtime code that uses `waitUntil` for extended-lifetime inference is the A2A callback handler, which is actually the correct analog for a webhook: both receive a POST, both need to respond immediately, both need to continue work after the response. The implementation must verify the A2A pattern works for ≥30-second inference triggered from a webhook POST.

### 10. Multi-account is expressed via generics, not schema

**Decision:** `ChannelDefinition<TAccount extends { id: string }, TInbound>`. The channel author declares their account type, constrained to have a string `id` field. The runtime uses `account.id` for rate-limit bucket keys and inbound stash lookup. No `Session.accountId` column is needed because `accountId` lives inside the inbound stash, which is per-turn.

**Why:** Multi-account is a property of the channel's configuration, not the session schema. The type-level constraint (`{ id: string }`) is enough for the runtime to key state per account without the runtime knowing what accounts are. This keeps the schema clean and pushes the multi-account complexity into the channel that actually cares about it.

## Risks / Trade-offs

**[Inference cost from webhook abuse]** → Addressed by construction. `ctx.rateLimit.consume` is atomic (no TOCTOU race), and `ChannelDefinition.rateLimit` requires both `perSender` and `perAccount` buckets at the type level. Sybil attacks (rotating sender IDs) are blocked by the per-account bucket. A channel cannot ship without rate limiting because the type system rejects the construction.

**[Webhook replay]** → Not yet addressed. Telegram's `update_id` is monotonic; channels can track the high-water mark via capability KV inside `parseWebhook` and return `null` on replay. The reference Telegram implementation should do this. Tracked as an implementation note for the Telegram package, not a runtime requirement — because other channels have different replay semantics.

**[Prompt injection via channel content → compaction → trusted context]** → Acknowledged, not solved in this change. This is a CLAW-wide concern (any user content can be prompt-injected), not specific to channels. Requires a separate capability-level sanitization primitive and compaction-aware untrusted-content markers. Tracked as follow-up. Document the risk prominently in the Telegram package README.

**[Hibernation mid-inference drops messages silently]** → Addressed by the best-effort error reply (decision 8). The `.catch` on `sendPrompt` in the `defineChannel` helper calls `def.sendReply` with the stashed inbound and a fallback message. The user either gets a real reply or an error acknowledgment — never silence.

**[DO lifetime for long inference triggered by webhook]** → Addressed by using `runtimeContext.waitUntil`, citing the A2A pattern (not the scheduler pattern which doesn't apply). Implementation must verify with an integration test that runs ≥30s of inference triggered from a webhook POST and confirms the final dispatch completes.

**[Notifier lifecycle race on cold start]** → Not applicable in v2. There is no notifier registry. `afterTurn` hooks are declarative methods on `Capability` objects constructed at capability init time; they exist whenever the capability is resolved, which is guaranteed before any HTTP handler from that capability can fire.

**[`afterTurn` errors from multiple capabilities interleave]** → Contained. Each capability's hook runs in its own try/catch. Multiple capabilities with `afterTurn` are independent; one failure doesn't affect the others.

**[Stale inbound stash dispatches to an irrelevant target]** → Acknowledged (decision 6). Channel authors can delete the stash after dispatch if they want one-shot semantics. Default is overwrite-on-next-inbound, which serves chat-like flows correctly.

**[Bot token leakage via error messages]** → Reference Telegram implementation must strip tokens from errors before rethrowing. Added as a requirement in the spec (§"Channel Telegram package is the reference implementation"). For future channels, the channel-authoring guide documents the pattern.

**[Group chat per-member attribution for compliance]** → Mitigated via `inbound.originalSenderId` in the stash payload (spec requirement on the Telegram package). The session is still keyed by `sender: "group:<chatId>"` for shared-transcript semantics, but per-entry metadata preserves individual attribution. GDPR deletion requests can target `originalSenderId` within the shared session.

**[Type-level contract doesn't generalize to all channels]** → Accepted. The contract is designed around what makes a channel *safe* (verification, rate limits), not what makes a channel *feature-complete*. Email, Matrix, Signal, IRC will likely fit the contract for security-critical fields but will need to stretch the `parseWebhook`/`sendReply` signatures in ways we can't predict. When the second channel arrives, extend the interface rather than working around it. If the interface has to grow significantly, that's a signal to reconsider — but the growth is an explicit architectural act, not a silent drift.

**[Cross-channel outbound (user on Telegram, agent replies on Discord)]** → Not supported in v2. The agent can reply cross-channel by calling an explicit tool the other channel exposes. This is strictly better than v1's approach (which used mutable `session.delivery` with silent precedence) because the intent is visible in the transcript. If a concrete use case emerges that can't be expressed via a tool call, revisit.

**[Session fan-out and storage growth]** → Unchanged from v1's acknowledgment. Every new remote sender creates a session row + entry tree. Mitigations: per-account rate-limit bucket caps total inbound, group-chat collapse reduces fan-out for group scenarios, and TTL/GC is tracked as follow-up.

## Migration Plan

### Migrating from v1 to v2

v1 (`openspec/changes/add-channels`) is superseded in full. It has not been implemented (no code changes, only spec artifacts). The migration is:

1. **Delete v1 before or alongside v2 landing.** Run: `rm -rf openspec/changes/add-channels`. Do not archive — an archive implies partial implementation, which does not apply.
2. **Do not attempt to share artifacts between v1 and v2.** The reviews surfaced correctness bugs in v1 (SQLite syntax error, false `waitUntil` precedent, `NotificationRegistry` lifecycle, rate limiter TOCTOU) that mean v1's artifacts should not be treated as trusted reference material.
3. **The capability name `channels` is reused.** v2's `specs/channels/spec.md` supersedes v1's. After v2 archives to `openspec/specs/channels/spec.md`, it is the single source of truth.

### Schema migration (part of v2 implementation)

Additive, idempotent, SQLite-valid:

```ts
// In SessionStore initialization:
const cols = sqlStore.exec("PRAGMA table_info(sessions)").toArray();
const hasSender = cols.some((c) => c.name === "sender");
if (!hasSender) {
  sqlStore.exec("ALTER TABLE sessions ADD COLUMN sender TEXT");
}
sqlStore.exec(
  "CREATE INDEX IF NOT EXISTS idx_sessions_source_sender ON sessions(source, sender) WHERE sender IS NOT NULL"
);
```

No data backfill is needed — existing sessions get NULL for the new column and are unaffected.

### Rollback

- Delete the `sender` column and its index.
- Remove `afterTurn` from `Capability`. Existing capabilities don't implement it, so no ripple.
- Remove `ctx.rateLimit` from `AgentContext`. The runtime rate limiter module can remain unused.
- Remove `packages/channel-telegram`.

No existing functionality depends on any of these; rollback is safe.

### No consumer-visible breaking changes

Agents that don't use channels see zero behavior change. The WebSocket UI path is completely untouched. Existing capabilities compile without modification because `afterTurn` and `ctx.rateLimit` are additions, not replacements.

## Open Questions

1. **Should `afterTurn` receive the full final assistant message object** (with metadata like tool calls, thinking blocks, etc.) or just the concatenated text? The spec currently says `finalText: string`. A full `AssistantMessage` would let debug/logging capabilities extract more detail, but it couples the hook to the message schema. Lean toward `string` for v1, with the option to add an overload (`afterTurn(ctx, sessionId, finalText, fullMessage?)`) later if a concrete consumer needs it.

2. **Should the `defineChannel` helper enforce an `onBusy` strategy** (queue, drop, steer) for the "agent is busy on this session" case the v1 architect flagged? Current default is implicit "whatever `sendPrompt` does today" — which throws. Making this a required field on the contract would force channel authors to decide. Leaning toward adding `onBusy: "drop-with-ack" | "queue" | "steer"` with default `"drop-with-ack"` — but this touches `handleAgentPrompt` which is outside the scope of channel wiring. Defer unless implementation blocks on it.

3. **Where should `ctx.publicUrl` come from?** `onAccountAdded` needs it to register the webhook URL with the provider. Options: plumbed through from the Worker's `request.url` at handler time, configured in the agent definition, derived from a binding. Decide during implementation of the Telegram reference.

4. **Should the runtime rate limiter be exposed outside the channel path**, i.e., can non-channel capabilities call `ctx.rateLimit.consume` for their own purposes? The spec is permissive — it's on `AgentContext`, not a channel-only context. This is probably fine (the helper is useful for any capability that wants rate limits), but document the intended usage patterns.

5. **Should `afterTurn` also fire on turns that produced no final assistant message** (pure tool-call termination, error before any assistant text)? Current decision: yes, with `finalText: ""`. Capability code should handle empty strings gracefully. Worth a scenario test.

None of these are load-bearing for v2 approval. They can be resolved during implementation without restructuring the spec.
