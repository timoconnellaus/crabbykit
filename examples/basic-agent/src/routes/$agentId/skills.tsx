import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$agentId/skills")({
  ssr: false,
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$agentId/$sessionId/skills",
      params: { agentId: params.agentId, sessionId: "latest" },
    });
  },
});
