import type { UseAgentChatReturn } from "@claw-for-cloudflare/agent-runtime/client";
import type { ConsoleLogEntry, SandboxBadgeProps } from "@claw-for-cloudflare/agent-ui";
import {
  AppPreview,
  ChatInput,
  ChatPanel,
  MessageList,
  SessionList,
  StatusBar,
  SystemPromptPanel,
  ThinkingIndicator,
} from "@claw-for-cloudflare/agent-ui";
import { useState } from "react";
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
  const [promptOpen, setPromptOpen] = useState(false);

  return (
    <ChatPanel chat={chat} style={{ flexDirection: "row", flex: 1 }}>
      <div data-agent-ui="sidebar">
        <SessionList />
      </div>
      <div
        style={{ display: "flex", flex: 1, minWidth: 0, overflow: "hidden", position: "relative" }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: previewState.open ? 3 : 1,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          <StatusBar sandboxState={sandboxState}>
            <button
              type="button"
              data-agent-ui="system-prompt-button"
              data-active={promptOpen || undefined}
              onClick={() => setPromptOpen((v) => !v)}
              title="View system prompt"
            >
              <svg
                aria-hidden="true"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
              prompt
            </button>
          </StatusBar>
          <MessageList />
          <ThinkingIndicator />
          <PendingTasksBanner tasks={pendingTasks} />
          <ChatInput />
        </div>
        <SystemPromptPanel open={promptOpen} onClose={() => setPromptOpen(false)} />
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
              connected={chat.connectionStatus === "connected"}
            />
          </div>
        )}
      </div>
    </ChatPanel>
  );
}
