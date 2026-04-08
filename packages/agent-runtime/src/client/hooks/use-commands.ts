import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import { useCallback } from "react";
import { useAgentConnection } from "../agent-connection-provider.js";
import type { CommandInfo } from "../chat-reducer.js";

export interface UseCommandsReturn {
  availableCommands: CommandInfo[];
  sendCommand: (name: string, args?: string) => void;
}

/**
 * Subscribes to the "commands" capability state and exposes a `sendCommand`
 * action that sends the core `command` client message (with optimistic user
 * message dispatch).
 */
export function useCommands(): UseCommandsReturn {
  const { send, state, dispatch } = useAgentConnection();

  const data = state.capabilityState.commands as { commands?: CommandInfo[] } | undefined;
  const availableCommands = data?.commands ?? [];

  const sendCommand = useCallback(
    (name: string, args?: string) => {
      if (!state.currentSessionId) return;
      dispatch({ type: "SET_ERROR", error: null });
      send({
        type: "command",
        sessionId: state.currentSessionId,
        name,
        args: args?.trim(),
      });

      // Optimistically add user message.
      const text = args ? `/${name} ${args}` : `/${name}`;
      dispatch({
        type: "ADD_MESSAGE",
        message: { role: "user", content: text, timestamp: Date.now() } as AgentMessage,
      });
    },
    [state.currentSessionId, send, dispatch],
  );

  return { availableCommands, sendCommand };
}
