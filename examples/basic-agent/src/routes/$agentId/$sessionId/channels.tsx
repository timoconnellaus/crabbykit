import { ChannelsPanel } from "@claw-for-cloudflare/agent-ui";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/$agentId/$sessionId/channels")({
  component: ChannelsRoute,
});

function ChannelsRoute() {
  return <ChannelsPanel />;
}
