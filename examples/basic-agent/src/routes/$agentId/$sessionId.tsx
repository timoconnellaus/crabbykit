import {
  AgentConnectionProvider,
  useAgentConnection,
} from "@claw-for-cloudflare/agent-runtime/client";
import type { SandboxBadgeProps, SubagentInfo } from "@claw-for-cloudflare/agent-ui";
import { useBrowser, usePreview, useTaskState } from "@claw-for-cloudflare/agent-ui";
import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRecord } from "../../components/agent-picker";
import { ChatView } from "../../components/chat-view";
import type { PendingA2ATask } from "../../components/pending-tasks";
import { TabBar } from "../../components/tab-bar";
import type { AppSummary } from "../../context/chat-context";
import { ChatContextProvider } from "../../context/chat-context";

export const Route = createFileRoute("/$agentId/$sessionId")({
  ssr: false,
  component: SessionLayout,
});

function SessionLayout() {
  const { agentId, sessionId } = Route.useParams();

  // Build WebSocket URL — only on the client
  const wsUrl =
    typeof window !== "undefined"
      ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/agent/${agentId}`
      : "";

  // Shared UI state lives here (outside the provider) so that onCustomEvent
  // callbacks can mutate it. The provider forwards custom events to these
  // callbacks; we pass the setters through via closures.
  const [sandboxState, setSandboxState] = useState<SandboxBadgeProps>({ elevated: false });
  const [pendingTasks, setPendingTasks] = useState<PendingA2ATask[]>([]);
  const [deployedApps, setDeployedApps] = useState<AppSummary[]>([]);

  const preview = usePreview();
  const browser = useBrowser();

  const onCustomEvent = useCallback(
    (name: string, data: Record<string, unknown>) => {
      // Let the preview/browser hooks handle their events first
      if (preview.handleCustomEvent(name, data)) return;
      if (browser.handleCustomEvent(name, data)) return;

      if (name === "app_list") {
        const apps = data.apps as AppSummary[];
        setDeployedApps(apps);
        return;
      }

      if (name === "sandbox_elevation") {
        setSandboxState((prev) => ({ ...prev, elevated: data.elevated as boolean }));
        if (!data.elevated) {
          preview.closePreview();
        }
      }
      if (name === "sandbox_timeout") {
        setSandboxState((prev) => ({
          ...prev,
          expiresAt: data.expiresAt as number,
          timeoutSeconds: data.timeoutSeconds as number,
        }));
      }
      if (name === "a2a_active_tasks") {
        setPendingTasks(data.tasks as PendingA2ATask[]);
      }
      if (name === "a2a_task_update") {
        const state = data.state as string;
        const taskId = data.taskId as string;
        if (state === "completed" || state === "failed" || state === "canceled") {
          setPendingTasks((prev) => prev.filter((t) => t.taskId !== taskId));
        } else {
          setPendingTasks((prev) => {
            const exists = prev.find((t) => t.taskId === taskId);
            if (exists) {
              return prev.map((t) => (t.taskId === taskId ? { ...t, state } : t));
            }
            return [
              ...prev,
              {
                taskId,
                targetAgent: data.targetAgent as string,
                targetAgentName: data.targetAgentName as string,
                state,
                originalRequest: data.originalRequest as string,
              },
            ];
          });
        }
      }
    },
    [preview, browser],
  );

  const onCustomRequest = useCallback(
    (name: string, data: Record<string, unknown>): Record<string, unknown> => {
      const previewResponse = preview.handleCustomRequest(name, data);
      if (previewResponse) return previewResponse;

      // biome-ignore lint/style/useNamingConvention: _error is a protocol convention for error responses
      return { _error: true, message: `Unknown request: ${name}` };
    },
    [preview],
  );

  return (
    <AgentConnectionProvider
      url={wsUrl}
      sessionId={sessionId === "latest" ? undefined : sessionId}
      onCustomEvent={onCustomEvent}
      onCustomRequest={onCustomRequest}
    >
      <SessionLayoutInner
        agentId={agentId}
        sessionId={sessionId}
        sandboxState={sandboxState}
        pendingTasks={pendingTasks}
        deployedApps={deployedApps}
        preview={preview}
        browser={browser}
      />
    </AgentConnectionProvider>
  );
}

interface SessionLayoutInnerProps {
  agentId: string;
  sessionId: string;
  sandboxState: SandboxBadgeProps;
  pendingTasks: PendingA2ATask[];
  deployedApps: AppSummary[];
  preview: ReturnType<typeof usePreview>;
  browser: ReturnType<typeof useBrowser>;
}

/**
 * Inner component that reads `currentSessionId` from the connection
 * provider (hence rendered inside it). Handles URL sync on session
 * changes and exposes the per-route UI state via `ChatContextProvider`.
 */
function SessionLayoutInner(props: SessionLayoutInnerProps) {
  const { agentId, sessionId, sandboxState, pendingTasks, deployedApps, preview, browser } = props;
  const navigate = useNavigate();
  const routerState = useRouterState();
  const { currentSessionId } = useAgentConnection();

  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const taskState = useTaskState({ maxVisible: 5 });
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>();
  const [subagents] = useState<SubagentInfo[]>([]);

  // Detect which tab is active from the URL
  const activeTab = useMemo(() => {
    const pathname = routerState.location.pathname;
    if (pathname.endsWith("/apps")) return "apps";
    if (pathname.endsWith("/schedules")) return "schedules";
    if (pathname.endsWith("/skills")) return "skills";
    if (pathname.endsWith("/channels")) return "channels";
    return "chat";
  }, [routerState.location.pathname]);

  // Fetch agent list from registry
  const fetchAgents = useCallback(async () => {
    let list = (await (await fetch("/api/agents")).json()) as AgentRecord[];
    if (list.length === 0) {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Default Agent" }),
      });
      const agent = (await res.json()) as AgentRecord;
      list = [agent];
    }
    setAgents(list);
    return list;
  }, []);

  // Bootstrap on mount + poll for changes
  const bootstrapRef = useRef(false);
  useEffect(() => {
    if (bootstrapRef.current) return;
    bootstrapRef.current = true;
    fetchAgents();
    const interval = setInterval(fetchAgents, 5000);
    return () => clearInterval(interval);
  }, [fetchAgents]);

  // Reset task state when session changes (e.g. /clear creates a new session)
  useEffect(() => {
    taskState.reset();
  }, [currentSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync URL when server assigns/changes session
  useEffect(() => {
    if (currentSessionId && currentSessionId !== sessionId) {
      navigate({
        to: `/$agentId/$sessionId/${activeTab}`,
        params: { agentId, sessionId: currentSessionId },
        replace: sessionId === "latest",
      });
    }
  }, [currentSessionId, sessionId, agentId, activeTab, navigate]);

  const handleClosePreview = useCallback(() => {
    preview.closePreview();
  }, [preview]);

  const handleCreateAgent = useCallback(async () => {
    const name = prompt("Agent name:");
    if (!name) return;
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const agent = (await res.json()) as AgentRecord;
    setAgents((prev) => [...prev, agent]);
    navigate({
      to: "/$agentId/$sessionId/chat",
      params: { agentId: agent.id, sessionId: "latest" },
    });
  }, [navigate]);

  const contextValue = useMemo(
    () => ({
      agentId,
      sessionId,
      sandboxState,
      pendingTasks,
      deployedApps,
      previewState: preview.previewState,
      consoleLogs: preview.consoleLogs,
      onClearLogs: preview.clearLogs,
      onClosePreview: handleClosePreview,
      logFilter: preview.logFilter,
      onLogFilterChange: preview.setLogFilter,
      taskTree: taskState.taskTree,
      displayTasks: taskState.displayTasks,
      overflowCount: taskState.overflowCount,
      activeTaskId,
      onTaskClick: setActiveTaskId,
      subagents,
      browserState: browser.browserState,
      onCloseBrowser: browser.closeBrowser,
    }),
    [
      agentId,
      sessionId,
      sandboxState,
      pendingTasks,
      deployedApps,
      preview.previewState,
      preview.consoleLogs,
      preview.clearLogs,
      handleClosePreview,
      preview.logFilter,
      preview.setLogFilter,
      taskState.taskTree,
      taskState.displayTasks,
      taskState.overflowCount,
      activeTaskId,
      subagents,
      browser.browserState,
      browser.closeBrowser,
    ],
  );

  return (
    <ChatContextProvider value={contextValue}>
      <div style={{ display: "flex", flexDirection: "row", flex: 1, minWidth: 0 }}>
        <TabBar
          agentId={agentId}
          activeTab={activeTab}
          agents={agents}
          onCreateAgent={handleCreateAgent}
        />
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          {/* Chat stays mounted (hidden) to keep WebSocket alive */}
          <div
            style={{
              display: activeTab === "chat" ? "flex" : "none",
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
            }}
          >
            <ChatView />
          </div>
          {activeTab !== "chat" && <Outlet />}
        </div>
      </div>
    </ChatContextProvider>
  );
}
