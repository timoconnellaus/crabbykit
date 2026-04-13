import { env as rawEnv } from "cloudflare:workers";
import { handleDeployRequest } from "@claw-for-cloudflare/vibe-coder";
import { createFileRoute } from "@tanstack/react-router";
import type { Env } from "../../../../../worker";

const env = rawEnv as unknown as Env;

async function deployProxy({ request }: { request: Request }) {
  const res = handleDeployRequest({
    request,
    agentNamespace: env.AGENT,
    storageBucket: env.STORAGE_BUCKET,
    loader: env.LOADER,
    dbService: env.DB_SERVICE,
    aiService: env.AI_SERVICE,
  });
  return res ?? new Response("Not found", { status: 404 });
}

export const Route = createFileRoute("/api/deploy/$agentId/$deployId/$")({
  server: {
    handlers: {
      GET: deployProxy,
      POST: deployProxy,
    },
  },
});
