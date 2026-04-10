# @claw-for-cloudflare/channel-telegram

Telegram channel reference implementation for the CLAW SDK. Built entirely
via `defineChannel` — the factory defined in `@claw-for-cloudflare/agent-runtime`
that enforces webhook verification, dual-bucket rate limiting, and correct
`afterTurn` wiring at the TypeScript level. You cannot ship this channel
without those pieces because the contract refuses to compile without them.

## Quick start

```ts
import { defineAgent } from "@claw-for-cloudflare/agent-runtime";
import { defineTelegramChannel } from "@claw-for-cloudflare/channel-telegram";

export default defineAgent({
  model: "claude-opus-4-6",
  prompt: "You are a helpful assistant.",
  capabilities: [
    defineTelegramChannel({
      publicUrl: "https://agent.example.com",
      accountsFromEnv: (env) => [
        {
          id: "support",
          token: (env as { TELEGRAM_SUPPORT_TOKEN: string }).TELEGRAM_SUPPORT_TOKEN,
          webhookSecret: (env as { TELEGRAM_SUPPORT_SECRET: string }).TELEGRAM_SUPPORT_SECRET,
        },
      ],
    }),
  ],
});
```

On first boot, the channel calls the Bot API `setWebhook` with
`publicUrl + "/telegram/webhook/<accountId>"` and the configured
`webhookSecret`. Incoming webhooks are verified via the
`X-Telegram-Bot-Api-Secret-Token` header.

## Bot setup

1. Talk to [@BotFather](https://t.me/BotFather) and create a new bot.
2. Note the bot token — do NOT commit it to source.
3. Pick a webhook secret string (random, ≥ 32 characters recommended).
4. Set both as Cloudflare secrets:
   ```bash
   wrangler secret put TELEGRAM_SUPPORT_TOKEN
   wrangler secret put TELEGRAM_SUPPORT_SECRET
   ```
5. Deploy. The agent's first boot registers the webhook automatically.

## Config shape

| Field                  | Type        | Default                                   | Notes |
|------------------------|-------------|-------------------------------------------|-------|
| `accountsFromEnv`      | `(env) => TelegramAccount[]` | (required)                       | Loader that extracts accounts from the worker env. |
| `publicUrl`            | `string`    | (optional)                                | Base URL used for `setWebhook`. Omit if you register webhooks out-of-band. |
| `perSenderRateLimit`   | `{perMinute, perHour?}` | `{perMinute: 10, perHour: 100}`  | Conservative default. Tune per deployment. |
| `perAccountRateLimit`  | `{perMinute, perHour?}` | `{perMinute: 60, perHour: 1000}` | Sybil guard. Raise once confident. |
| `clientFactory`        | `(acct) => TelegramClient` | (real Bot API)                   | Test hook. Swap for a fake in integration tests. |

## Rate-limit defaults (and why they're low)

The runtime enforces two buckets per inbound:

- **`perSender`** — keyed by `telegram:<accountId>:sender:<senderId>`. Prevents
  a single user from flooding the agent.
- **`perAccount`** — keyed by `telegram:<accountId>:_global`. Prevents a
  Sybil attack (rotating user ids) from blowing through the per-sender
  cap.

Both denials return HTTP 200 — *not* 429 — so Telegram does not
retry-storm your worker. The user sees nothing; the webhook is silently
acked.

Defaults are intentionally low because the highest-risk failure mode is a
runaway LLM inference bill. Increase the buckets only after you understand
what inference cost looks like per-message in your deployment.

## Security notes for channel authors

- **Constant-time secret verification.** `verifyTelegramSecret` compares
  the `X-Telegram-Bot-Api-Secret-Token` header byte-by-byte without
  short-circuiting on mismatch, so there is no timing oracle for the
  secret.
- **Bot token redaction.** `TelegramClient` strips the bot token from any
  error message before rethrowing. Bot tokens grant full control over the
  bot account; they MUST NOT appear in logs, error surfaces, or any
  error reply the agent emits. If you wrap `TelegramClient` or replace
  it via `clientFactory`, preserve this invariant.
- **Rate-limit defaults are conservative** and must be tuned per
  deployment. Never copy a production bucket size onto a new deployment
  without confirming the traffic shape matches.
- **Prompt-injection via channel content is an unsolved CLAW-wide
  concern**, not specific to this channel. User content from Telegram
  flows into session entries as-is and then into compaction summaries.
  Design your system prompt to treat untrusted user content defensively.
  A capability-level sanitization primitive is tracked as a follow-up.

## Outbound chunking

`sendReply` splits assistant replies longer than 4096 characters into at
most 5 chunks. If the reply still exceeds the capacity (~20,480 chars),
the final chunk is truncated with `…[truncated]`. Only the first chunk
carries `reply_to_message_id` so threading anchors to the user's message;
subsequent chunks are continuation messages.

## Manual smoke test via `examples/basic-agent`

The reference agent (`examples/basic-agent`) already registers this
channel conditionally — if `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET`
are set in the env, the capability is added to the `"default"` agent DO.
A top-level file route `src/routes/telegram/webhook/$accountId.ts` proxies
webhook traffic into the DO without requiring the `/api/agent/:agentId/`
prefix, so the URL you register with Telegram is simply
`{PUBLIC_URL}/telegram/webhook/default`.

End-to-end recipe:

```bash
# 1. Create a bot with @BotFather, copy the token, pick a random secret.
export TELEGRAM_BOT_TOKEN="123456:AA..."
export TELEGRAM_WEBHOOK_SECRET="$(openssl rand -hex 32)"

# 2. Boot the example agent against the remote Cloudflare edge.
cd examples/basic-agent
wrangler dev --remote &

# 3. Open a Cloudflare Quick Tunnel at localhost:8787 (wrangler's default).
cloudflared tunnel --url http://localhost:8787
# → copy the https://<random>.trycloudflare.com URL

# 4. Set the public URL so `onAccountAdded` can register the webhook.
export PUBLIC_URL="https://<random>.trycloudflare.com"

# 5. Restart wrangler dev so all three env vars are picked up.
#    On restart, the channel's onAccountAdded hook fires setWebhook against
#    Telegram's Bot API. Confirm with:
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"

# 6. DM the bot from your Telegram account.
#    A session is created (source: "telegram", sender: "@yourhandle"),
#    inference runs, and the reply arrives back in the chat.
```

For production via `wrangler deploy`, set the secrets once:

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put PUBLIC_URL   # e.g. https://basic-agent.example.workers.dev
```

Send 15+ messages rapidly to verify per-sender rate-limiting. You should
see the replies stop after 10 messages (the default per-minute bucket);
subsequent webhooks will be silently acked with HTTP 200.

## Group chats

Group/supergroup messages route to a single session keyed by
`sender: "group:<chatId>"`. The per-member user id is preserved inside
the stashed inbound as `originalSenderId`, so GDPR deletion requests and
per-member attribution are still possible at the entry level even though
the transcript is shared.

Telegram does not call `sendMessage` per-user in a group — there is one
bot reply per inbound, threaded to the incoming message via
`reply_to_message_id`.
