import type { ParsedInbound } from "@claw-for-cloudflare/agent-runtime";
import type { TelegramInbound } from "./types.js";

/**
 * Shape of a Telegram update as delivered by the Bot API webhook. Only
 * fields we actually read are declared; everything else is ignored.
 */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    from?: {
      id: number;
      username?: string;
    };
    chat: {
      id: number;
      type: "private" | "group" | "supergroup" | "channel";
    };
  };
}

/**
 * Convert a verified Telegram update into the runtime's
 * `ParsedInbound<TelegramInbound>` shape.
 *
 * Routing rules (from `openspec/changes/add-channels-v2/specs/channels/spec.md`):
 * - **Private chats**: `senderId = "@" + from.username`, falling back to
 *   the stringified `from.id` when username is absent.
 * - **Group / supergroup / channel**: `senderId = "group:" + chat.id`.
 *   All members of a group share a single session with the shared-chat
 *   transcript, while per-message `originalSenderId` is preserved in the
 *   stashed inbound for attribution.
 *
 * Updates lacking `message.text` return `null` (e.g., sticker-only,
 * photo-only messages are acknowledged but not processed by v1).
 */
export function parseTelegramUpdate(update: TelegramUpdate): ParsedInbound<TelegramInbound> | null {
  const msg = update.message;
  if (!msg?.text || !msg.from) return null;

  const senderId =
    msg.chat.type === "private"
      ? msg.from.username
        ? `@${msg.from.username}`
        : String(msg.from.id)
      : `group:${msg.chat.id}`;

  return {
    senderId,
    text: msg.text,
    inbound: {
      chatId: msg.chat.id,
      messageId: msg.message_id,
      originalSenderId: msg.from.id,
    },
  };
}
