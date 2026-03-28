import { useAgentChat } from "@claw-for-cloudflare/agent-runtime/client";
import type { SandboxBadgeProps } from "@claw-for-cloudflare/agent-ui";
import {
  ChatInput,
  ChatPanel,
  MessageList,
  SessionList,
  StatusBar,
  ThinkingIndicator,
  useChat,
} from "@claw-for-cloudflare/agent-ui";
import { useCallback, useState } from "react";

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
  const [sandboxState, setSandboxState] = useState<SandboxBadgeProps>({
    elevated: false,
  });

  const onCustomEvent = useCallback((name: string, data: Record<string, unknown>) => {
    if (name === "sandbox_elevation") {
      setSandboxState((prev) => ({
        ...prev,
        elevated: data.elevated as boolean,
      }));
    }
    if (name === "sandbox_timeout") {
      setSandboxState((prev) => ({
        ...prev,
        expiresAt: data.expiresAt as number,
        timeoutSeconds: data.timeoutSeconds as number,
      }));
    }
  }, []);

  const chat = useAgentChat({
    url: `ws://${window.location.host}/agent`,
    onCustomEvent,
  });

  return (
    <ChatPanel chat={chat} style={{ flexDirection: "row" }}>
      <div data-agent-ui="sidebar">
        <SessionList />
        <SchedulePanel />
      </div>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        <StatusBar sandboxState={sandboxState} />
        <MessageList />
        <ThinkingIndicator />
        <ChatInput />
      </div>
    </ChatPanel>
  );
}
