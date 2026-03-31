import type { UseAgentChatReturn } from "@claw-for-cloudflare/agent-runtime/client";
import type { ConsoleLogEntry, SandboxBadgeProps } from "@claw-for-cloudflare/agent-ui";
import {
  AppPreview,
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
  previewState,
  agentId,
  consoleLogs,
  onClearLogs,
  onClosePreview,
  logFilter,
  onLogFilterChange,
}: {
  chat: UseAgentChatReturn;
  sandboxState: SandboxBadgeProps;
  pendingTasks: PendingA2ATask[];
  previewState: { open: boolean; port?: number; previewBasePath?: string };
  agentId: string;
  consoleLogs: ConsoleLogEntry[];
  onClearLogs: () => void;
  onClosePreview: () => void;
  logFilter: "all" | "error" | "warn" | "info" | "log";
  onLogFilterChange: (filter: "all" | "error" | "warn" | "info" | "log") => void;
}) {
  return (
    <ChatPanel chat={chat} style={{ flexDirection: "row", flex: 1 }}>
      <div data-agent-ui="sidebar">
        <SessionList />
      </div>
      <div style={{ display: "flex", flex: 1, minWidth: 0, overflow: "hidden" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: previewState.open ? 3 : 1,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          <StatusBar sandboxState={sandboxState} />
          <MessageList />
          <ThinkingIndicator />
          <PendingTasksBanner tasks={pendingTasks} />
          <ChatInput />
        </div>
        {previewState.open && (
          <div style={{ flex: 7, minWidth: 0 }}>
            <AppPreview
              previewUrl={previewState.previewBasePath || `/preview/${agentId}/`}
              logs={consoleLogs}
              onClearLogs={onClearLogs}
              onClose={onClosePreview}
              logFilter={logFilter}
              onLogFilterChange={(f) =>
                onLogFilterChange(f as "all" | "error" | "warn" | "info" | "log")
              }
            />
          </div>
        )}
      </div>
    </ChatPanel>
  );
}
