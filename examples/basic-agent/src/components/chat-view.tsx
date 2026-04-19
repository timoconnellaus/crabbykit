import { useAgentConnection } from "@crabbykit/agent-runtime/client";
import {
  AppPreview,
  BrowserPanel,
  ChatInput,
  MessageList,
  QueuedMessages,
  SessionList,
  StatusBar,
  SubagentList,
  SystemPromptPanel,
  TaskBreadcrumb,
  TaskList,
  ThinkingIndicator,
} from "@crabbykit/agent-ui";
import { useState } from "react";
import { useChatContext } from "../context/chat-context";
import { PendingTasksBanner } from "./pending-tasks";

export function ChatView() {
  const {
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
  const { connectionStatus } = useAgentConnection();

  const [promptOpen, setPromptOpen] = useState(false);

  return (
    <div data-agent-ui="chat-panel" style={{ flexDirection: "row", flex: 1, display: "flex" }}>
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
            <DisableBundleButton agentId={agentId} />
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
              connected={connectionStatus === "connected"}
            />
          </div>
        )}
        {browserState?.open && browserState.debuggerFullscreenUrl && (
          <div style={{ flex: 7, minWidth: 0 }}>
            <BrowserPanel
              debuggerFullscreenUrl={browserState.debuggerFullscreenUrl}
              pageUrl={browserState.pageUrl}
              onClose={onCloseBrowser}
              connected={connectionStatus === "connected"}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Out-of-band escape hatch button. Disables any active bundle brain on the
 * agent so the static brain takes over for the next turn. POSTs to the
 * runtime's `/bundle/disable` HTTP endpoint via the worker's agent proxy
 * route (`/api/agent/:agentId/bundle/disable`). Always visible — the whole
 * point is that you need a way out when the bundle is intercepting every
 * prompt and you can't ask the agent to disable itself.
 */
function DisableBundleButton({ agentId }: { agentId: string }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "ok" | "err">("idle");

  const onClick = async () => {
    if (busy) return;
    if (
      !window.confirm(
        "Disable the active bundle brain on this agent and revert to the static brain? This cannot be undone (you'll need to redeploy to use it again).",
      )
    ) {
      return;
    }
    setBusy(true);
    setStatus("idle");
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(agentId)}/bundle/disable`, {
        method: "POST",
      });
      setStatus(res.ok ? "ok" : "err");
      if (!res.ok) {
        console.error("[DisableBundleButton] disable failed", res.status, await res.text());
      }
    } catch (err) {
      console.error("[DisableBundleButton] disable threw", err);
      setStatus("err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      data-agent-ui="disable-bundle-button"
      data-status={status === "idle" ? undefined : status}
      onClick={onClick}
      disabled={busy}
      title="Disable the active bundle brain (revert to static brain)"
      style={{ marginLeft: 8 }}
    >
      {busy ? "disabling…" : status === "ok" ? "bundle off" : "disable bundle"}
    </button>
  );
}
