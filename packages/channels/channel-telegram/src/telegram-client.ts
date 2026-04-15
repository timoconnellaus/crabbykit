import type { TelegramAccount } from "./types.js";

/**
 * Tiny wrapper over the Telegram Bot API. Uses `fetch` only — no external
 * dependencies. Every error path strips the bot token substring from the
 * thrown error message before re-throwing, so tokens never leak into logs
 * or surfaced error fields.
 */
export class TelegramClient {
  private readonly account: TelegramAccount;
  private readonly baseUrl: string;

  constructor(account: TelegramAccount, baseUrl = "https://api.telegram.org") {
    this.account = account;
    this.baseUrl = baseUrl;
  }

  /** POST /bot<token>/sendMessage. */
  async sendMessage(params: {
    chat_id: number;
    text: string;
    reply_to_message_id?: number;
  }): Promise<void> {
    await this.callMethod("sendMessage", params);
  }

  /**
   * POST /bot<token>/setWebhook.
   * Registers the agent URL with Telegram, passing `secret_token` so
   * inbound webhooks can be authenticated via the
   * `X-Telegram-Bot-Api-Secret-Token` header.
   */
  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.callMethod("setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message"],
    });
  }

  /** POST /bot<token>/deleteWebhook. */
  async deleteWebhook(): Promise<void> {
    await this.callMethod("deleteWebhook", { drop_pending_updates: false });
  }

  /** POST /bot<token>/getMe — useful for health checks. */
  async getMe(): Promise<{ id: number; username?: string }> {
    const res = await this.callMethod<{ id: number; username?: string }>("getMe", {});
    return res;
  }

  private async callMethod<T = unknown>(method: string, params: unknown): Promise<T> {
    const url = `${this.baseUrl}/bot${this.account.token}/${method}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Telegram ${method} returned ${res.status}: ${body}`);
      }
      const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
      if (!data.ok) {
        throw new Error(`Telegram ${method} failed: ${data.description ?? "unknown"}`);
      }
      return data.result as T;
    } catch (err) {
      // Strip the bot token from any error message before re-throwing.
      // This is load-bearing security: Telegram sometimes echoes request
      // URLs or params in error text, and Bot API tokens grant full
      // control over the bot.
      const message = err instanceof Error ? err.message : String(err);
      const redacted = redactToken(message, this.account.token);
      throw new Error(redacted);
    }
  }
}

/**
 * Replace every occurrence of the bot token in `text` with
 * `[REDACTED_TOKEN]`. Exposed for testing.
 */
export function redactToken(text: string, token: string): string {
  if (!token) return text;
  // Escape the token for regex: Telegram tokens are alphanumeric with a
  // colon, so `:` needs escaping. Use split+join for a cheap literal
  // replacement.
  return text.split(token).join("[REDACTED_TOKEN]");
}
