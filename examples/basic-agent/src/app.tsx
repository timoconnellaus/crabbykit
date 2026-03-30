import { useAgentChat } from "@claw-for-cloudflare/agent-runtime/client";
import type { SandboxBadgeProps } from "@claw-for-cloudflare/agent-ui";
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

  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const chat = useAgentChat({
    url: selectedAgentId ? `${wsProtocol}//${window.location.host}/agent/${selectedAgentId}` : "",
    onCustomEvent,
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
          <div style={{ display: activeTab === "chat" ? "flex" : "none", flex: 1, minWidth: 0 }}>
            <ChatView chat={chat} sandboxState={sandboxState} pendingTasks={pendingTasks} />
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
