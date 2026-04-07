import {
  AppPreview,
  BrowserPanel,
  ChatInput,
  ChatPanel,
  MessageList,
  QueuedMessages,
  SessionList,
  StatusBar,
  SubagentList,
  SystemPromptPanel,
  TaskBreadcrumb,
  TaskList,
  ThinkingIndicator,
} from "@claw-for-cloudflare/agent-ui";
import { useState } from "react";
import { useChatContext } from "../context/chat-context";
import { PendingTasksBanner } from "./pending-tasks";

export function ChatView() {
  const {
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
    taskTree,
    displayTasks,
    overflowCount,
    activeTaskId,
    onTaskClick,
    subagents,
    browserState,
    onCloseBrowser,
  } = useChatContext();

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
            flex: previewState.open || browserState?.open ? 3 : 1,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          <TaskBreadcrumb tree={taskTree ?? null} activeTaskId={activeTaskId} />
          <StatusBar sandboxState={sandboxState} browserState={browserState}>
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
          <QueuedMessages />
          <ThinkingIndicator />
          {subagents && subagents.length > 0 && <SubagentList subagents={subagents} />}
          <PendingTasksBanner tasks={pendingTasks} />
          <TaskList
            tasks={displayTasks}
            overflowCount={overflowCount}
            activeTaskId={activeTaskId}
            onTaskClick={onTaskClick}
          />
          <ChatInput />
        </div>
        <SystemPromptPanel open={promptOpen} onClose={() => setPromptOpen(false)} />
        {previewState.open && (
          <div style={{ flex: 7, minWidth: 0 }}>
            <AppPreview
              previewUrl={previewState.previewBasePath || `/api/preview/${agentId}/`}
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
        {browserState?.open && browserState.debuggerFullscreenUrl && (
          <div style={{ flex: 7, minWidth: 0 }}>
            <BrowserPanel
              debuggerFullscreenUrl={browserState.debuggerFullscreenUrl}
              pageUrl={browserState.pageUrl}
              onClose={onCloseBrowser}
              connected={chat.connectionStatus === "connected"}
            />
          </div>
        )}
      </div>
    </ChatPanel>
  );
}
