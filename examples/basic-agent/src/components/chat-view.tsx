import type { UseAgentChatReturn } from "@claw-for-cloudflare/agent-runtime/client";
import type { SandboxBadgeProps } from "@claw-for-cloudflare/agent-ui";
import {
  ChatInput,
  ChatPanel,
  MessageList,
  SessionList,
  StatusBar,
  ThinkingIndicator,
} from "@claw-for-cloudflare/agent-ui";
import type { PendingA2ATask } from "./pending-tasks";
import { PendingTasksBanner } from "./pending-tasks";

export function ChatView({
  chat,
  sandboxState,
  pendingTasks,
}: {
  chat: UseAgentChatReturn;
  sandboxState: SandboxBadgeProps;
  pendingTasks: PendingA2ATask[];
}) {
  return (
    <ChatPanel chat={chat} style={{ flexDirection: "row", flex: 1 }}>
      <div data-agent-ui="sidebar">
        <SessionList />
      </div>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        <StatusBar sandboxState={sandboxState} />
        <MessageList />
        <ThinkingIndicator />
        <PendingTasksBanner tasks={pendingTasks} />
        <ChatInput />
      </div>
    </ChatPanel>
  );
}
