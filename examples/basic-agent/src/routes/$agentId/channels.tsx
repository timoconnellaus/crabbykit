import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$agentId/channels")({
  ssr: false,
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$agentId/$sessionId/channels",
      params: { agentId: params.agentId, sessionId: "latest" },
    });
  },
});
