import type { Capability, CapabilityHookContext } from "../capabilities/types.js";

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
 */
export interface ChannelDefinition<TAccount extends { id: string }, TInbound> {
  /**
   * Capability id and `Session.source` value (e.g., `"telegram"`). Must
   * match the kebab-case capability id convention.
   */
  id: string;

  /** Load accounts from the runtime env/config. */
  accounts(env: unknown): TAccount[] | Promise<TAccount[]>;

  /** Webhook path per account (relative to the agent's public URL). */
  webhookPath(account: TAccount): string;

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
   */
  rateLimit: {
    perSender: RateLimitConfig;
    perAccount: RateLimitConfig;
  };

  /**
   * MANDATORY — send the final assistant text to the inbound target.
   * Called from `afterTurn` with the stashed inbound payload.
   * Exceptions are caught and logged by the helper.
   */
  sendReply(account: TAccount, inbound: TInbound, text: string): Promise<void>;

  /**
   * Optional — invoked at capability initialization for each account,
   * *after* the HTTP handlers are registered. Typical use: call the
   * provider's `setWebhook` API with the now-live URL.
   */
  onAccountAdded?(account: TAccount, ctx: CapabilityHookContext): Promise<void>;

  /**
   * Optional — invoked at capability disposal for each account. Typical
   * use: call the provider's `deleteWebhook` API.
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
