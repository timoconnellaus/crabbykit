import { TelegramClient } from "./telegram-client.js";
import type { TelegramAccount, TelegramInbound } from "./types.js";

/** Maximum characters per Telegram message. */
const MAX_MESSAGE_LENGTH = 4096;
/** Maximum number of chunks produced from a single final reply. */
const MAX_CHUNKS = 5;
/** Suffix appended to the final chunk when the message overflows even after chunking. */
const TRUNCATED_SUFFIX = "…[truncated]";

/**
 * Build the `sendReply` callback for the Telegram channel.
 *
 * The returned function splits overly long assistant replies into at most
 * `MAX_CHUNKS` messages of `MAX_MESSAGE_LENGTH` characters each. If the
 * final text still exceeds `MAX_CHUNKS * MAX_MESSAGE_LENGTH`, the last
 * chunk is truncated with a `"…[truncated]"` suffix so an abusive
 * 25,000-character reply produces exactly 5 Telegram messages — not 7, 8,
 * or an infinite fanout.
 *
 * Only the first chunk carries `reply_to_message_id` (the threading
 * anchor); subsequent chunks are plain messages so they appear as a
 * continuation thread in Telegram's UI.
 */
export function createTelegramSendReply(
  /**
   * Injection point for tests — lets them swap in a fake client that
   * records calls instead of hitting the real Bot API. Production code
   * passes `new TelegramClient(account)`.
   */
  clientFactory: (account: TelegramAccount) => TelegramClient = (a) => new TelegramClient(a),
) {
  return async function sendReply(
    account: TelegramAccount,
    inbound: TelegramInbound,
    text: string,
  ): Promise<void> {
    const chunks = chunkMessage(text);
    const client = clientFactory(account);
    for (let i = 0; i < chunks.length; i++) {
      await client.sendMessage({
        chat_id: inbound.chatId,
        text: chunks[i],
        ...(i === 0 ? { reply_to_message_id: inbound.messageId } : {}),
      });
    }
  };
}

/**
 * Split `text` into up to `MAX_CHUNKS` chunks of at most
 * `MAX_MESSAGE_LENGTH` characters each. If the input exceeds the total
 * capacity, the last chunk is truncated to make room for `"…[truncated]"`.
 *
 * Chunking is done on raw character boundaries (not word boundaries);
 * Telegram has no "must break on whitespace" requirement and word-aware
 * splitting would risk breaking long tokens like code blocks.
 */
export function chunkMessage(text: string): string[] {
  if (text.length === 0) return [""];
  const capacity = MAX_MESSAGE_LENGTH * MAX_CHUNKS;
  const chunks: string[] = [];

  if (text.length <= capacity) {
    for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
      chunks.push(text.slice(i, i + MAX_MESSAGE_LENGTH));
    }
    return chunks;
  }

  // Over capacity — fill the first MAX_CHUNKS - 1 slots at full length,
  // then truncate the last slot so the suffix fits.
  for (let c = 0; c < MAX_CHUNKS - 1; c++) {
    const start = c * MAX_MESSAGE_LENGTH;
    chunks.push(text.slice(start, start + MAX_MESSAGE_LENGTH));
  }
  const lastStart = (MAX_CHUNKS - 1) * MAX_MESSAGE_LENGTH;
  const lastBudget = MAX_MESSAGE_LENGTH - TRUNCATED_SUFFIX.length;
  chunks.push(`${text.slice(lastStart, lastStart + lastBudget)}${TRUNCATED_SUFFIX}`);
  return chunks;
}
