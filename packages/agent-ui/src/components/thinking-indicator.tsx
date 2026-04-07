import { useChat } from "./chat-provider";

export function ThinkingIndicator() {
  const { agentStatus } = useChat();
  const active = agentStatus !== "idle";
  return (
    <div data-agent-ui="thinking" data-active={active || undefined}>
      {active && (
        <>
          <span data-agent-ui="thinking-indicator" />
          Thinking...
        </>
      )}
    </div>
  );
}
