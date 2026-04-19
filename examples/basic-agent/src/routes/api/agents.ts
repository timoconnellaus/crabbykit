import { env as rawEnv } from "cloudflare:workers";
import { D1AgentRegistry } from "@crabbykit/agent-registry";
import { createFileRoute } from "@tanstack/react-router";
import type { Env } from "../../worker";

const env = rawEnv as unknown as Env;

export const Route = createFileRoute("/api/agents")({
  server: {
    handlers: {
      GET: async () => {
        const registry = new D1AgentRegistry(env.AGENT_DB);
        const agents = await registry.list("default");
        return Response.json(agents);
      },
      POST: async ({ request }) => {
        const body = (await request.json()) as { name: string };
        const registry = new D1AgentRegistry(env.AGENT_DB);
        const agent = await registry.create({
          id: crypto.randomUUID(),
          name: body.name,
          ownerId: "default",
          parentAgentId: null,
        });
        return Response.json(agent, { status: 201 });
      },
    },
  },
});
