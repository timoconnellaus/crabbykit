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
