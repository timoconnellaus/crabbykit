import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  ssr: false,
  beforeLoad: async () => {
    // Fetch agent list; create default if empty
    let agents = (await (await fetch("/api/agents")).json()) as Array<{ id: string }>;
    if (agents.length === 0) {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Default Agent" }),
      });
      const agent = (await res.json()) as { id: string };
      agents = [agent];
    }
    throw redirect({
      to: "/$agentId/$sessionId/chat",
      params: { agentId: agents[0].id, sessionId: "latest" },
    });
  },
});
