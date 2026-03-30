import { useAgentChat } from "@claw-for-cloudflare/agent-runtime/client";
import type { ConsoleLogEntry, SandboxBadgeProps } from "@claw-for-cloudflare/agent-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentRecord } from "./components/agent-rail";
import { AgentRail } from "./components/agent-rail";
import { ChatView } from "./components/chat-view";
import type { PendingA2ATask } from "./components/pending-tasks";
import { SchedulePanel } from "./components/schedule-panel";
import { TabBar } from "./components/tab-bar";

const TABS = [
  { id: "chat", label: "Chat" },
  { id: "schedules", label: "Schedules" },
] as const;

export default function App() {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("chat");
  const [sandboxState, setSandboxState] = useState<SandboxBadgeProps>({ elevated: false });
  const [pendingTasks, setPendingTasks] = useState<PendingA2ATask[]>([]);
  const [previewState, setPreviewState] = useState<{ open: boolean; port?: number }>({
    open: false,
  });
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLogEntry[]>([]);
  const [logFilter, setLogFilter] = useState<"all" | "error" | "warn" | "info" | "log">("all");

  const MAX_CONSOLE_LOGS = 1000;

  // Reset tab when switching agents
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedAgentId is the intentional trigger
  useEffect(() => {
    setActiveTab("chat");
  }, [selectedAgentId]);

  // Fetch agent list from registry
  const fetchAgents = useCallback(async () => {
    let list = (await (await fetch("/agents")).json()) as AgentRecord[];
    if (list.length === 0) {
      const res = await fetch("/agents", {
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
    fetchAgents().then((list) => {
      if (!selectedAgentId && list.length > 0) {
        setSelectedAgentId(list[0].id);
      }
    });
    const interval = setInterval(fetchAgents, 5000);
    return () => clearInterval(interval);
  }, [fetchAgents, selectedAgentId]);

  const onCustomEvent = useCallback((name: string, data: Record<string, unknown>) => {
    if (name === "sandbox_elevation") {
      setSandboxState((prev) => ({ ...prev, elevated: data.elevated as boolean }));
    }
    if (name === "sandbox_timeout") {
      setSandboxState((prev) => ({
        ...prev,
        expiresAt: data.expiresAt as number,
        timeoutSeconds: data.timeoutSeconds as number,
      }));
    }
    if (name === "preview_open") {
      setPreviewState({ open: true, port: data.port as number });
      setConsoleLogs([]);
    }
    if (name === "preview_close") {
      setPreviewState({ open: false });
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
  }, []);

  // Ref for console logs so the onCustomRequest handler always reads latest
  const consoleLogsRef = useRef(consoleLogs);
  consoleLogsRef.current = consoleLogs;

  const onCustomRequest = useCallback(
    (name: string, data: Record<string, unknown>): Record<string, unknown> => {
      if (name === "get_console_logs") {
        const level = data.level as string;
        const logs = consoleLogsRef.current;
        const filtered = level === "all" ? logs : logs.filter((l) => l.level === level);
        return { logs: filtered };
      }
      // biome-ignore lint/style/useNamingConvention: _error is a protocol convention for error responses
      return { _error: true, message: `Unknown request: ${name}` };
    },
    [],
  );

  // Listen for console messages from the preview iframe
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "claw:console") {
        const entry: ConsoleLogEntry = {
          level: event.data.level,
          text: event.data.text,
          ts: event.data.ts,
        };
        setConsoleLogs((prev) => {
          const next = [...prev, entry];
          return next.length > MAX_CONSOLE_LOGS ? next.slice(-MAX_CONSOLE_LOGS) : next;
        });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const chat = useAgentChat({
    url: selectedAgentId ? `${wsProtocol}//${window.location.host}/agent/${selectedAgentId}` : "",
    onCustomEvent,
    onCustomRequest,
  });

  const handleCreateAgent = useCallback(async () => {
    const name = prompt("Agent name:");
    if (!name) return;
    const res = await fetch("/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const agent = (await res.json()) as AgentRecord;
    setAgents((prev) => [...prev, agent]);
    setSelectedAgentId(agent.id);
  }, []);

  return (
    <div style={{ display: "flex", height: "100vh", width: "100vw" }}>
      <AgentRail
        agents={agents}
        selectedId={selectedAgentId}
        onSelect={setSelectedAgentId}
        onCreateAgent={handleCreateAgent}
      />
      {selectedAgentId ? (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          <TabBar tabs={[...TABS]} activeTab={activeTab} onTabChange={setActiveTab} />
          {/* Chat stays mounted (hidden) to keep WebSocket alive */}
          <div style={{ display: activeTab === "chat" ? "flex" : "none", flex: 1, minWidth: 0, overflow: "hidden" }}>
            <ChatView
              chat={chat}
              sandboxState={sandboxState}
              pendingTasks={pendingTasks}
              previewState={previewState}
              agentId={selectedAgentId}
              consoleLogs={consoleLogs}
              onClearLogs={() => setConsoleLogs([])}
              logFilter={logFilter}
              onLogFilterChange={(f) => setLogFilter(f as "all" | "error" | "warn" | "info" | "log")}
            />
          </div>
          {activeTab === "schedules" && (
            <SchedulePanel
              agentId={selectedAgentId}
              schedules={chat.schedules}
              toggleSchedule={chat.toggleSchedule}
            />
          )}
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--agent-ui-text-muted)",
            fontFamily: "SF Mono, Fira Code, JetBrains Mono, ui-monospace, monospace",
            fontSize: "0.8rem",
          }}
        >
          Select an agent to start
        </div>
      )}
    </div>
  );
}
