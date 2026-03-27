import type { ComponentPropsWithoutRef, MouseEvent } from "react";
import { useChat } from "./chat-provider";

export interface SessionListProps extends ComponentPropsWithoutRef<"div"> {}

export function SessionList(props: SessionListProps) {
  const { sessions, currentSessionId, switchSession, createSession, deleteSession } = useChat();

  return (
    <div data-agent-ui="session-list" {...props}>
      {sessions.map((s) => (
        <div
          key={s.id}
          data-agent-ui="session-item"
          data-active={s.id === currentSessionId || undefined}
        >
          <button
            type="button"
            data-agent-ui="session-item-select"
            onClick={() => switchSession(s.id)}
          >
            {s.name || "Untitled"}
          </button>
          {sessions.length > 1 && (
            <button
              type="button"
              data-agent-ui="session-item-delete"
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                deleteSession(s.id);
              }}
              title="Delete session"
            >
              &times;
            </button>
          )}
        </div>
      ))}
      <button type="button" data-agent-ui="session-new" onClick={() => createSession()}>
        New session
      </button>
    </div>
  );
}
