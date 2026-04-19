import { ChannelsPanel } from "@crabbykit/agent-ui";
import { createFileRoute } from "@tanstack/react-router";
import { channelsStyles } from "../../../styles/channels";

export const Route = createFileRoute("/$agentId/$sessionId/channels")({
  component: ChannelsRoute,
});

function ChannelsRoute() {
  return (
    <>
      <style>{channelsStyles}</style>
      <ChannelsPanel />
    </>
  );
}
