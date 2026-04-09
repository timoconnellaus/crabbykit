import { Link } from "@tanstack/react-router";
import { layoutStyles } from "../styles/layout";
import type { AgentRecord } from "./agent-picker";
import { AgentPicker } from "./agent-picker";

const TABS = [
  { id: "chat", label: "Chat" },
  { id: "apps", label: "Apps" },
  { id: "schedules", label: "Schedules" },
  { id: "skills", label: "Skills" },
] as const;

export function TabBar({
  agentId,
  activeTab,
  agents,
  onCreateAgent,
}: {
  agentId: string;
  activeTab: string;
  agents: AgentRecord[];
  onCreateAgent: () => void;
}) {
  return (
    <>
      <style>{layoutStyles}</style>
      <div data-agent-ui="header-bar">
        <div data-agent-ui="header-bar-tabs">
          {TABS.map((tab) => (
            <Link
              key={tab.id}
              to={`/$agentId/${tab.id}`}
              params={{ agentId }}
              data-agent-ui="tab-item"
              data-active={tab.id === activeTab || undefined}
              style={{ textDecoration: "none", color: "inherit" }}
            >
              {tab.label}
            </Link>
          ))}
        </div>
        <AgentPicker agents={agents} selectedId={agentId} onCreateAgent={onCreateAgent} />
      </div>
    </>
  );
}
