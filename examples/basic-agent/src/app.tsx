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
  const { schedules, toggleSchedule } = useChat();

  if (schedules.length === 0) return null;

  return (
    <div data-agent-ui="schedule-list">
      <div data-agent-ui="schedule-heading">Schedules</div>
      {schedules.map((s) => (
        <div key={s.id} data-agent-ui="schedule-item" data-status={s.status} style={{ position: "relative" }}>
          <button
            type="button"
            role="switch"
            aria-checked={s.enabled}
            onClick={() => toggleSchedule(s.id, !s.enabled)}
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              width: 36,
              height: 20,
              borderRadius: 10,
              border: "none",
              cursor: "pointer",
              background: s.enabled ? "#4ade80" : "#555",
              transition: "background 0.2s",
              padding: 0,
            }}
          >
            <span
              style={{
                display: "block",
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: "#fff",
                transition: "transform 0.2s",
                transform: s.enabled ? "translateX(18px)" : "translateX(2px)",
              }}
            />
          </button>
          <div data-agent-ui="schedule-name">{s.name}</div>
          <div data-agent-ui="schedule-meta">
            {!s.enabled ? "disabled" : s.status === "idle" ? "active" : s.status}
            {s.nextFireAt && s.enabled && ` \u00B7 next ${new Date(s.nextFireAt).toLocaleTimeString()}`}
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
