import { createFileRoute } from "@tanstack/react-router";
import { SchedulePanel } from "../../../components/schedule-panel";
import { useChatContext } from "../../../context/chat-context";

export const Route = createFileRoute("/$agentId/$sessionId/schedules")({
  component: SchedulesRoute,
});

function SchedulesRoute() {
  const { agentId, chat } = useChatContext();
  return (
    <SchedulePanel
      agentId={agentId}
      schedules={chat.schedules}
      toggleSchedule={chat.toggleSchedule}
    />
  );
}
