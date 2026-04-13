import { env as rawEnv } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import type { Env } from "../../../../worker";

const env = rawEnv as unknown as Env;

async function agentProxy({
  request,
  params,
}: {
  request: Request;
  params: { agentId: string; _splat: string };
}) {
  const id = env.AGENT.idFromName(params.agentId);
  const stub = env.AGENT.get(id);
  const url = new URL(request.url);
  url.pathname = params._splat ? `/${params._splat}` : "/";
  return stub.fetch(new Request(url.toString(), request));
}

export const Route = createFileRoute("/api/agent/$agentId/$")({
  server: {
    handlers: {
      GET: agentProxy,
      POST: agentProxy,
      PUT: agentProxy,
      DELETE: agentProxy,
      PATCH: agentProxy,
    },
  },
});
