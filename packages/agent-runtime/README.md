# @claw-for-cloudflare/agent-runtime

Platform-agnostic runtime for building conversational AI agents on
Cloudflare Workers. Provides `AgentDO`, the `defineAgent` factory, session
storage, capability lifecycle, scheduling, A2A, MCP, transport, and the
channels primitives described below. See the top-level repo `README.md`
and `CLAUDE.md` for the full architecture overview.

## Channels

Channels let agents receive inbound prompts from external messaging
surfaces (Telegram, Discord, Slack, email) and route outbound replies
back to the originating user. Three runtime primitives make this work:

### `Capability.afterTurn`

An optional lifecycle hook on `Capability` fired once per
`handleAgentPrompt` / `handlePrompt` invocation at the `agent_end`
dispatch site, after entry persistence and WebSocket broadcast:

```ts
afterTurn?(ctx: AgentContext, sessionId: string, finalText: string): Promise<void>;
```

- `finalText` is the concatenated text content of the final assistant
  message in the turn. Empty string if the turn terminated without any
  assistant text (abort, error-before-generation, etc.).
- Errors thrown from `afterTurn` are caught per-capability, logged with
  capability id and session id, and never prevent turn completion or
  subsequent capabilities' hooks from firing.
- `afterTurn` is a generic hook — not channel-specific. Any capability
  (debug logging, cost reporting, cache invalidation, analytics) can
  subscribe.

The hook runs inside `runtimeContext.waitUntil(...)` so async outbound
I/O extends past the current handler without blocking other event work.

### `ctx.rateLimit.consume`

A runtime-owned, atomic sliding-window rate limiter shared by every
capability:

```ts
interface RateLimiter {
  consume(opts: {
    key: string;
    perMinute: number;
    perHour?: number;
  }): Promise<{ allowed: boolean; reason?: string }>;
}
```

- Exposed on every `AgentContext` and every `CapabilityHttpContext`.
- One shared instance per `AgentRuntime`, backed by the DO's SQL store.
- Atomic under DO single-threaded execution: the read-modify-write
  sequence inside `consume` contains no `await` points, so two
  concurrent callers can never both pass a bucket at its limit.
- Capabilities MUST call this rather than implementing their own
  counters. Multiple implementations means multiple bugs.

### `Session.sender` + `findBySourceAndSender`

A single nullable column on `Session` for channel routing by remote
identity:

```ts
interface Session {
  id: string;
  name: string;
  source: string;
  sender: string | null;      // NEW — channel-routed sessions only
  leafId: string | null;
  createdAt: string;
  updatedAt: string;
}

sessionStore.findBySourceAndSender(source: string, sender: string): Session | null;
```

- Backed by the partial index
  `idx_sessions_source_sender ON sessions(source, sender) WHERE sender IS NOT NULL`.
- NULL for WebSocket-originated sessions — they are never returned by
  `findBySourceAndSender`.
- Migration is idempotent and SQLite-valid: `PRAGMA table_info` checks
  whether the column exists before issuing `ALTER TABLE ADD COLUMN`
  (the `IF NOT EXISTS` form is invalid SQLite syntax and was one of the
  v1 review findings).
- `create(opts)` accepts an optional `sender?: string` that is persisted
  on the new row.

### `defineChannel`

A policy-enforcing factory that wraps a `ChannelDefinition` into a
`Capability` whose HTTP handlers and `afterTurn` hook implement the full
inbound → inference → outbound pipeline. The contract is designed to
make **unsafe channels structurally impossible** — webhook verification,
per-sender rate limiting, per-account (Sybil) rate limiting, and
`sendReply` are all required properties at the type level.

```ts
interface ChannelDefinition<TAccount extends { id: string }, TInbound> {
  id: string;
  accounts(env: unknown): TAccount[] | Promise<TAccount[]>;
  webhookPath(account: TAccount): string;

  // MANDATORY — the type system rejects omission of any of these:
  verifyWebhook(req: Request, account: TAccount): boolean | Promise<boolean>;
  parseWebhook(req: Request, account: TAccount): Promise<ParsedInbound<TInbound> | null>;
  rateLimit: {
    perSender: RateLimitConfig;     // required
    perAccount: RateLimitConfig;    // required — Sybil guard
  };
  sendReply(account: TAccount, inbound: TInbound, text: string): Promise<void>;

  // Optional lifecycle hooks:
  onAccountAdded?(account, ctx): Promise<void>;
  onAccountRemoved?(account, ctx): Promise<void>;
}

function defineChannel<TAccount, TInbound>(
  def: ChannelDefinition<TAccount, TInbound>,
): Capability;
```

The helper's inbound pipeline (strict order):

1. `verifyWebhook` — return HTTP 403 on failure.
2. `parseWebhook` — HTTP 200 without processing on `null`.
3. Per-sender rate limit — HTTP 200 on denial (NOT 429; webhook
   providers would retry-storm).
4. Per-account global rate limit — HTTP 200 on denial (Sybil guard).
5. Session routing via `findBySourceAndSender` + create-if-missing.
6. Stash `{ accountId, inbound }` under `channel-inbound:${sessionId}`.
7. `sendPrompt` under `waitUntil`, with `.catch` that calls
   `sendReply(account, parsed.inbound, "Sorry — something went wrong.")`
   as a best-effort error reply.
8. Respond HTTP 200 immediately.

The helper's `afterTurn` reads the stash, looks up the matching account
by id, calls `sendReply`, and catches/logs any failure. The stash is
**not** deleted after dispatch — chat-like flows benefit from
last-known-target semantics (e.g., cron-triggered reminders reach the
user on their most recent channel).

### Authoring a channel safely

1. **Start with `@claw-for-cloudflare/channel-telegram`** as a
   reference. It builds a complete channel in ~80 lines of declarative
   code on top of `defineChannel`. Read its implementation before
   writing your own — you will absorb the security invariants from the
   structure rather than by documentation discipline.
2. **Never** implement your own rate-limit counters. Use
   `ctx.rateLimit.consume`. The runtime's limiter is tested once and
   atomic; yours will have bugs.
3. **Constant-time secret comparison** is mandatory in `verifyWebhook`.
   Naive string equality leaks a timing oracle; `channel-telegram`'s
   `constantTimeEqual` is a reference implementation.
4. **Strip credentials from error messages** before rethrowing — tokens
   in logs are a full account takeover.
5. **Rate-limit defaults should be conservative.** LLM inference costs
   are the highest-risk failure mode; tune buckets upward only after
   observing real traffic.
6. **Treat user content as untrusted.** It flows into session entries
   and compaction summaries without sanitization. Design your system
   prompt to handle prompt-injection defensively until the CLAW-wide
   sanitization primitive lands.

See `packages/channel-telegram/README.md` for a concrete end-to-end
example including bot setup, config shape, and a Cloudflare Quick Tunnel
smoke test.
