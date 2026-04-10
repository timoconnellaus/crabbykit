import { useChatSession } from "@claw-for-cloudflare/agent-runtime/client";

export function ThinkingIndicator() {
  const { agentStatus } = useChatSession();
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
