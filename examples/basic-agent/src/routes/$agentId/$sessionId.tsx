import { useAgentChat } from "@claw-for-cloudflare/agent-runtime/client";
import type { SandboxBadgeProps, SubagentInfo } from "@claw-for-cloudflare/agent-ui";
import { useBrowser, usePreview, useTaskState } from "@claw-for-cloudflare/agent-ui";
import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRecord } from "../../components/agent-rail";
import { AgentRail } from "../../components/agent-rail";
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
  const navigate = useNavigate();
  const routerState = useRouterState();

  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [sandboxState, setSandboxState] = useState<SandboxBadgeProps>({ elevated: false });
  const [pendingTasks, setPendingTasks] = useState<PendingA2ATask[]>([]);
  const [deployedApps, setDeployedApps] = useState<AppSummary[]>([]);
  const taskState = useTaskState({ maxVisible: 5 });
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>();
  const [subagents, setSubagents] = useState<SubagentInfo[]>([]);

  const preview = usePreview();
  const browser = useBrowser();

  // Detect which tab is active from the URL
  const activeTab = useMemo(() => {
    const pathname = routerState.location.pathname;
    if (pathname.endsWith("/apps")) return "apps";
    if (pathname.endsWith("/schedules")) return "schedules";
    if (pathname.endsWith("/skills")) return "skills";
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

  const onTaskEvent = taskState.handleTaskEvent;

  const onSubagentEvent = useCallback(
    (event: {
      subagentId: string;
      profileId: string;
      childSessionId: string;
      taskId?: string;
      event: unknown;
    }) => {
      setSubagents((prev) => {
        const existing = prev.find((s) => s.subagentId === event.subagentId);
        const agentEvent = event.event as { type: string; message?: { content?: string } };

        if (!existing) {
          return [
            ...prev,
            {
              subagentId: event.subagentId,
              profileId: event.profileId,
              childSessionId: event.childSessionId,
              state: "running",
              prompt: "",
              taskId: event.taskId,
            },
          ];
        }

        if (agentEvent.type === "agent_end") {
          return prev.map((s) =>
            s.subagentId === event.subagentId ? { ...s, state: "completed" as const } : s,
          );
        }

        if (agentEvent.type === "message_update" && agentEvent.message?.content) {
          const text =
            typeof agentEvent.message.content === "string" ? agentEvent.message.content : "";
          return prev.map((s) =>
            s.subagentId === event.subagentId ? { ...s, latestText: text } : s,
          );
        }

        return prev;
      });
    },
    [],
  );

  // Build WebSocket URL — only on the client
  const wsUrl =
    typeof window !== "undefined"
      ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/agent/${agentId}`
      : "";

  const chat = useAgentChat({
    url: wsUrl,
    sessionId: sessionId === "latest" ? undefined : sessionId,
    onCustomEvent,
    onCustomRequest,
    onTaskEvent,
    onSubagentEvent,
  });

  // Reset task state when session changes (e.g. /clear creates a new session)
  useEffect(() => {
    taskState.reset();
  }, [chat.currentSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync URL when server assigns/changes session
  useEffect(() => {
    if (chat.currentSessionId && chat.currentSessionId !== sessionId) {
      navigate({
        to: `/$agentId/$sessionId/${activeTab}`,
        params: { agentId, sessionId: chat.currentSessionId },
        replace: sessionId === "latest",
      });
    }
  }, [chat.currentSessionId, sessionId, agentId, activeTab, navigate]);

  const handleClosePreview = useCallback(() => {
    preview.closePreview();
    chat.sendCommand("close_preview");
  }, [preview, chat]);

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
      chat,
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
      chat,
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
      <AgentRail agents={agents} selectedId={agentId} onCreateAgent={handleCreateAgent} />
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        <TabBar agentId={agentId} sessionId={sessionId} activeTab={activeTab} />
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
    </ChatContextProvider>
  );
}
