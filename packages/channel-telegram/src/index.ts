import type {
  Capability,
  CapabilityHookContext,
  CapabilityStorage,
  ChannelDefinition,
  ConfigNamespace,
  ParsedInbound,
} from "@claw-for-cloudflare/agent-runtime";
import { defineChannel, Type } from "@claw-for-cloudflare/agent-runtime";
import { TelegramAccountStore } from "./account-store.js";
import { parseTelegramUpdate, type TelegramUpdate } from "./parse.js";
import { createTelegramSendReply } from "./send.js";
import { TelegramClient } from "./telegram-client.js";
import type {
  TelegramAccount,
  TelegramAccountView,
  TelegramChannelState,
  TelegramInbound,
} from "./types.js";
import { verifyTelegramSecret } from "./verify.js";

export { TelegramAccountStore } from "./account-store.js";
export { parseTelegramUpdate } from "./parse.js";
export { chunkMessage, createTelegramSendReply } from "./send.js";
export { redactToken, TelegramClient } from "./telegram-client.js";
export type {
  TelegramAccount,
  TelegramAccountView,
  TelegramChannelState,
  TelegramInbound,
} from "./types.js";
export { constantTimeEqual, verifyTelegramSecret } from "./verify.js";

/**
 * Capability id. Exported so hook sites and tests don't re-hardcode it.
 */
export const TELEGRAM_CAPABILITY_ID = "telegram";

/**
 * Options for constructing the Telegram channel.
 *
 * Accounts are NOT passed in at construction time. They live in the
 * per-DO `CapabilityStorage` (encrypted at rest) and are added or
 * removed at runtime by the agent (via the `telegram-accounts` config
 * namespace) or by a human (via a `capability_action` message).
 */
export interface DefineTelegramChannelOptions {
  /**
   * Default public base URL for `setWebhook` registration. Typically
   * the agent's live origin (e.g. the Cloudflare Quick Tunnel URL
   * during development, or the production Workers hostname).
   *
   * Optional: if omitted, the add-account flow falls back to deriving
   * the URL from the incoming request's origin (the URL the UI used
   * to reach the DO).
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

/** TypeBox schema for the `telegram-account:<id>` namespace and onAction "add" payload. */
const TELEGRAM_ACCOUNT_SCHEMA = Type.Object({
  token: Type.String({ description: "Telegram Bot API token from @BotFather." }),
  webhookSecret: Type.String({
    description: "Random shared secret sent to setWebhook and verified on every inbound.",
  }),
  publicUrl: Type.Optional(
    Type.String({
      description:
        "Override the default public URL for this account's webhook. Falls back to the channel-level publicUrl, then to the request origin.",
    }),
  ),
});

/** Schema for the read-only `telegram-accounts` namespace (list-all). */
const TELEGRAM_ACCOUNTS_SCHEMA = Type.Object({});

/** Convert a stored account into its redacted UI-facing view. Never includes the token. */
function toAccountView(account: TelegramAccount): TelegramAccountView {
  return {
    id: account.id,
    tokenPreview: `${account.token.slice(0, 7)}…`,
    webhookUrl: account.webhookUrl ?? null,
    webhookActive: account.webhookActive ?? false,
    lastError: account.lastError,
    addedAt: account.addedAt ?? "",
  };
}

/**
 * Build a Telegram channel as a CLAW `Capability`, implemented entirely
 * via `defineChannel`. Accounts are read from `CapabilityStorage` at
 * request time via a `TelegramAccountStore`, so a human or the agent
 * can add / remove Telegram bot accounts without a redeploy.
 *
 * Agent-driven path: use the `telegram-accounts` / `telegram-account:<id>`
 * config namespaces via `config_set` / `config_get` tool calls.
 *
 * UI-driven path: send a `capability_action` with
 * `capabilityId: "telegram"` and one of:
 *   - `{ action: "add", data: { id, token, webhookSecret, publicUrl? } }`
 *   - `{ action: "remove", data: { id } }`
 *   - `{ action: "list" }` (re-broadcasts state without mutation)
 *
 * Both paths share the same internal `addAccount` / `removeAccount`
 * helpers, so state stays consistent no matter who mutates it.
 *
 * **Security posture** (see README for full discussion):
 * - Bot tokens are stored in plaintext inside the DO's `CapabilityStorage`,
 *   which is already encrypted at rest by Cloudflare. Every error path in
 *   `TelegramClient` redacts the token before rethrowing.
 * - Rate-limit defaults are conservative. Raise only after observing
 *   production traffic — the highest-risk failure mode is an LLM
 *   inference bill from abuse.
 * - Untrusted inbound content flows into session entries as-is; a
 *   CLAW-wide prompt-injection sanitization layer is tracked as a
 *   follow-up.
 */
export function defineTelegramChannel(opts: DefineTelegramChannelOptions = {}): Capability {
  const sendReply = createTelegramSendReply(opts.clientFactory);
  const storeFor = (storage: CapabilityStorage) => new TelegramAccountStore(storage);
  const clientFor = (account: TelegramAccount): TelegramClient =>
    opts.clientFactory ? opts.clientFactory(account) : new TelegramClient(account);

  /**
   * Shared internal add handler. Called by both the configNamespaces
   * path and the onAction path. Persists the account, calls setWebhook,
   * stores the resulting webhookUrl/webhookActive/lastError metadata,
   * and broadcasts the new state. On setWebhook failure the account is
   * rolled back so the store never shows a half-configured entry.
   */
  async function addAccount(
    storage: CapabilityStorage,
    hookCtx: CapabilityHookContext | null,
    input: { id: string; token: string; webhookSecret: string; publicUrl?: string },
    /** Fallback URL derived from the request origin when opts.publicUrl is missing. */
    fallbackPublicUrl: string | null,
  ): Promise<TelegramAccount> {
    if (!input.id || typeof input.id !== "string") {
      throw new Error("Telegram account id is required.");
    }
    if (!input.token || typeof input.token !== "string") {
      throw new Error("Telegram bot token is required.");
    }
    if (!input.webhookSecret || typeof input.webhookSecret !== "string") {
      throw new Error("Telegram webhook secret is required.");
    }

    const store = storeFor(storage);

    // Resolve the webhook URL: per-call override > channel-level opt >
    // request fallback. If none are available, bail out — there is
    // nothing to register.
    const publicUrl = input.publicUrl ?? opts.publicUrl ?? fallbackPublicUrl;
    if (!publicUrl) {
      throw new Error(
        "No public URL available for setWebhook. Pass publicUrl in the add action, set it on defineTelegramChannel, or add the account from a request whose origin is reachable from the Telegram servers.",
      );
    }
    const webhookUrl = `${publicUrl.replace(/\/$/, "")}/telegram/webhook/${input.id}`;

    const account: TelegramAccount = {
      id: input.id,
      token: input.token,
      webhookSecret: input.webhookSecret,
      webhookUrl,
      webhookActive: false,
      addedAt: new Date().toISOString(),
    };
    await store.put(account);

    try {
      await clientFor(account).setWebhook(webhookUrl, input.webhookSecret);
      account.webhookActive = true;
      delete account.lastError;
      await store.put(account);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Bot API call failed — roll the account back so the store
      // doesn't advertise an account that can never receive inbound.
      await store.delete(input.id);
      throw new Error(`Telegram setWebhook failed for account "${input.id}": ${message}`);
    }

    if (hookCtx) await broadcastState(storage, hookCtx);
    return account;
  }

  /**
   * Shared internal remove handler. Deletes the account and attempts to
   * call deleteWebhook (failure is logged but doesn't block the
   * removal — a dead account should stop routing regardless).
   */
  async function removeAccount(
    storage: CapabilityStorage,
    hookCtx: CapabilityHookContext | null,
    id: string,
  ): Promise<boolean> {
    const store = storeFor(storage);
    const account = await store.get(id);
    if (!account) return false;

    try {
      await clientFor(account).deleteWebhook();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[channel:telegram] deleteWebhook failed for account "${id}": ${message}`);
    }

    await store.delete(id);
    if (hookCtx) await broadcastState(storage, hookCtx);
    return true;
  }

  /**
   * Broadcast the redacted account list via `capability_state`.
   * Scope is `"global"` because Telegram accounts are agent-wide
   * configuration, not session state.
   */
  async function broadcastState(
    storage: CapabilityStorage,
    hookCtx: CapabilityHookContext,
  ): Promise<void> {
    const accounts = await storeFor(storage).list();
    const state: TelegramChannelState = {
      accounts: accounts.map(toAccountView),
    };
    hookCtx.broadcastState?.("sync", state, "global");
  }

  const def: ChannelDefinition<TelegramAccount, TelegramInbound> = {
    id: TELEGRAM_CAPABILITY_ID,
    getAccount: (id, storage) => storeFor(storage).get(id),
    listAccounts: (storage) => storeFor(storage).list(),
    webhookPathPattern: "/telegram/webhook/:accountId",
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
  };

  const baseCapability = defineChannel(def);

  // Wrap the capability with:
  // 1. configNamespaces for agent-driven CRUD (`config_set/get`).
  // 2. onAction for UI-driven CRUD (`capability_action`).
  // 3. An onConnect hook that broadcasts the current state so a newly
  //    connecting UI hydrates its account list immediately.
  return {
    ...baseCapability,
    configNamespaces: (context): ConfigNamespace[] => [
      {
        id: "telegram-accounts",
        description: "List all configured Telegram accounts.",
        schema: TELEGRAM_ACCOUNTS_SCHEMA,
        get: async () => {
          const accounts = await storeFor(context.storage).list();
          return accounts.map(toAccountView);
        },
        // `set` on the list is a no-op; callers add via telegram-account:<id>.
        set: async () => {
          throw new Error(
            "Use config_set('telegram-account:<id>', { token, webhookSecret }) to add an account.",
          );
        },
      },
      {
        id: "telegram-account:{id}",
        description:
          "Read, add, or remove a Telegram bot account. Pass null as the value to delete.",
        schema: TELEGRAM_ACCOUNT_SCHEMA,
        pattern: /^telegram-account:(.+)$/,
        get: async (namespace) => {
          const match = namespace.match(/^telegram-account:(.+)$/);
          if (!match) return null;
          const account = await storeFor(context.storage).get(match[1]);
          return account ? toAccountView(account) : null;
        },
        set: async (namespace, value) => {
          const match = namespace.match(/^telegram-account:(.+)$/);
          if (!match) throw new Error("Invalid telegram-account namespace format.");
          const id = match[1];

          if (value === null) {
            const removed = await removeAccount(context.storage, null, id);
            if (!removed) throw new Error(`Telegram account not found: "${id}"`);
            return `Telegram account "${id}" removed.`;
          }

          const input = value as { token: string; webhookSecret: string; publicUrl?: string };
          await addAccount(
            context.storage,
            null,
            { id, token: input.token, webhookSecret: input.webhookSecret, publicUrl: input.publicUrl },
            null,
          );
          return `Telegram account "${id}" added and webhook registered.`;
        },
      },
    ],

    onAction: async (action, data, ctx) => {
      switch (action) {
        case "add": {
          const input = data as {
            id: string;
            token: string;
            webhookSecret: string;
            publicUrl?: string;
          };
          try {
            await addAccount(ctx.storage, ctx, input, null);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[channel:telegram] onAction add failed: ${message}`);
            await broadcastState(ctx.storage, ctx); // keep UI in sync even on failure
          }
          return;
        }
        case "remove": {
          const { id } = data as { id: string };
          await removeAccount(ctx.storage, ctx, id);
          return;
        }
        case "list": {
          await broadcastState(ctx.storage, ctx);
          return;
        }
        default: {
          console.warn(`[channel:telegram] unknown capability_action: ${action}`);
          return;
        }
      }
    },

    hooks: {
      ...baseCapability.hooks,
      // On first WebSocket connect, push the current account list to
      // the newly connected UI so it hydrates without an extra
      // round-trip. This is a READ, not a mutation — it's safe on the
      // once-per-DO onConnect lifecycle.
      onConnect: async (ctx) => {
        await broadcastState(ctx.storage, ctx);
      },
    },
  };
}
