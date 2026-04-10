import type {
  Capability,
  ChannelDefinition,
  ParsedInbound,
} from "@claw-for-cloudflare/agent-runtime";
import { defineChannel } from "@claw-for-cloudflare/agent-runtime";
import { parseTelegramUpdate, type TelegramUpdate } from "./parse.js";
import { createTelegramSendReply } from "./send.js";
import { TelegramClient } from "./telegram-client.js";
import type { TelegramAccount, TelegramInbound } from "./types.js";
import { verifyTelegramSecret } from "./verify.js";

export { parseTelegramUpdate } from "./parse.js";
export { chunkMessage, createTelegramSendReply } from "./send.js";
export { redactToken, TelegramClient } from "./telegram-client.js";
export type { TelegramAccount, TelegramInbound } from "./types.js";
export { constantTimeEqual, verifyTelegramSecret } from "./verify.js";

/**
 * Options for constructing the Telegram channel.
 *
 * `accountsFromEnv` is the extraction path: CLAW env bindings aren't
 * statically typed in the generic runtime, so consumers supply a loader
 * that walks their own env and returns configured accounts. Defaults for
 * rate-limit buckets can be overridden per deployment.
 *
 * `publicUrl` is the base URL for the agent's HTTP surface (e.g.,
 * `https://support.example.com`). The channel concatenates this with the
 * per-account webhook path to register with Telegram via `setWebhook`.
 */
export interface DefineTelegramChannelOptions {
  /** Load configured Telegram accounts from the runtime env. */
  accountsFromEnv: (env: unknown) => TelegramAccount[] | Promise<TelegramAccount[]>;
  /**
   * Public base URL used for `setWebhook`. Optional: if omitted, the
   * `onAccountAdded` hook is skipped and webhook registration must be
   * performed out-of-band (e.g., manually via curl).
   */
  publicUrl?: string;
  /** Override the default per-sender rate-limit buckets. */
  perSenderRateLimit?: { perMinute: number; perHour?: number };
  /** Override the default per-account (Sybil) rate-limit buckets. */
  perAccountRateLimit?: { perMinute: number; perHour?: number };
  /**
   * Test hook: override the Telegram client factory so unit/e2e tests
   * can intercept Bot API calls. Defaults to the real `TelegramClient`.
   */
  clientFactory?: (account: TelegramAccount) => TelegramClient;
}

/** Default conservative rate limits — tune per deployment. */
const DEFAULT_PER_SENDER = { perMinute: 10, perHour: 100 } as const;
const DEFAULT_PER_ACCOUNT = { perMinute: 60, perHour: 1000 } as const;

/**
 * Build a Telegram channel as a CLAW `Capability`, implemented entirely
 * via `defineChannel`. The declarative definition:
 *
 *   - id: `"telegram"` (used for the `Session.source` column and
 *     capability id)
 *   - accounts: loaded via `accountsFromEnv`
 *   - webhookPath: `/telegram/webhook/<accountId>`
 *   - verify: constant-time secret-header comparison
 *   - parse: `parseTelegramUpdate` (private → `@username`,
 *     group → `group:<chatId>`, `inbound` carries
 *     `{ chatId, messageId, originalSenderId }`)
 *   - rateLimit: conservative dual-bucket defaults, overrideable
 *   - sendReply: chunked outbound via `createTelegramSendReply`
 *   - onAccountAdded: `setWebhook` with the resolved public URL + secret
 *   - onAccountRemoved: `deleteWebhook`
 *
 * Security notes for channel authors (see README):
 *   - Bot tokens MUST NOT leak into error messages; `TelegramClient`
 *     redacts them on every error path.
 *   - Rate-limit defaults are conservative. Increase only after tuning
 *     to observed production traffic.
 *   - Untrusted inbound content flows into session entries as-is; a
 *     CLAW-wide prompt-injection sanitization layer is tracked as a
 *     follow-up. For now, treat Telegram content as untrusted in your
 *     system prompt design.
 */
export function defineTelegramChannel(opts: DefineTelegramChannelOptions): Capability {
  const sendReply = createTelegramSendReply(opts.clientFactory);

  const def: ChannelDefinition<TelegramAccount, TelegramInbound> = {
    id: "telegram",
    accounts: (env) => opts.accountsFromEnv(env),
    webhookPath: (account) => `/telegram/webhook/${account.id}`,
    verifyWebhook: (req, account) => verifyTelegramSecret(req, account),
    parseWebhook: async (req): Promise<ParsedInbound<TelegramInbound> | null> => {
      let update: TelegramUpdate;
      try {
        update = (await req.json()) as TelegramUpdate;
      } catch {
        return null;
      }
      return parseTelegramUpdate(update);
    },
    rateLimit: {
      perSender: opts.perSenderRateLimit ?? DEFAULT_PER_SENDER,
      perAccount: opts.perAccountRateLimit ?? DEFAULT_PER_ACCOUNT,
    },
    sendReply,
    onAccountAdded: async (account) => {
      if (!opts.publicUrl) return;
      const client = opts.clientFactory ? opts.clientFactory(account) : new TelegramClient(account);
      const url = `${opts.publicUrl.replace(/\/$/, "")}/telegram/webhook/${account.id}`;
      await client.setWebhook(url, account.webhookSecret);
    },
    onAccountRemoved: async (account) => {
      const client = opts.clientFactory ? opts.clientFactory(account) : new TelegramClient(account);
      await client.deleteWebhook();
    },
  };

  return defineChannel(def);
}
