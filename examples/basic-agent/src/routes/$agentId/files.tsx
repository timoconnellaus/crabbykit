import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$agentId/files")({
  ssr: false,
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$agentId/$sessionId/files",
      params: { agentId: params.agentId, sessionId: "latest" },
    });
  },
});
