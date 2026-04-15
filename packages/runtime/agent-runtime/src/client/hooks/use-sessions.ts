import { useCallback } from "react";
import { useAgentConnection } from "../agent-connection-provider.js";
import type { ChatState } from "../chat-reducer.js";

export type SessionSummary = ChatState["sessions"][number];

export interface UseSessionsReturn {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  switchSession: (sessionId: string) => void;
  createSession: (name?: string) => void;
  deleteSession: (sessionId: string) => void;
}

/**
 * Exposes the session list and session CRUD actions. Reads from the shared
 * reducer state populated by `session_list` / `session_sync` messages.
 */
export function useSessions(): UseSessionsReturn {
  const { send, state } = useAgentConnection();

  const switchSession = useCallback(
    (sessionId: string) => {
      send({ type: "switch_session", sessionId });
    },
    [send],
  );

  const createSession = useCallback(
    (name?: string) => {
      send({ type: "new_session", name });
    },
    [send],
  );

  const deleteSession = useCallback(
    (sessionId: string) => {
      send({ type: "delete_session", sessionId });
    },
    [send],
  );

  return {
    sessions: state.sessions,
    currentSessionId: state.currentSessionId,
    switchSession,
    createSession,
    deleteSession,
  };
}
