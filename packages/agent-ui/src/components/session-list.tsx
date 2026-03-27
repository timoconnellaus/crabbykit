import type { ComponentPropsWithoutRef } from "react";
import { useChat } from "./chat-provider";

export interface SessionListProps extends ComponentPropsWithoutRef<"div"> {}

export function SessionList(props: SessionListProps) {
  const { sessions, currentSessionId, switchSession, createSession } = useChat();

  return (
    <div data-agent-ui="session-list" {...props}>
      {sessions.map((s) => (
        <button
          key={s.id}
          data-agent-ui="session-item"
          data-active={s.id === currentSessionId || undefined}
          onClick={() => switchSession(s.id)}
        >
          {s.name || "Untitled"}
        </button>
      ))}
      <button
        data-agent-ui="session-new"
        onClick={() => createSession()}
      >
        New session
      </button>
    </div>
  );
}
