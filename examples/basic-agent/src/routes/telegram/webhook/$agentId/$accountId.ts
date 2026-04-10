import { env as rawEnv } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import type { Env } from "../../../../worker";

const env = rawEnv as unknown as Env;

/**
 * Multi-tenant Telegram webhook proxy.
 *
 * Telegram POSTs inbound updates to
 *   `{PUBLIC_URL}/telegram/webhook/<agentId>/<accountId>`
 * — the URL shape registered by `defineTelegramChannel` when
 * constructed with an `agentId`. We extract `agentId` from the path
 * params, look up the corresponding DO via `idFromName`, and forward
 * the request with the path rewritten back to
 * `/telegram/webhook/<accountId>` so the channel capability's internal
 * HTTP handler (`webhookPathPattern`) matches it unchanged inside the
 * DO.
 */
async function telegramProxy({
  request,
  params,
}: {
  request: Request;
  params: { agentId: string; accountId: string };
}) {
  const id = env.AGENT.idFromName(params.agentId);
  const stub = env.AGENT.get(id);
  const url = new URL(request.url);
  url.pathname = `/telegram/webhook/${params.accountId}`;
  return stub.fetch(new Request(url.toString(), request));
}

export const Route = createFileRoute("/telegram/webhook/$agentId/$accountId")({
  server: {
    handlers: {
      POST: telegramProxy,
    },
  },
});
