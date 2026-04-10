## ADDED Requirements

### Requirement: Capability exposes an afterTurn lifecycle hook

The `Capability` interface in `packages/agent-runtime/src/capabilities/types.ts` SHALL gain an optional `afterTurn` hook:

```ts
interface Capability {
  // ...existing hooks
  afterTurn?(ctx: AgentContext, sessionId: string, finalText: string): Promise<void>;
}
```

- The runtime SHALL invoke `afterTurn` on every capability that defines it, once per `handleAgentPrompt` invocation, at the `agent_end` dispatch site (see §Inference response fires afterTurn).
- `finalText` SHALL be the concatenated text content of the final assistant message produced by the turn (natural stop, error, abort, or max-iterations termination — in all four cases `afterTurn` fires with whatever final text was produced, which may be an empty string for aborted turns).
- Exceptions thrown from `afterTurn` SHALL be caught by the runtime, logged with the capability id and session id, and MUST NOT prevent turn completion, WebSocket broadcast, or subsequent capabilities' `afterTurn` hooks from firing.
- `afterTurn` is a generic lifecycle hook usable by any capability, not only channels (e.g., debug logging, cost reporting, caching).

#### Scenario: afterTurn fires once per handleAgentPrompt
- **GIVEN** two capabilities A and B both define `afterTurn`
- **WHEN** a single `handleAgentPrompt` call produces one assistant turn
- **THEN** both A.afterTurn and B.afterTurn SHALL be invoked exactly once with the same `(sessionId, finalText)`

#### Scenario: afterTurn error does not block subsequent capabilities
- **GIVEN** capabilities A, B, C all define `afterTurn`
- **AND** B.afterTurn throws an error
- **WHEN** a turn ends
- **THEN** A.afterTurn and C.afterTurn SHALL both be invoked normally
- **AND** the error from B SHALL be logged with channel/capability id and session id
- **AND** the turn SHALL complete with no visible failure to WebSocket clients

#### Scenario: afterTurn fires on error termination
- **GIVEN** a capability with `afterTurn` defined
- **WHEN** the agent loop terminates with an error (e.g., transient retry exhausted) and produces a partial final message
- **THEN** `afterTurn` SHALL be invoked with the partial message text

#### Scenario: afterTurn fires on natural stop
- **WHEN** the agent loop terminates with `natural_stop`
- **THEN** `afterTurn` SHALL be invoked with the final assistant message text

### Requirement: Inference response fires afterTurn at agent_end

`AgentRuntime.handleAgentEvent` (or its equivalent) SHALL invoke `afterTurn` hooks when processing the `agent_end` event, after persisting the final assistant entries and after broadcasting the final WebSocket event.

- The runtime SHALL resolve the final assistant text by concatenating the text content of the final assistant message in the `agent_end` event payload.
- The runtime SHALL invoke `afterTurn` via `ctx.runtimeContext.waitUntil(...)` (or equivalent mechanism that extends request lifetime past the current handler) so that hooks can perform async outbound I/O without blocking turn persistence.
- If no capability defines `afterTurn`, the runtime SHALL NOT incur any per-turn cost for the dispatch path.

#### Scenario: WebSocket-only turn with no channel capability
- **GIVEN** an agent with no capabilities defining `afterTurn`
- **WHEN** a turn ends
- **THEN** the runtime SHALL NOT enter any dispatch path and SHALL NOT incur additional overhead beyond existing `agent_end` handling

#### Scenario: Multi-turn inference dispatches once
- **GIVEN** a single `handleAgentPrompt` invocation that produces tool calls, intermediate assistant messages, and a final assistant message
- **WHEN** the turn terminates
- **THEN** `afterTurn` SHALL fire exactly once, with the final assistant message text — NOT for each intermediate assistant message

### Requirement: Runtime exposes an atomic rate limiter

The runtime SHALL expose a rate limiter on `AgentContext` and `CapabilityHttpContext`:

```ts
interface RateLimiter {
  consume(opts: {
    key: string;
    perMinute: number;
    perHour?: number;
  }): Promise<{ allowed: boolean; reason?: string }>;
}

interface AgentContext {
  // ...existing
  rateLimit: RateLimiter;
}
```

- `consume` SHALL be **atomic** — the read-modify-write of the sliding-window counter MUST NOT permit a check-then-act race where two concurrent callers both see "under limit" and both increment past the limit.
- Atomicity SHALL be achieved via the DO's single-threaded execution guarantees, wrapped with `blockConcurrencyWhile` or equivalent if the storage access pattern involves await points that could interleave.
- The limiter SHALL use the runtime's shared storage (DO SQLite or KV) keyed by the caller-supplied `key`. Multiple buckets per `key` (e.g., `perMinute` and `perHour`) SHALL be consumed as a single logical operation; both buckets must pass for `allowed: true`.
- `reason` SHALL identify which bucket caused denial when `allowed: false`.
- The runtime SHALL provide exactly one `RateLimiter` implementation. Channels and other capabilities MUST NOT re-implement rate limiting using their own storage patterns.

#### Scenario: Atomic concurrent consume
- **GIVEN** a limiter bucket at `perMinute: 10` with 9 consumed in the current window
- **WHEN** 5 concurrent calls to `consume({ key, perMinute: 10 })` arrive at the same DO
- **THEN** exactly 1 call SHALL return `allowed: true`
- **AND** exactly 4 calls SHALL return `allowed: false`

#### Scenario: Multi-bucket denial identifies the violating bucket
- **GIVEN** a limiter consumed with `perMinute: 10, perHour: 100`
- **AND** the per-hour bucket is at its limit while per-minute is below
- **WHEN** `consume` is called
- **THEN** the result SHALL be `{ allowed: false, reason: "perHour limit exceeded" }`

#### Scenario: Window slides
- **GIVEN** a bucket at its `perMinute` limit
- **WHEN** 61 seconds elapse and `consume` is called again
- **THEN** the result SHALL be `{ allowed: true }`

### Requirement: Session carries optional sender column

The `Session` interface SHALL gain a single optional field:

```ts
interface Session {
  id: string;
  name: string;
  source: string;
  sender: string | null;    // NEW
  leafId: string | null;
  createdAt: string;
  updatedAt: string;
}
```

- `sender` SHALL be `null` for WebSocket-originated sessions.
- `sender` SHALL be non-null for sessions routed via a channel webhook.
- No `accountId`, `delivery`, or other channel-routing fields SHALL be added to `Session` in this change.

#### Scenario: WebSocket session has null sender
- **WHEN** a session is created via the WebSocket transport without a `sender` opt
- **THEN** `session.sender` SHALL be `null`

#### Scenario: Channel session has non-null sender
- **WHEN** a session is created via a channel webhook with `sender: "@alice"`
- **THEN** `session.sender` SHALL equal `"@alice"`

### Requirement: Session schema migration is SQLite-valid and idempotent

`SessionStore` SHALL add the `sender` column via a migration that is valid SQLite syntax and idempotent on re-run.

- The migration SHALL NOT use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, which is invalid SQLite syntax.
- The migration SHALL use `PRAGMA table_info(sessions)` introspection to detect whether the column already exists, and SHALL execute `ALTER TABLE sessions ADD COLUMN sender TEXT` only when absent.
- The migration SHALL create `CREATE INDEX IF NOT EXISTS idx_sessions_source_sender ON sessions(source, sender) WHERE sender IS NOT NULL` on the same initialization path.

#### Scenario: Migration runs on old database
- **GIVEN** an existing `sessions` table without the `sender` column
- **WHEN** `SessionStore` initialization runs
- **THEN** the `sender` column SHALL be added
- **AND** the partial index SHALL be created

#### Scenario: Migration is idempotent
- **GIVEN** a `sessions` table that already has the `sender` column
- **WHEN** `SessionStore` initialization runs again
- **THEN** no `ALTER TABLE` SHALL be executed
- **AND** no error SHALL be raised

### Requirement: SessionStore exposes findBySourceAndSender

`SessionStore` SHALL expose:

```ts
findBySourceAndSender(source: string, sender: string): Session | null
```

- The method SHALL return the matching session row, or `null` if none exists.
- The method SHALL use the `idx_sessions_source_sender` index for lookup.
- `create(opts)` SHALL accept an optional `sender?: string` parameter and persist it.

#### Scenario: Lookup hit
- **GIVEN** a session row with `source: "telegram", sender: "@alice"`
- **WHEN** `findBySourceAndSender("telegram", "@alice")` is called
- **THEN** the session row SHALL be returned

#### Scenario: Lookup miss
- **WHEN** `findBySourceAndSender("telegram", "@bob")` is called and no matching row exists
- **THEN** the result SHALL be `null`

#### Scenario: Create with sender persists correctly
- **WHEN** `create({ source: "telegram", sender: "@alice", name: "Alice's chat" })` is called
- **AND** `findBySourceAndSender("telegram", "@alice")` is called subsequently
- **THEN** the returned session SHALL have `sender: "@alice"` and `source: "telegram"`

### Requirement: CapabilityHttpContext.sendPrompt accepts sender

`CapabilityHttpContext.sendPrompt` SHALL accept an optional `sender` parameter that flows through to session resolution:

```ts
interface CapabilityHttpContext {
  // ...existing
  rateLimit: RateLimiter;
  sendPrompt(opts: {
    text: string;
    sessionId?: string;
    source?: string;
    sender?: string;   // NEW
  }): Promise<unknown>;
}
```

- When `sessionId` is absent and `source` + `sender` are both present, `sendPrompt` SHALL resolve the session via `SessionStore.findBySourceAndSender(source, sender)`, creating a new session via `create` if none exists.
- Session resolution happens under the DO's single-threaded execution; no explicit transaction is required.
- When `sessionId` is present, it takes precedence and `source`/`sender` are ignored for routing.

#### Scenario: Webhook-style sendPrompt creates session
- **GIVEN** no session exists for `(telegram, @alice)`
- **WHEN** a capability calls `sendPrompt({ text: "hi", source: "telegram", sender: "@alice" })`
- **THEN** a new session SHALL be created with `source: "telegram"` and `sender: "@alice"`
- **AND** the prompt SHALL be driven against the new session

#### Scenario: Subsequent sendPrompt reuses session
- **GIVEN** a session exists for `(telegram, @alice)`
- **WHEN** a capability calls `sendPrompt({ text: "again", source: "telegram", sender: "@alice" })`
- **THEN** the same session SHALL be used

### Requirement: defineChannel is a policy-enforcing factory

The runtime SHALL export a `defineChannel` factory function and a `ChannelDefinition` interface from `packages/agent-runtime/src/channels/define-channel.ts`:

```ts
interface ParsedInbound<TInbound> {
  senderId: string;
  text: string;
  inbound: TInbound;
}

interface RateLimitConfig {
  perMinute: number;
  perHour?: number;
}

interface ChannelDefinition<TAccount extends { id: string }, TInbound> {
  /** Capability id and Session.source value */
  id: string;

  /** Load accounts from env/config */
  accounts(env: unknown): TAccount[] | Promise<TAccount[]>;

  /** Webhook path per account (relative to the agent's public URL) */
  webhookPath(account: TAccount): string;

  /** MANDATORY — verify the inbound is authentic */
  verifyWebhook(req: Request, account: TAccount): boolean | Promise<boolean>;

  /** Parse verified webhook. Return null to ack-without-process. */
  parseWebhook(req: Request, account: TAccount): Promise<ParsedInbound<TInbound> | null>;

  /** MANDATORY — both buckets required by type system */
  rateLimit: {
    perSender: RateLimitConfig;
    perAccount: RateLimitConfig;
  };

  /** MANDATORY — send final assistant text to the inbound target */
  sendReply(account: TAccount, inbound: TInbound, text: string): Promise<void>;

  /** Optional — invoked at capability init for each account */
  onAccountAdded?(account: TAccount, ctx: CapabilityContext): Promise<void>;

  /** Optional — invoked at capability dispose for each account */
  onAccountRemoved?(account: TAccount, ctx: CapabilityContext): Promise<void>;
}

function defineChannel<TAccount extends { id: string }, TInbound>(
  def: ChannelDefinition<TAccount, TInbound>
): Capability;
```

- `rateLimit.perSender` AND `rateLimit.perAccount` SHALL both be required properties at the type level. It MUST be a TypeScript compile error to construct a `ChannelDefinition` without either bucket.
- `verifyWebhook`, `parseWebhook`, and `sendReply` SHALL be required properties at the type level. It MUST be a TypeScript compile error to omit them.
- `TAccount` is constrained to `extends { id: string }` so the runtime can key per-account rate-limit buckets and stash lookups by account id.
- The factory SHALL return a `Capability` whose internal wiring implements the guarantees in the following requirements.

#### Scenario: Type system rejects missing rate limit buckets
- **GIVEN** a channel author attempts to construct a `ChannelDefinition` with only `rateLimit: { perSender: {...} }` and no `perAccount`
- **THEN** the TypeScript compiler SHALL reject the construction
- **AND** no runtime check SHALL be required

#### Scenario: Type system rejects missing verifyWebhook
- **GIVEN** a channel author omits `verifyWebhook`
- **THEN** the TypeScript compiler SHALL reject the construction

### Requirement: defineChannel wires the inbound pipeline correctly

The `Capability` returned by `defineChannel(def)` SHALL register HTTP handlers for every account such that every inbound webhook passes through the following steps in order:

1. **Verify** — call `def.verifyWebhook(req, account)`. Return HTTP 403 on false or throw.
2. **Parse** — call `def.parseWebhook(req, account)`. Return HTTP 200 without processing on null return.
3. **Rate limit (per sender)** — call `ctx.rateLimit.consume({ key: \`${def.id}:${account.id}:sender:${parsed.senderId}\`, ...def.rateLimit.perSender })`. Return HTTP 200 without processing on denial.
4. **Rate limit (per account global)** — call `ctx.rateLimit.consume({ key: \`${def.id}:${account.id}:_global\`, ...def.rateLimit.perAccount })`. Return HTTP 200 without processing on denial.
5. **Session routing** — call `ctx.sessionStore.findBySourceAndSender(def.id, parsed.senderId)` and fall back to `create({ source: def.id, sender: parsed.senderId })` if null.
6. **Stash inbound** — persist `{ accountId: account.id, inbound: parsed.inbound }` in capability KV under key `channel-inbound:${session.id}`. This stash is consumed by `afterTurn`.
7. **Drive inference** — call `ctx.sendPrompt({ sessionId: session.id, text: parsed.text })` inside `ctx.runtimeContext.waitUntil(...)`. Attach a `.catch` that logs the error and invokes `def.sendReply(account, parsed.inbound, "Sorry — something went wrong.")` as a best-effort error reply.
8. **Respond 200** — return HTTP 200 immediately (before `waitUntil` work completes) so the webhook provider (e.g., Telegram) does not retry.

- The order SHALL be strict. Verification SHALL happen before parsing; rate-limit SHALL happen before any session mutation; stash SHALL happen before `sendPrompt` (so `afterTurn` can read it).
- All rate-limit denials SHALL return HTTP 200 (not 429 or 503) to avoid webhook-provider retry amplification.

#### Scenario: Unverified webhook returns 403
- **GIVEN** a channel defined via `defineChannel` with a `verifyWebhook` that returns false
- **WHEN** a webhook request arrives
- **THEN** the response SHALL be HTTP 403
- **AND** `parseWebhook` SHALL NOT be called
- **AND** `sendPrompt` SHALL NOT be called

#### Scenario: Per-sender rate limit denial acks without processing
- **GIVEN** a sender at the `perSender.perMinute` limit
- **WHEN** another webhook from that sender arrives
- **THEN** the response SHALL be HTTP 200
- **AND** `sendPrompt` SHALL NOT be called
- **AND** no new session entries SHALL be persisted

#### Scenario: Per-account global rate limit protects against Sybil
- **GIVEN** the `perAccount._global` bucket is at its limit
- **WHEN** a webhook from a new sender (under the per-sender limit) arrives
- **THEN** the response SHALL be HTTP 200
- **AND** `sendPrompt` SHALL NOT be called

#### Scenario: Session is reused across webhooks
- **GIVEN** a prior webhook has created a session for `(telegram, @alice)`
- **WHEN** a new webhook from the same sender arrives
- **THEN** the existing session id SHALL be used
- **AND** no duplicate session row SHALL be created

#### Scenario: Inbound stash is per-turn
- **GIVEN** a webhook arrives and stashes `{ accountId, inbound }` for session X
- **WHEN** a subsequent webhook arrives and stashes new inbound data for the same session X
- **THEN** the stash SHALL be overwritten with the new inbound
- **AND** `afterTurn` for the second turn SHALL read the second stash, not the first

### Requirement: defineChannel wires the outbound pipeline via afterTurn

The `Capability` returned by `defineChannel(def)` SHALL implement `afterTurn` such that:

1. The hook reads the inbound stash at `channel-inbound:${sessionId}` from capability KV.
2. If no stash exists (e.g., session was created by a different channel, or WebSocket), the hook SHALL return without side effects.
3. If a stash exists, the hook SHALL look up the matching account via `def.accounts(ctx.env)` by `account.id === stash.accountId`.
4. If the account is still configured, the hook SHALL call `def.sendReply(account, stash.inbound, finalText)`.
5. Exceptions from `sendReply` SHALL be caught and logged; the hook SHALL NOT rethrow.

- The stash SHALL NOT be deleted after `afterTurn` — it remains available for the next turn of the same session (typical chat flow: user sends N messages, each turn reads the most recent stash).

#### Scenario: afterTurn dispatches to the original channel
- **GIVEN** a session was created by a Telegram webhook and the inbound stash contains `{ accountId: "support", inbound: { chatId: 12345 } }`
- **WHEN** a turn ends via `handleAgentPrompt`
- **THEN** the capability's `afterTurn` SHALL call `def.sendReply(supportAccount, { chatId: 12345 }, finalText)`

#### Scenario: afterTurn ignores sessions with no stash
- **GIVEN** a WebSocket-originated session with no `channel-inbound:` entry in capability KV
- **WHEN** a turn ends
- **THEN** the Telegram channel's `afterTurn` SHALL be invoked
- **AND** it SHALL return without calling `def.sendReply`

#### Scenario: sendReply failure is logged and swallowed
- **GIVEN** `def.sendReply` throws an error
- **WHEN** `afterTurn` is invoked
- **THEN** the error SHALL be logged with channel id and session id
- **AND** the turn SHALL complete normally for all other capabilities

### Requirement: defineChannel registers and deregisters webhooks via lifecycle hooks

The `Capability` returned by `defineChannel(def)` SHALL invoke `def.onAccountAdded(account, ctx)` for every account at capability initialization, and `def.onAccountRemoved(account, ctx)` at capability disposal.

- `onAccountAdded` SHALL run after the capability's HTTP handlers are registered, so that if the hook calls the provider's `setWebhook` API, the URL it registers is already live.
- `onAccountRemoved` SHALL run during capability disposal (and ideally on `onConfigChange` when an account is removed from config), allowing channels to call `deleteWebhook` or equivalent.
- If either hook is undefined, the helper SHALL skip the invocation without error.

#### Scenario: Account added triggers setWebhook
- **GIVEN** a Telegram channel with `onAccountAdded` that calls the Bot API `setWebhook`
- **WHEN** the capability is initialized
- **THEN** `onAccountAdded` SHALL be called once per configured account
- **AND** the HTTP handler for that account SHALL already be registered before the hook runs

#### Scenario: Account removed triggers deleteWebhook
- **GIVEN** a Telegram channel with `onAccountRemoved` that calls `deleteWebhook`
- **WHEN** the capability is disposed
- **THEN** `onAccountRemoved` SHALL be called once per configured account

### Requirement: Channel Telegram package is the reference implementation

A new package `packages/channel-telegram` SHALL provide the first channel implementation entirely via `defineChannel`.

- The package SHALL export a single `telegramChannel: Capability` (or a `defineTelegramChannel(opts)` factory if env plumbing is needed) constructed via `defineChannel`.
- The `ChannelDefinition` SHALL set `id: "telegram"`.
- `verifyWebhook` SHALL perform constant-time comparison of `X-Telegram-Bot-Api-Secret-Token` against the account's configured `webhookSecret`. On mismatch or missing header the function SHALL return false.
- `parseWebhook` SHALL handle Telegram update envelopes with `message.text` present. For private chats, `senderId` SHALL be `"@" + from.username` (fallback to `from.id` as a string when username absent). For group/supergroup/channel chats, `senderId` SHALL be `"group:" + chat.id`. Updates without text SHALL return `null`.
- The parsed `inbound` payload SHALL carry at minimum `{ chatId, messageId, originalSenderId }` — with `originalSenderId` being the actual user id even for group chats, to preserve per-member attribution in metadata without breaking the single-session grouping.
- `rateLimit.perSender` SHALL default to `{ perMinute: 10, perHour: 100 }`. `rateLimit.perAccount` SHALL default to `{ perMinute: 60, perHour: 1000 }`. These are conservative defaults for a single bot; channels with higher traffic expectations can raise them per account.
- `sendReply` SHALL call the Telegram Bot API `sendMessage` with `chat_id = inbound.chatId`, `text = finalText`, and `reply_to_message_id = inbound.messageId`. Messages longer than 4096 characters SHALL be split into at most 5 chunks; further overflow SHALL be truncated with a `"…[truncated]"` suffix to prevent outbound fan-out abuse.
- `sendReply` error handling SHALL strip the bot token from any thrown error's message before rethrowing, so tokens never leak into logs.
- `onAccountAdded` SHALL call the Bot API `setWebhook` with the current agent's public URL + the webhook path, passing `secret_token` for verification.
- `onAccountRemoved` SHALL call the Bot API `deleteWebhook`.

#### Scenario: Telegram private-chat inbound routed correctly
- **WHEN** a Telegram update for user `@alice` in private chat `12345` is POSTed with a valid secret header
- **THEN** `parseWebhook` SHALL return `{ senderId: "@alice", text, inbound: { chatId: 12345, messageId, originalSenderId: from.id } }`
- **AND** a session SHALL be created with `source: "telegram", sender: "@alice"`
- **AND** `sendReply` SHALL eventually be called with `chatId: 12345`

#### Scenario: Telegram group-chat inbound collapses to one session
- **GIVEN** two members of Telegram group `-1001` both send messages
- **WHEN** both webhooks are processed
- **THEN** both inbounds SHALL route to the same session with `sender: "group:-1001"`
- **AND** `afterTurn` for each turn SHALL dispatch to the group chat via the respective turn's stashed `inbound.chatId`

#### Scenario: Telegram secret header mismatch returns 403
- **WHEN** a webhook arrives with a missing or mismatched `X-Telegram-Bot-Api-Secret-Token`
- **THEN** the response SHALL be HTTP 403
- **AND** no parsing, rate-limiting, session creation, or `sendPrompt` SHALL occur

#### Scenario: Long-message outbound is chunked and capped
- **GIVEN** the agent produces a 25,000-character final message
- **WHEN** `sendReply` runs
- **THEN** the Telegram API SHALL be called at most 5 times
- **AND** the final chunk SHALL end with `"…[truncated]"`

#### Scenario: Telegram API error does not leak bot token
- **GIVEN** the Telegram API returns a 500 with an error URL embedding the bot token
- **WHEN** the notifier re-throws
- **THEN** the thrown error message SHALL NOT contain the bot token substring
