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
 * pipeline.
 *
 * **Dynamic accounts.** `defineChannel` no longer registers one handler
 * per account — it registers a single handler at the channel's
 * `webhookPathPattern` (e.g. `"/telegram/webhook/:accountId"`). At
 * request time the runtime's path-pattern matcher extracts the account
 * id and places it in `ctx.params.accountId`; the handler calls
 * `def.getAccount(accountId, env)` against the channel's backing store.
 * No handler cache invalidation, no lifecycle juggling when the user
 * adds an account — the route is live immediately.
 *
 * Pipeline:
 * 1. Look up the account by the path-param id. Return 403 if unknown.
 * 2. Verify — 403 on failure.
 * 3. Parse — 200 on null (ack without processing).
 * 4. Consume `rateLimit.perSender` bucket. Return 200 on denial.
 * 5. Consume `rateLimit.perAccount` bucket (Sybil guard). Return 200 on denial.
 * 6. Resolve session via `findBySourceAndSender(def.id, parsed.senderId)`.
 * 7. Stash `{ accountId, inbound }` under `channel-inbound:${sessionId}`.
 * 8. Fire `sendPrompt({ sessionId, text })` inside the runtime's
 *    implicit `waitUntil` (via fire-and-forget), with a `.catch` that
 *    calls `def.sendReply(…)` with a fallback error reply.
 * 9. Return HTTP 200 immediately.
 *
 * The helper's `afterTurn` hook reads the stash and forwards the final
 * assistant text to `def.sendReply(account, stash.inbound, finalText)`,
 * catching any failure so the turn always completes normally for other
 * capabilities. If the stashed account id no longer resolves (user
 * deleted the account between webhook receipt and turn end), `afterTurn`
 * logs and drops.
 *
 * Rate-limit denials (both buckets) return HTTP 200 — NOT 429 — to
 * avoid webhook-provider retry amplification.
 */
export function defineChannel<TAccount extends { id: string }, TInbound>(
  def: ChannelDefinition<TAccount, TInbound>,
): Capability {
  const capability: Capability = {
    id: def.id,
    name: def.id,
    description: `Channel capability for ${def.id}`,

    /**
     * Register a single HTTP handler that accepts ANY account id via
     * the `:accountId` path parameter. The runtime's path-pattern
     * matcher extracts the id before calling the handler, so this one
     * handler serves every configured account (plus any added at
     * runtime — no cache invalidation required).
     */
    httpHandlers: (_ctx: AgentContext): HttpHandler[] => [
      {
        method: "POST" as const,
        path: def.webhookPathPattern,
        handler: (request: Request, httpCtx: CapabilityHttpContext) =>
          handleInbound(def, request, httpCtx),
      },
    ],

    /**
     * Read the inbound stash and dispatch the final assistant text via
     * `def.sendReply`. Errors from `sendReply` are caught and logged —
     * the turn always completes normally for other capabilities.
     */
    afterTurn: async (ctx: AgentContext, sessionId: string, finalText: string) => {
      const stash = await ctx.storage.get<ChannelInboundStash<TInbound>>(stashKey(sessionId));
      if (!stash) return; // No channel inbound for this session — nothing to dispatch.

      const account = await def.getAccount(stash.accountId, ctx.storage);
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
  };

  return capability;
}

/**
 * The full inbound webhook pipeline, extracted so it can be tested in
 * isolation and referenced from `httpHandlers`. The account id comes
 * from the path-pattern matcher via `ctx.params.accountId`; there is
 * no per-account handler closure anymore.
 */
async function handleInbound<TAccount extends { id: string }, TInbound>(
  def: ChannelDefinition<TAccount, TInbound>,
  request: Request,
  ctx: CapabilityHttpContext,
): Promise<Response> {
  // 0. Look up the account by the path-parameter id. This is the only
  //    code path that reads accounts on the webhook hot path, and it
  //    hits the channel's backing store (SQL / KV / env) directly.
  const accountId = ctx.params.accountId;
  if (!accountId) {
    // Handler was reached via an exact-match registration, or the path
    // pattern does not include :accountId. This is a channel-definition
    // bug — fail loud in development but return 403 in production so
    // attackers can't enumerate the route shape.
    console.error(
      `[channel:${def.id}] handler invoked without :accountId path param. Does def.webhookPathPattern include it?`,
    );
    return new Response("Forbidden", { status: 403 });
  }
  let account: TAccount | null;
  try {
    account = await def.getAccount(accountId, ctx.storage);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[channel:${def.id}] getAccount threw for id "${accountId}": ${message}`,
    );
    return new Response("Forbidden", { status: 403 });
  }
  if (!account) {
    // Unknown account — return 403 (not 404) so enumeration attacks get
    // the same shape whether the id is invalid or the verifier rejects.
    return new Response("Forbidden", { status: 403 });
  }

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

  // 3. Per-sender rate-limit — HTTP 200 on denial (no 429) so the
  //    provider doesn't retry-storm us. `rateLimit` may be a static
  //    object or a function of the dispatching ctx — call it fresh on
  //    every inbound so agent-config changes take effect immediately.
  const resolvedLimits =
    typeof def.rateLimit === "function" ? def.rateLimit(ctx) : def.rateLimit;
  const perSenderKey = `${def.id}:${account.id}:sender:${parsed.senderId}`;
  const perSenderResult = await ctx.rateLimit.consume({
    key: perSenderKey,
    ...resolvedLimits.perSender,
  });
  if (!perSenderResult.allowed) {
    return new Response("ok", { status: 200 });
  }

  // 4. Per-account global rate-limit — Sybil guard against attackers
  //    who rotate senderIds to evade the per-sender bucket.
  const perAccountKey = `${def.id}:${account.id}:_global`;
  const perAccountResult = await ctx.rateLimit.consume({
    key: perAccountKey,
    ...resolvedLimits.perAccount,
  });
  if (!perAccountResult.allowed) {
    return new Response("ok", { status: 200 });
  }

  // 5. Resolve session via findBySourceAndSender with create-if-missing
  //    fallback. The DO's single-threaded execution serializes this, so
  //    no transaction is required.
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

  // 7. Drive inference under a `.catch` that invokes a best-effort
  //    error reply. We do NOT await this — the provider needs a fast
  //    200.
  const resolvedAccount = account;
  ctx.sendPrompt({ sessionId: session.id, text: parsed.text }).catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[channel:${def.id}] sendPrompt failed for session ${session.id}: ${message}`);
    try {
      await def.sendReply(resolvedAccount, parsed.inbound, ERROR_REPLY_TEXT);
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
