import { createFileRoute } from "@tanstack/react-router";
import { env as rawEnv } from "cloudflare:workers";
import type { Env } from "../../../worker";

const env = rawEnv as unknown as Env;

/**
 * Telegram webhook proxy.
 *
 * Telegram POSTs inbound updates to
 *   `{PUBLIC_URL}/telegram/webhook/<accountId>`
 * (the URL the `defineTelegramChannel` capability registers via
 * `setWebhook`). This top-level route forwards the request into the
 * `"default"` agent DO — basic-agent is a single-agent demo, so every
 * inbound maps to the same DO. A multi-tenant deployment would route on
 * some header/query/path segment to the right agent id.
 *
 * We rewrite the path back to `/telegram/webhook/<accountId>` so the
 * channel capability's internal HTTP handler matches it inside the DO.
 */
async function telegramProxy({
  request,
  params,
}: {
  request: Request;
  params: { accountId: string };
}) {
  const id = env.AGENT.idFromName("default");
  const stub = env.AGENT.get(id);
  const url = new URL(request.url);
  url.pathname = `/telegram/webhook/${params.accountId}`;
  return stub.fetch(new Request(url.toString(), request));
}

export const Route = createFileRoute("/telegram/webhook/$accountId")({
  server: {
    handlers: {
      POST: telegramProxy,
    },
  },
});
