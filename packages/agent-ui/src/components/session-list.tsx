import { useSessions } from "@claw-for-cloudflare/agent-runtime/client";
import { type ComponentPropsWithoutRef, type MouseEvent, useEffect, useRef, useState } from "react";

export interface SessionListProps extends ComponentPropsWithoutRef<"div"> {}

export function SessionList(props: SessionListProps) {
  const { sessions, currentSessionId, switchSession, createSession, deleteSession } = useSessions();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  function handleDelete(e: MouseEvent, sessionId: string) {
    e.stopPropagation();
    if (confirmingId === sessionId) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
      setConfirmingId(null);
      deleteSession(sessionId);
    } else {
      setConfirmingId(sessionId);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => {
        setConfirmingId(null);
        confirmTimerRef.current = null;
      }, 3000);
    }
  }

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
              data-confirming={confirmingId === s.id || undefined}
              onClick={(e: MouseEvent) => handleDelete(e, s.id)}
              aria-label={confirmingId === s.id ? "Confirm delete" : "Delete session"}
              title={confirmingId === s.id ? "Click again to confirm" : "Delete session"}
            >
              {confirmingId === s.id ? "?" : "\u00d7"}
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
