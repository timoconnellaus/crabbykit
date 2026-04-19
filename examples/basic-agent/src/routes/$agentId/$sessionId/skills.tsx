import { useSkills } from "@crabbykit/agent-runtime/client";
import { createFileRoute } from "@tanstack/react-router";
import { SkillsPanel } from "../../../components/skills-panel";
import { useChatContext } from "../../../context/chat-context";

export const Route = createFileRoute("/$agentId/$sessionId/skills")({
  component: SkillsRoute,
});

function SkillsRoute() {
  const { agentId } = useChatContext();
  const { skills } = useSkills();
  return <SkillsPanel skills={skills} agentId={agentId} />;
}
