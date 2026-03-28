import { useAgentChat } from "@claw-for-cloudflare/agent-runtime/client";
import {
  ChatInput,
  ChatPanel,
  MessageList,
  SessionList,
  StatusBar,
  useChat,
} from "@claw-for-cloudflare/agent-ui";

function SchedulePanel() {
  const { schedules } = useChat();

  if (schedules.length === 0) return null;

  return (
    <div data-agent-ui="schedule-list">
      <div data-agent-ui="schedule-heading">Schedules</div>
      {schedules.map((s) => (
        <div key={s.id} data-agent-ui="schedule-item" data-status={s.status}>
          <div data-agent-ui="schedule-name">{s.name}</div>
          <div data-agent-ui="schedule-meta">
            {!s.enabled ? "disabled" : s.status === "idle" ? "active" : s.status}
            {s.nextFireAt && ` \u00B7 next ${new Date(s.nextFireAt).toLocaleTimeString()}`}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const chat = useAgentChat({
    url: `ws://${window.location.host}/agent`,
  });

  return (
    <ChatPanel chat={chat} style={{ flexDirection: "row" }}>
      <div data-agent-ui="sidebar">
        <SessionList />
        <SchedulePanel />
      </div>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        <StatusBar />
        <MessageList />
        <ChatInput />
      </div>
    </ChatPanel>
  );
}
