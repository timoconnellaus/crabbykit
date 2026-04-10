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
    // Register unconditionally — no env vars required. Accounts are
    // added at runtime from the Channels UI (or via config_set).
    defineTelegramChannel({
      publicUrl: "https://agent.example.com",  // optional; falls back to the request origin
    }),
  ],
});
```

Accounts are stored per-DO, not in env vars. A user adds a bot by
navigating to the agent's **Channels** page in the UI, clicking
**+ Add account**, pasting their token + webhook secret, and hitting
**Add account**. The channel's `onAction` handler persists the account
in `CapabilityStorage`, calls the Bot API `setWebhook`, and broadcasts
the new state so every connected client refreshes its list.

The agent can manage the same accounts via tool calls to
`config_set("telegram-account:<id>", { token, webhookSecret })` and
`config_set("telegram-account:<id>", null)` for removal.

## Bot setup

1. Talk to [@BotFather](https://t.me/BotFather) and create a new bot.
2. Copy the bot token — you'll paste it into the UI.
3. Deploy your agent somewhere with a public HTTPS origin (production
   Worker, Cloudflare Quick Tunnel, ngrok, etc.).
4. Open the agent in the UI → **Channels** tab → **+ Add account**.
5. Paste the token, click **Generate** to create a webhook secret,
   choose an account id (e.g. `"support"`), and submit.
6. The panel updates to show the new account with its webhook URL and
   **active** status. DM your bot — the reply should arrive.

You can add multiple accounts (multiple bots) against the same agent
by repeating the flow with different `id` values. Each account has its
own rate-limit bucket.

## Config shape

| Field                  | Type        | Default                                   | Notes |
|------------------------|-------------|-------------------------------------------|-------|
| `publicUrl`            | `string`    | (optional)                                | Default base URL for `setWebhook`. Falls back to the incoming request origin at add-time. |
| `agentId`              | `string`    | (optional)                                | When set, `addAccount` embeds `/{agentId}` in the registered webhook URL so a top-level proxy can route inbound traffic to the right DO in a multi-tenant deployment. Omit for single-tenant. |
| `perSenderRateLimit`   | `{perMinute, perHour?}` | `{perMinute: 10, perHour: 100}`  | Conservative default. Tune per deployment. |
| `perAccountRateLimit`  | `{perMinute, perHour?}` | `{perMinute: 60, perHour: 1000}` | Sybil guard. Raise once confident. |
| `clientFactory`        | `(acct) => TelegramClient` | (real Bot API)                   | Test hook. Swap for a fake in integration tests. |

Accounts themselves are NOT passed in at construction time — they
live in per-DO storage and are added via the UI or the agent's
`config_set` tool.

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

The reference agent (`examples/basic-agent`) registers the Telegram
channel unconditionally with its own `agentId` wired through, so the
URL registered with Telegram is
`{PUBLIC_URL}/telegram/webhook/<agentId>/<accountId>`. A top-level file
route `src/routes/telegram/webhook/$agentId/$accountId.ts` extracts
`agentId` from the path, resolves the right DO via
`env.AGENT.idFromName(agentId)`, and forwards the inbound with the path
rewritten back to `/telegram/webhook/<accountId>` so the channel's
internal HTTP handler matches it. A deployment that runs several agent
DOs — one per customer, persona, etc. — gets isolated Telegram routing
for free.

Single-tenant deployments can leave `agentId` unset in
`defineTelegramChannel` and keep the shorter
`{PUBLIC_URL}/telegram/webhook/<accountId>` shape; the proxy route and
the registered URL must match either way.

> **Upgrading an existing deployment.** Adding `agentId` to
> `defineTelegramChannel` does **not** rewrite webhook URLs that
> Telegram has already stored. After rolling out the change, re-run the
> add-account flow (same `id`, same token) for each account so the
> channel re-registers the new URL via `setWebhook`.

End-to-end recipe (no env vars required):

```bash
# 1. Create a bot with @BotFather, copy the token — you'll paste it
#    into the UI, not set it as a secret.

# 2. Boot the example agent against the remote Cloudflare edge.
cd examples/basic-agent
wrangler dev --remote &

# 3. Open a Cloudflare Quick Tunnel at localhost:8787.
cloudflared tunnel --url http://localhost:8787
# → copy the https://<random>.trycloudflare.com URL

# 4. (Optional) export PUBLIC_URL=https://<random>.trycloudflare.com
#    and restart wrangler dev. This sets the default origin that new
#    accounts will register their webhook against. If you skip this,
#    the add-account flow falls back to the origin of whatever URL
#    the UI was loaded from — usually also the tunnel — so it Just Works.

# 5. Open the tunnel URL in your browser → pick the default agent →
#    click the "Channels" tab → "+ Add account" →
#      - account id: "support" (or whatever)
#      - bot token: paste what @BotFather gave you
#      - webhook secret: click "Generate"
#      - submit
#    The UI should show the new account with its webhook URL and
#    "Webhook active" status within a second or two.

# 6. Confirm with Telegram itself if you like:
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo"

# 7. DM your bot from Telegram. A session is created
#    (source: "telegram", sender: "@yourhandle"), inference runs,
#    and the reply arrives back in the chat.
```

**Verify rate limiting.** Send 15+ messages rapidly. Replies should
stop arriving after 10 (the default per-sender `perMinute` bucket).
Subsequent webhooks return HTTP 200 silently so Telegram doesn't
retry-storm.

**Verify persistence.** Restart `wrangler dev`. The account survives
the restart (it lives in the DO's SQLite storage, not memory). No
re-configuration needed.

For production via `wrangler deploy`, you don't need any Telegram
secrets in `wrangler secret put` — only `PUBLIC_URL` optionally. Bot
tokens are added through the UI at runtime.

## Group chats

Group/supergroup messages route to a single session keyed by
`sender: "group:<chatId>"`. The per-member user id is preserved inside
the stashed inbound as `originalSenderId`, so GDPR deletion requests and
per-member attribution are still possible at the entry level even though
the transcript is shared.

Telegram does not call `sendMessage` per-user in a group — there is one
bot reply per inbound, threaded to the incoming message via
`reply_to_message_id`.
