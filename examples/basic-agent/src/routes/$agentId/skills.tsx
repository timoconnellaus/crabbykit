import { createFileRoute } from "@tanstack/react-router";
import { SkillsPanel } from "../../components/skills-panel";
import { useChatContext } from "../../context/chat-context";

export const Route = createFileRoute("/$agentId/skills")({
  component: SkillsRoute,
});

function SkillsRoute() {
  const { chat, agentId } = useChatContext();
  return <SkillsPanel skills={chat.skills} agentId={agentId} />;
}
