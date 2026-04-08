import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import { useCallback, useMemo } from "react";
import type { CostEvent } from "../../costs/types.js";
import { useAgentConnection } from "../agent-connection-provider.js";
import type { CommandInfo, ToolState } from "../chat-reducer.js";
import type { AgentStatus } from "../types.js";

export interface UseChatSessionReturn {
  messages: AgentMessage[];
  agentStatus: AgentStatus;
  thinking: string | null;
  completedThinking: string | null;
  toolStates: Map<string, ToolState>;
  costs: CostEvent[];
  error: string | null;
  sendMessage: (text: string) => void;
  steerMessage: (text: string) => void;
  abort: () => void;
}

/**
 * Core chat state and actions for the current session. Consumes the
 * `AgentConnectionProvider` context.
 */
export function useChatSession(): UseChatSessionReturn {
  const { send, state, dispatch } = useAgentConnection();

  // Derive available commands from capabilityState for slash-command detection
  const availableCommands = useMemo<CommandInfo[]>(() => {
    const data = state.capabilityState.commands as { commands?: CommandInfo[] } | undefined;
    return data?.commands ?? [];
  }, [state.capabilityState.commands]);

  const sendMessage = useCallback(
    (text: string) => {
      if (!state.currentSessionId) return;
      dispatch({ type: "SET_ERROR", error: null });

      // Detect slash commands: "/name" or "/name args..."
      // Only intercept known commands to avoid false positives (e.g. "/path/to/file").
      const commandMatch = text.match(/^\/(\S+)(?:\s+(.*))?$/);
      if (commandMatch) {
        const [, name, args] = commandMatch;
        const isKnownCommand = availableCommands.some((cmd) => cmd.name === name);
        if (isKnownCommand) {
          send({
            type: "command",
            sessionId: state.currentSessionId,
            name,
            args: args?.trim(),
          });

          dispatch({
            type: "ADD_MESSAGE",
            message: { role: "user", content: text, timestamp: Date.now() } as AgentMessage,
          });
          dispatch({ type: "SET_AGENT_STATUS", agentStatus: "streaming" });
          return;
        }
      }

      if (state.agentStatus === "idle") {
        send({ type: "prompt", sessionId: state.currentSessionId, text });
        dispatch({
          type: "ADD_MESSAGE",
          message: { role: "user", content: text, timestamp: Date.now() } as AgentMessage,
        });
        dispatch({ type: "SET_AGENT_STATUS", agentStatus: "streaming" });
      } else {
        // Agent busy — queue the message via capability_action
        send({
          type: "capability_action",
          capabilityId: "queue",
          action: "message",
          data: { text },
          sessionId: state.currentSessionId,
        });
      }
    },
    [state.currentSessionId, state.agentStatus, availableCommands, send, dispatch],
  );

  const steerMessage = useCallback(
    (text: string) => {
      if (!state.currentSessionId) return;
      dispatch({ type: "SET_ERROR", error: null });
      send({ type: "steer", sessionId: state.currentSessionId, text });
      dispatch({
        type: "ADD_MESSAGE",
        message: { role: "user", content: text, timestamp: Date.now() } as AgentMessage,
      });
      dispatch({ type: "SET_AGENT_STATUS", agentStatus: "streaming" });
    },
    [state.currentSessionId, send, dispatch],
  );

  const abort = useCallback(() => {
    if (state.currentSessionId) {
      send({ type: "abort", sessionId: state.currentSessionId });
    }
  }, [state.currentSessionId, send]);

  const messages = useMemo(
    () =>
      state.messages.filter((m) => {
        // Skip empty assistant messages (e.g., abandoned partial responses from steer interrupts).
        if (m.role !== "assistant") return true;
        const content = m.content as string | unknown[];
        if (typeof content === "string") return content.length > 0;
        if (Array.isArray(content)) {
          return content.some(
            (block) =>
              typeof block === "object" &&
              block !== null &&
              "type" in block &&
              ((block as { type: string }).type === "toolCall" ||
                ((block as { type: string }).type === "text" &&
                  (block as { text?: string }).text?.length)),
          );
        }
        return true;
      }),
    [state.messages],
  );

  return {
    messages,
    agentStatus: state.agentStatus,
    thinking: state.thinking,
    completedThinking: state.completedThinking,
    toolStates: state.toolStates,
    costs: state.costs,
    error: state.error,
    sendMessage,
    steerMessage,
    abort,
  };
}
