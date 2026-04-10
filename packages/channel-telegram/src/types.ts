/**
 * A single Telegram bot account. Multi-account support is expressed via
 * the generic `TAccount extends { id: string }` on `defineChannel`.
 *
 * `id` is an opaque string chosen by the consumer (e.g., `"support"`,
 * `"ops"`) and used as the rate-limit bucket scope + the stash
 * accountId. `token` and `webhookSecret` are the Telegram Bot API
 * credentials for this account.
 */
export interface TelegramAccount {
  id: string;
  /** Bot API token issued by @BotFather. */
  token: string;
  /** Secret passed to `setWebhook` as `secret_token`, verified on every inbound. */
  webhookSecret: string;
  /** Webhook URL most recently registered with the Bot API via setWebhook. */
  webhookUrl?: string;
  /** True if the last `setWebhook` call succeeded. Defaults to false. */
  webhookActive?: boolean;
  /** Last error from a Bot API call on this account, if any. */
  lastError?: string;
  /** ISO timestamp of when the account was first persisted. */
  addedAt?: string;
}

/**
 * The Telegram-specific inbound payload stashed per-turn for `sendReply`.
 *
 * `chatId` is the target for the outbound reply. `messageId` is used as
 * `reply_to_message_id` so the bot's reply threads to the user's message.
 * `originalSenderId` preserves the true user id even in group chats
 * (where the session is keyed by `group:<chatId>`) so per-entry metadata
 * can satisfy GDPR deletion targeting individual users within a shared
 * transcript.
 */
export interface TelegramInbound {
  chatId: number;
  messageId: number;
  originalSenderId: number;
}

/**
 * Redacted view of a stored Telegram account, safe to broadcast to the
 * UI over `capability_state`. Tokens and webhook secrets are never
 * included — only a bot-token preview for display purposes.
 */
export interface TelegramAccountView {
  id: string;
  /** First 7 characters of the bot token, followed by an ellipsis. */
  tokenPreview: string;
  /** The webhook URL registered with the Bot API, if known. */
  webhookUrl: string | null;
  /** True if `setWebhook` succeeded the last time it was called. */
  webhookActive: boolean;
  /** Last failure message from a Bot API call, if any. */
  lastError?: string;
  /** ISO timestamp of when the account was added. */
  addedAt: string;
}

/**
 * The shape broadcast by the Telegram channel over `capability_state`
 * (scope: `"global"`, since accounts are agent-wide configuration).
 * The UI reads this via `useCapabilityState<TelegramChannelState>("telegram")`.
 */
export interface TelegramChannelState {
  accounts: TelegramAccountView[];
}
