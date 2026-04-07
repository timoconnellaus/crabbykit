import { Link } from "@tanstack/react-router";
import { agentRailStyles } from "../styles/agent-rail";

export interface AgentRecord {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

export function AgentRail({
  agents,
  selectedId,
  onCreateAgent,
}: {
  agents: AgentRecord[];
  selectedId: string | null;
  onCreateAgent: () => void;
}) {
  return (
    <>
      <style>{agentRailStyles}</style>
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
            <Link
              key={a.id}
              to="/$agentId/$sessionId/chat"
              params={{ agentId: a.id, sessionId: "latest" }}
              data-agent-ui="agent-rail-item"
              data-active={a.id === selectedId || undefined}
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <span data-agent-ui="agent-rail-dot" />
              <span data-agent-ui="agent-rail-name">{a.name}</span>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
