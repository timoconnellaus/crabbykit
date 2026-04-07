import { createFileRoute } from "@tanstack/react-router";
import { AppsPanel } from "../../../components/apps-panel";
import { useChatContext } from "../../../context/chat-context";

export const Route = createFileRoute("/$agentId/$sessionId/apps")({
  component: AppsRoute,
});

function AppsRoute() {
  const { deployedApps } = useChatContext();
  return <AppsPanel apps={deployedApps} />;
}
