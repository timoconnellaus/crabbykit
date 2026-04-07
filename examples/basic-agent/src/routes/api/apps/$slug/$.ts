import { createFileRoute } from "@tanstack/react-router";
import { env as rawEnv } from "cloudflare:workers";
import { handleAppRequest } from "@claw-for-cloudflare/app-registry";
import type { Env } from "../../../../worker";

const env = rawEnv as unknown as Env;

async function appProxy({ request }: { request: Request }) {
  const res = handleAppRequest({
    request,
    agentNamespace: env.AGENT,
    storageBucket: env.STORAGE_BUCKET,
    loader: env.LOADER,
    dbService: env.DB_SERVICE,
  });
  return res ?? new Response("Not found", { status: 404 });
}

export const Route = createFileRoute("/api/apps/$slug/$")({
  server: {
    handlers: {
      GET: appProxy,
      POST: appProxy,
    },
  },
});
