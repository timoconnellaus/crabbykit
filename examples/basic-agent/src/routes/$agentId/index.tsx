import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$agentId/")({
  ssr: false,
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$agentId/$sessionId/chat",
      params: { agentId: params.agentId, sessionId: "latest" },
    });
  },
});
