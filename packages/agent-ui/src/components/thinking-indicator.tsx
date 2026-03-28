import { useChat } from "./chat-provider";

export function ThinkingIndicator() {
  const { agentStatus } = useChat();
  if (agentStatus === "idle") return null;
  return (
    <div data-agent-ui="thinking">
      <span data-agent-ui="thinking-indicator" />
      Thinking...
    </div>
  );
}
