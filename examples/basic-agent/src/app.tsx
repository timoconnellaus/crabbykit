import { useAgentChat } from "@claw-for-cloudflare/agent-runtime/client";
import type { ConsoleLogEntry, SandboxBadgeProps } from "@claw-for-cloudflare/agent-ui";
import {
  AppPreview,
  ChatInput,
  ChatPanel,
  MessageList,
  SessionList,
  StatusBar,
  ThinkingIndicator,
  useChat,
} from "@claw-for-cloudflare/agent-ui";
import { useCallback, useEffect, useRef, useState } from "react";

interface AgentRecord {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

interface PendingA2ATask {
  taskId: string;
  targetAgent: string;
  targetAgentName: string;
  state: string;
  originalRequest: string;
}

// --- Agent List Sidebar ---

const agentListStyles = `
[data-agent-ui="agent-rail"] {
  display: flex;
  flex-direction: column;
  width: 200px;
  min-width: 200px;
  background: color-mix(in srgb, var(--agent-ui-bg) 100%, black 0%);
  border-right: 1px solid var(--agent-ui-border);
  font-family: "SF Mono", "Fira Code", "JetBrains Mono", ui-monospace, monospace;
  font-size: 0.75rem;
  overflow-y: auto;
}

[data-agent-ui="agent-rail-header"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 0.75rem 0.5rem;
  color: var(--agent-ui-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.625rem;
  font-weight: 600;
  user-select: none;
}

[data-agent-ui="agent-rail-add"] {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--agent-ui-border);
  border-radius: 4px;
  background: transparent;
  color: var(--agent-ui-text-muted);
  cursor: pointer;
  font-size: 0.875rem;
  line-height: 1;
  transition: all 0.15s ease;
}
[data-agent-ui="agent-rail-add"]:hover {
  background: var(--agent-ui-bg-surface);
  color: var(--agent-ui-text);
  border-color: var(--agent-ui-text-muted);
}

[data-agent-ui="agent-rail-list"] {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 0.375rem 0.5rem;
}

[data-agent-ui="agent-rail-item"] {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.5rem;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--agent-ui-text-dim);
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition: all 0.12s ease;
  position: relative;
}
[data-agent-ui="agent-rail-item"]:hover {
  background: var(--agent-ui-bg-surface);
  color: var(--agent-ui-text);
}
[data-agent-ui="agent-rail-item"][data-active] {
  background: var(--agent-ui-primary-highlight);
  color: var(--agent-ui-primary);
}

[data-agent-ui="agent-rail-dot"] {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--agent-ui-text-muted);
  flex-shrink: 0;
  opacity: 0.5;
}
[data-agent-ui="agent-rail-item"][data-active] [data-agent-ui="agent-rail-dot"] {
  background: var(--agent-ui-primary);
  opacity: 1;
  box-shadow: 0 0 6px var(--agent-ui-primary-focus-ring);
}

[data-agent-ui="agent-rail-name"] {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

[data-agent-ui="agent-rail-empty"] {
  padding: 1rem 0.75rem;
  color: var(--agent-ui-text-muted);
  font-style: italic;
  text-align: center;
}
`;

function AgentRail({
  agents,
  selectedId,
  onSelect,
  onCreateAgent,
}: {
  agents: AgentRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreateAgent: () => void;
}) {
  return (
    <div data-agent-ui="agent-rail">
      <div data-agent-ui="agent-rail-header">
        <span>agents</span>
        <button
          type="button"
          data-agent-ui="agent-rail-add"
          onClick={onCreateAgent}
          title="Create agent"
        >
          +
        </button>
      </div>
      <div data-agent-ui="agent-rail-list">
        {agents.length === 0 && <div data-agent-ui="agent-rail-empty">No agents</div>}
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            data-agent-ui="agent-rail-item"
            data-active={a.id === selectedId || undefined}
            onClick={() => onSelect(a.id)}
          >
            <span data-agent-ui="agent-rail-dot" />
            <span data-agent-ui="agent-rail-name">{a.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// --- Schedule Panel ---

function SchedulePanel() {
  const { schedules, toggleSchedule } = useChat();

  if (schedules.length === 0) return null;

  return (
    <div data-agent-ui="schedule-list">
      <div data-agent-ui="schedule-heading">Schedules</div>
      {schedules.map((s) => (
        <div
          key={s.id}
          data-agent-ui="schedule-item"
          data-status={s.status}
          style={{ position: "relative" }}
        >
          <button
            type="button"
            role="switch"
            aria-checked={s.enabled}
            onClick={() => toggleSchedule(s.id, !s.enabled)}
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              width: 36,
              height: 20,
              borderRadius: 10,
              border: "none",
              cursor: "pointer",
              background: s.enabled ? "#4ade80" : "#555",
              transition: "background 0.2s",
              padding: 0,
            }}
          >
            <span
              style={{
                display: "block",
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: "#fff",
                transition: "transform 0.2s",
                transform: s.enabled ? "translateX(18px)" : "translateX(2px)",
              }}
            />
          </button>
          <div data-agent-ui="schedule-name">{s.name}</div>
          <div data-agent-ui="schedule-meta">
            {!s.enabled ? "disabled" : s.status === "idle" ? "active" : s.status}
            {s.nextFireAt &&
              s.enabled &&
              ` \u00B7 next ${new Date(s.nextFireAt).toLocaleTimeString()}`}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- Pending A2A Tasks Banner ---

const pendingTasksStyles = `
[data-agent-ui="pending-tasks-banner"] {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  margin: 0 0.75rem;
  background: color-mix(in srgb, var(--agent-ui-primary) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--agent-ui-primary) 20%, transparent);
  border-radius: 6px;
  font-family: "SF Mono", "Fira Code", "JetBrains Mono", ui-monospace, monospace;
  font-size: 0.6875rem;
  color: var(--agent-ui-text-dim);
  letter-spacing: 0.01em;
}

[data-agent-ui="pending-tasks-dot"] {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--agent-ui-primary);
  animation: a2a-pulse 2s ease-in-out infinite;
  flex-shrink: 0;
}

@keyframes a2a-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

[data-agent-ui="pending-tasks-label"] {
  color: var(--agent-ui-text-muted);
}

[data-agent-ui="pending-tasks-names"] {
  color: var(--agent-ui-text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
`;

function PendingTasksBanner({ tasks }: { tasks: PendingA2ATask[] }) {
  if (tasks.length === 0) return null;

  const names = tasks.map((t) => t.targetAgentName || t.targetAgent);
  const label = tasks.length === 1 ? `1 task pending` : `${tasks.length} tasks pending`;

  return (
    <div data-agent-ui="pending-tasks-banner">
      <span data-agent-ui="pending-tasks-dot" />
      <span data-agent-ui="pending-tasks-label">{label}</span>
      <span data-agent-ui="pending-tasks-names">{names.join(", ")}</span>
    </div>
  );
}

// --- App Root ---

export default function App() {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [sandboxState, setSandboxState] = useState<SandboxBadgeProps>({
    elevated: false,
  });
  const [pendingTasks, setPendingTasks] = useState<PendingA2ATask[]>([]);
  const [previewState, setPreviewState] = useState<{ open: boolean; port?: number }>({
    open: false,
  });
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLogEntry[]>([]);
  const [logFilter, setLogFilter] = useState<"all" | "error" | "warn" | "info" | "log">("all");

  const MAX_CONSOLE_LOGS = 1000;

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

  // Bootstrap on mount + poll for changes (agents can be created by tools)
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
      setSandboxState((prev) => ({
        ...prev,
        elevated: data.elevated as boolean,
      }));
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
        // Update existing or add new
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
    <>
      <style>{agentListStyles}</style>
      <style>{pendingTasksStyles}</style>
      <div style={{ display: "flex", height: "100vh", width: "100vw" }}>
        <AgentRail
          agents={agents}
          selectedId={selectedAgentId}
          onSelect={setSelectedAgentId}
          onCreateAgent={handleCreateAgent}
        />
        {selectedAgentId ? (
          <ChatPanel chat={chat} style={{ flexDirection: "row", flex: 1 }}>
            <div data-agent-ui="sidebar">
              <SessionList />
              <SchedulePanel />
            </div>
            <div style={{ display: "flex", flex: 1, minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  flex: previewState.open ? 3 : 1,
                  minWidth: 0,
                }}
              >
                <StatusBar sandboxState={sandboxState} />
                <MessageList />
                <ThinkingIndicator />
                <PendingTasksBanner tasks={pendingTasks} />
                <ChatInput />
              </div>
              {previewState.open && selectedAgentId && (
                <div style={{ flex: 7, minWidth: 0 }}>
                  <AppPreview
                    previewUrl={`/preview/${selectedAgentId}/`}
                    logs={consoleLogs}
                    onClearLogs={() => setConsoleLogs([])}
                    logFilter={logFilter}
                    onLogFilterChange={(f) =>
                      setLogFilter(f as "all" | "error" | "warn" | "info" | "log")
                    }
                  />
                </div>
              )}
            </div>
          </ChatPanel>
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
    </>
  );
}
