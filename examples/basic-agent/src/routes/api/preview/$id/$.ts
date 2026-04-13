import { env as rawEnv } from "cloudflare:workers";
import { handlePreviewRequest } from "@claw-for-cloudflare/cloudflare-sandbox";
import { createFileRoute } from "@tanstack/react-router";
import type { Env } from "../../../../worker";

const env = rawEnv as unknown as Env;

async function previewProxy({ request }: { request: Request }) {
  const res = handlePreviewRequest({
    request,
    agentNamespace: env.AGENT,
    containerNamespace: env.SANDBOX_CONTAINER,
  });
  return res ?? new Response("Not found", { status: 404 });
}

export const Route = createFileRoute("/api/preview/$id/$")({
  server: {
    handlers: {
      GET: previewProxy,
      POST: previewProxy,
      PUT: previewProxy,
      DELETE: previewProxy,
    },
  },
});
