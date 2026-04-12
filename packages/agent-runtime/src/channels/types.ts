import type { Capability, CapabilityHookContext } from "../capabilities/types.js";
import type { CapabilityStorage } from "./../capabilities/storage.js";

/**
 * A verified, parsed inbound payload from a channel webhook. Produced by
 * `ChannelDefinition.parseWebhook`; consumed by the `defineChannel` helper
 * for session routing, rate-limiting, and stashing for `afterTurn`.
 */
export interface ParsedInbound<TInbound> {
  /**
   * Remote identity string that routes the session. For example,
   * `"@alice"` for a Telegram private chat or `"group:-1001"` for a
   * Telegram group. Used as the `sender` value in
   * `SessionStore.findBySourceAndSender(source, sender)`.
   */
  senderId: string;
  /** User-visible text extracted from the inbound payload. */
  text: string;
  /**
   * Channel-specific extras needed by `sendReply` — for Telegram this
   * carries `{ chatId, messageId, originalSenderId }`. Stashed verbatim at
   * webhook time and read back by `afterTurn`.
   */
  inbound: TInbound;
}

/** Per-bucket configuration for the runtime rate limiter. */
export interface RateLimitConfig {
  perMinute: number;
  perHour?: number;
}

/**
 * A policy-enforcing contract for a channel capability.
 *
 * `defineChannel(def)` wraps a `ChannelDefinition` into a `Capability` that
 * wires verification, dual-bucket rate limiting, session routing, inbound
 * stashing, `sendPrompt` under `waitUntil`, and `afterTurn`-based outbound
 * dispatch. The interface exists so the TypeScript compiler rejects
 * constructions that omit any of the security-critical fields
 * (`verifyWebhook`, `parseWebhook`, `rateLimit.perSender`,
 * `rateLimit.perAccount`, `sendReply`).
 *
 * **Accounts are dynamic.** The definition does not take a static
 * account list — instead it exposes `getAccount(id)` and `listAccounts()`
 * which are called at request time. This lets consumers back accounts
 * with per-DO storage that a human or an agent can mutate at runtime
 * without a redeploy.
 */
export interface ChannelDefinition<TAccount extends { id: string }, TInbound> {
  /**
   * Capability id and `Session.source` value (e.g., `"telegram"`). Must
   * match the kebab-case capability id convention.
   */
  id: string;

  /**
   * Fetch a single account by id. Called at request time from inside
   * the webhook handler (after the path-pattern matcher extracts the id)
   * and from `afterTurn` when resolving the stashed account. Returns
   * `null` when the account no longer exists — the webhook handler
   * responds with HTTP 403 and `afterTurn` becomes a no-op.
   *
   * `storage` is the channel capability's own per-DO
   * `CapabilityStorage`, plumbed through from the calling context.
   * Channels that back accounts with external state (D1, env, etc.)
   * can ignore it and close over their own source.
   */
  getAccount(accountId: string, storage: CapabilityStorage): Promise<TAccount | null>;

  /**
   * List every configured account. Used by capability state broadcasts
   * and by any consumer that needs to enumerate accounts (e.g. a UI).
   * Not called on the webhook hot path — `getAccount` is preferred there.
   */
  listAccounts(storage: CapabilityStorage): Promise<TAccount[]>;

  /**
   * Webhook path pattern for the channel. MUST include exactly one
   * `:accountId` path segment. The runtime's HTTP handler matcher
   * extracts the id and exposes it via `ctx.params.accountId` before
   * invoking the channel's pipeline.
   *
   * Example: `"/telegram/webhook/:accountId"`.
   */
  webhookPathPattern: string;

  /**
   * MANDATORY — verify the inbound request is authentic (e.g., HMAC,
   * secret header). Return `false` on failure; `defineChannel` returns
   * HTTP 403 and never reads the body.
   */
  verifyWebhook(req: Request, account: TAccount): boolean | Promise<boolean>;

  /**
   * Parse a verified webhook into a `ParsedInbound`. Return `null` to
   * acknowledge-without-process (HTTP 200, no rate-limit, no session, no
   * `sendPrompt`).
   */
  parseWebhook(req: Request, account: TAccount): Promise<ParsedInbound<TInbound> | null>;

  /**
   * MANDATORY — both per-sender AND per-account buckets are required by
   * the type system. `perSender` protects against a single-user flood;
   * `perAccount` protects against Sybil attacks (rotating sender ids).
   *
   * Accepts either a static object or a function of the dispatching
   * HTTP context so channels can derive the limits from live agent
   * config per inbound (see the Telegram reference implementation).
   */
  rateLimit:
    | { perSender: RateLimitConfig; perAccount: RateLimitConfig }
    | ((
        ctx: { agentConfig?: unknown },
      ) => { perSender: RateLimitConfig; perAccount: RateLimitConfig });

  /**
   * MANDATORY — send the final assistant text to the inbound target.
   * Called from `afterTurn` with the stashed inbound payload.
   * Exceptions are caught and logged by the helper.
   */
  sendReply(account: TAccount, inbound: TInbound, text: string): Promise<void>;

  /**
   * Optional — called by the defining capability when an account is
   * added at runtime (e.g., via a UI form or a config_set tool call).
   * Typical use: call the provider's `setWebhook` API with the
   * now-resolved public URL.
   *
   * Unlike the previous design, this is NOT wired into `onConnect`.
   * Channels are responsible for calling it from their own add-flow
   * handler so that the webhook is registered immediately after the
   * user clicks "Add", not on the next WebSocket connect.
   */
  onAccountAdded?(account: TAccount, ctx: CapabilityHookContext): Promise<void>;

  /**
   * Optional — mirror of `onAccountAdded` for removal. Called by the
   * defining capability from its remove-flow handler.
   */
  onAccountRemoved?(account: TAccount, ctx: CapabilityHookContext): Promise<void>;
}

/**
 * Payload persisted under `channel-inbound:${sessionId}` in capability KV
 * at webhook time, read back by the helper's `afterTurn` to dispatch the
 * reply. Per the design, the stash is overwritten on each inbound for the
 * same session and is NOT deleted after dispatch — chat-like flows benefit
 * from the last-known-target semantics (e.g., cron-triggered reminders).
 */
export interface ChannelInboundStash<TInbound> {
  accountId: string;
  inbound: TInbound;
}

/** Re-export Capability for consumers building channels in isolation. */
export type { Capability };
