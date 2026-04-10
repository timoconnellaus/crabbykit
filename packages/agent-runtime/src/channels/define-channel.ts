import type { AgentContext } from "../agent-runtime.js";
import type { Capability, CapabilityHttpContext, HttpHandler } from "../capabilities/types.js";
import type { ChannelDefinition, ChannelInboundStash, ParsedInbound } from "./types.js";

/** Stash key in capability KV, keyed by session id. */
const STASH_PREFIX = "channel-inbound:";
function stashKey(sessionId: string): string {
  return `${STASH_PREFIX}${sessionId}`;
}

/**
 * Fallback text used by the best-effort error reply when `sendPrompt`
 * throws or inference otherwise fails inside the `waitUntil` block. This
 * closes the "hibernation drops messages silently" failure mode flagged in
 * the v1 review: the user either gets a real reply or an explicit error
 * acknowledgment — never silence.
 */
const ERROR_REPLY_TEXT = "Sorry — something went wrong. Please try again.";

/**
 * Wrap a `ChannelDefinition` into a `Capability` whose HTTP handlers and
 * `afterTurn` hook implement the full inbound → inference → outbound
 * pipeline described in `openspec/changes/add-channels-v2/specs/channels/spec.md`:
 *
 * 1. verify → 403 on failure
 * 2. parse → 200 on null (no processing)
 * 3. consume `rateLimit.perSender` bucket → 200 on denial
 * 4. consume `rateLimit.perAccount` bucket → 200 on denial (Sybil guard)
 * 5. resolve session via `findBySourceAndSender(def.id, parsed.senderId)`
 *    (creates if missing, with `sender` persisted on the new row)
 * 6. stash `{ accountId, inbound }` under `channel-inbound:${sessionId}`
 * 7. fire `sendPrompt({ sessionId, text })` inside `waitUntil(...)` with
 *    a `.catch` that falls back to `def.sendReply(...)` with an error reply
 * 8. return HTTP 200 immediately so the provider does not retry
 *
 * The helper's `afterTurn` hook reads the stash and forwards the final
 * assistant text to `def.sendReply(account, stash.inbound, finalText)`,
 * catching any failure so the turn always completes normally for other
 * capabilities.
 *
 * Rate-limit denials (both buckets) return HTTP 200 — NOT 429 — to avoid
 * webhook-provider retry amplification. Telegram in particular will retry
 * failed webhooks aggressively.
 */
export function defineChannel<TAccount extends { id: string }, TInbound>(
  def: ChannelDefinition<TAccount, TInbound>,
): Capability {
  // Accounts are loaded lazily (since `accounts(env)` may be async). We
  // cache the resolved list after the first call.
  let accountsCache: TAccount[] | null = null;
  let accountsEnv: unknown;
  async function getAccounts(env: unknown): Promise<TAccount[]> {
    if (accountsCache && accountsEnv === env) return accountsCache;
    const loaded = await def.accounts(env);
    accountsCache = loaded;
    accountsEnv = env;
    return loaded;
  }

  const capability: Capability = {
    id: def.id,
    name: def.id,
    description: `Channel capability for ${def.id}`,

    /**
     * Register one HTTP handler per account at the configured path. The
     * AgentContext passed here carries the runtime's shared `rateLimit`
     * and a storage scoped to this capability id.
     */
    httpHandlers: (ctx: AgentContext): HttpHandler[] => {
      // `accounts(env)` is async but `httpHandlers` is synchronous. We
      // kick off a resolution that will be awaited inside the handler and
      // also return a cheap synchronous "best known" view when already
      // resolved. For the initial registration pass we need a synchronous
      // answer — so if the cache is empty we return zero handlers and
      // the channel relies on lifecycle-based registration re-runs. In
      // practice the runtime only calls `httpHandlers` once per DO
      // lifetime, so synchronous accounts are the supported path.
      //
      // Callers whose `accounts(env)` is synchronous (Array return) will
      // hit the fast path below and get handlers immediately.
      const maybeAccounts = def.accounts((ctx as unknown as { env?: unknown }).env);
      if (Array.isArray(maybeAccounts)) {
        accountsCache = maybeAccounts;
      }
      const accounts = accountsCache ?? [];

      return accounts.map((account) => ({
        method: "POST" as const,
        path: def.webhookPath(account),
        handler: (request: Request, httpCtx: CapabilityHttpContext) =>
          handleInbound(def, account, request, httpCtx),
      }));
    },

    /**
     * Read the inbound stash and dispatch the final assistant text via
     * `def.sendReply`. Errors from `sendReply` are caught and logged —
     * the turn always completes normally for other capabilities.
     */
    afterTurn: async (ctx: AgentContext, sessionId: string, finalText: string) => {
      const stash = await ctx.storage.get<ChannelInboundStash<TInbound>>(stashKey(sessionId));
      if (!stash) return; // No channel inbound for this session — nothing to dispatch.

      const accounts = await getAccounts((ctx as unknown as { env?: unknown }).env);
      const account = accounts.find((a) => a.id === stash.accountId);
      if (!account) {
        // The account was removed between webhook receipt and turn end.
        // Log and drop — there is nowhere to send the reply.
        console.error(
          `[channel:${def.id}] afterTurn: account "${stash.accountId}" no longer configured for session ${sessionId}`,
        );
        return;
      }

      try {
        await def.sendReply(account, stash.inbound, finalText);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[channel:${def.id}] sendReply failed for session ${sessionId}: ${message}`);
      }
    },

    /**
     * Call `onAccountAdded` for every configured account at capability
     * disposal-inverse initialization. Errors are caught so a single
     * failing account does not abort capability wiring.
     */
    hooks: {
      onConnect: async (hookCtx) => {
        // Use onConnect as the lifecycle trigger for onAccountAdded —
        // the runtime fires onConnect once per capability per DO when the
        // first WebSocket connects or when the DO re-initializes. Most
        // channel providers' `setWebhook` calls are idempotent so repeated
        // firings are safe. Channels that need strictly-once semantics
        // should record "webhook registered" in their own KV.
        if (!def.onAccountAdded) return;
        // Runtime context: `onConnect` receives a hookCtx. We plumb env
        // through by reading it off the context — capabilities don't see
        // env directly, so `getAccounts` falls back to undefined here,
        // which works for channels whose accounts list is already cached
        // from the httpHandlers registration pass.
        const accounts = await getAccounts(undefined);
        for (const account of accounts) {
          try {
            await def.onAccountAdded(account, hookCtx);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(
              `[channel:${def.id}] onAccountAdded failed for account "${account.id}": ${message}`,
            );
          }
        }
      },
    },

    /**
     * Call `onAccountRemoved` for every configured account at capability
     * disposal. Errors are caught per-account.
     */
    dispose: async () => {
      if (!def.onAccountRemoved) return;
      const accounts = accountsCache ?? [];
      for (const account of accounts) {
        try {
          await def.onAccountRemoved(account, {
            // Minimal hook context — channels that need real storage at
            // dispose time can hang onto references they captured earlier.
            agentId: "",
            sessionId: "",
            // biome-ignore lint/suspicious/noExplicitAny: dispose-time context is intentionally minimal
            sessionStore: {} as any,
            // biome-ignore lint/suspicious/noExplicitAny: dispose-time context is intentionally minimal
            storage: {} as any,
            capabilityIds: [def.id],
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `[channel:${def.id}] onAccountRemoved failed for account "${account.id}": ${message}`,
          );
        }
      }
    },
  };

  return capability;
}

/**
 * The full inbound webhook pipeline, extracted so it can be tested in
 * isolation and referenced from `httpHandlers`. Each step below maps
 * directly to a clause in the "defineChannel wires the inbound pipeline
 * correctly" spec requirement.
 */
async function handleInbound<TAccount extends { id: string }, TInbound>(
  def: ChannelDefinition<TAccount, TInbound>,
  account: TAccount,
  request: Request,
  ctx: CapabilityHttpContext,
): Promise<Response> {
  // 1. Verify — 403 on failure, without reading the body.
  let verified: boolean;
  try {
    verified = await Promise.resolve(def.verifyWebhook(request, account));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[channel:${def.id}] verifyWebhook threw for account "${account.id}": ${message}`,
    );
    return new Response("Forbidden", { status: 403 });
  }
  if (!verified) {
    return new Response("Forbidden", { status: 403 });
  }

  // 2. Parse — null return acks without processing.
  let parsed: ParsedInbound<TInbound> | null;
  try {
    parsed = await def.parseWebhook(request, account);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[channel:${def.id}] parseWebhook threw: ${message}`);
    return new Response("ok", { status: 200 });
  }
  if (!parsed) {
    return new Response("ok", { status: 200 });
  }

  // 3. Per-sender rate-limit — HTTP 200 on denial (no 429) so the provider
  //    doesn't retry-storm us.
  const perSenderKey = `${def.id}:${account.id}:sender:${parsed.senderId}`;
  const perSenderResult = await ctx.rateLimit.consume({
    key: perSenderKey,
    ...def.rateLimit.perSender,
  });
  if (!perSenderResult.allowed) {
    return new Response("ok", { status: 200 });
  }

  // 4. Per-account global rate-limit — Sybil guard against attackers who
  //    rotate senderIds to evade the per-sender bucket.
  const perAccountKey = `${def.id}:${account.id}:_global`;
  const perAccountResult = await ctx.rateLimit.consume({
    key: perAccountKey,
    ...def.rateLimit.perAccount,
  });
  if (!perAccountResult.allowed) {
    return new Response("ok", { status: 200 });
  }

  // 5. Resolve session via findBySourceAndSender with create-if-missing
  //    fallback. The DO's single-threaded execution serializes this, so
  //    no transaction is required — the spec explicitly calls this out.
  const existing = ctx.sessionStore.findBySourceAndSender(def.id, parsed.senderId);
  const session =
    existing ??
    ctx.sessionStore.create({
      source: def.id,
      sender: parsed.senderId,
    });

  // 6. Stash the per-turn inbound payload. `afterTurn` reads this key.
  //    Overwrites are expected on chat-like flows; the stash is NOT
  //    deleted after dispatch.
  const stash: ChannelInboundStash<TInbound> = {
    accountId: account.id,
    inbound: parsed.inbound,
  };
  await ctx.storage.put(stashKey(session.id), stash);

  // 7. Drive inference under a `.catch` that invokes a best-effort error
  //    reply. We do NOT await this — the provider needs a fast 200.
  ctx.sendPrompt({ sessionId: session.id, text: parsed.text }).catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[channel:${def.id}] sendPrompt failed for session ${session.id}: ${message}`);
    try {
      await def.sendReply(account, parsed.inbound, ERROR_REPLY_TEXT);
    } catch (replyErr) {
      const replyMessage = replyErr instanceof Error ? replyErr.message : String(replyErr);
      console.error(`[channel:${def.id}] best-effort error reply also failed: ${replyMessage}`);
    }
  });

  // 8. Respond 200 immediately.
  return new Response("ok", { status: 200 });
}

// Re-export types for consumers that only want the public surface.
export type {
  ChannelDefinition,
  ChannelInboundStash,
  ParsedInbound,
  RateLimitConfig,
} from "./types.js";
