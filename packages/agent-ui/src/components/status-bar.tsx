import type { ComponentPropsWithoutRef } from "react";
import { useChat } from "./chat-provider";

export interface StatusBarProps extends ComponentPropsWithoutRef<"div"> {}

export function StatusBar(props: StatusBarProps) {
  const { connectionStatus, agentStatus, thinking } = useChat();

  return (
    <div
      data-agent-ui="status-bar"
      data-connection={connectionStatus}
      data-agent-status={agentStatus}
      {...props}
    >
      <span data-agent-ui="status-connection">{connectionStatus}</span>

      {agentStatus !== "idle" && (
        <span data-agent-ui="status-agent">{agentStatus.replace("_", " ")}</span>
      )}

      {thinking && (
        <span data-agent-ui="status-thinking">Thinking...</span>
      )}
    </div>
  );
}
