import { useSchedules } from "@claw-for-cloudflare/agent-runtime/client";
import { createFileRoute } from "@tanstack/react-router";
import { SchedulePanel } from "../../../components/schedule-panel";
import { useChatContext } from "../../../context/chat-context";

export const Route = createFileRoute("/$agentId/$sessionId/schedules")({
  component: SchedulesRoute,
});

function SchedulesRoute() {
  const { agentId } = useChatContext();
  const { schedules, toggleSchedule } = useSchedules();
  return <SchedulePanel agentId={agentId} schedules={schedules} toggleSchedule={toggleSchedule} />;
}
