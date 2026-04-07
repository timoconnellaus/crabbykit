import { Link } from "@tanstack/react-router";
import { layoutStyles } from "../styles/layout";

const TABS = [
  { id: "chat", label: "Chat" },
  { id: "apps", label: "Apps" },
  { id: "schedules", label: "Schedules" },
  { id: "skills", label: "Skills" },
] as const;

export function TabBar({
  agentId,
  activeTab,
}: {
  agentId: string;
  activeTab: string;
}) {
  return (
    <>
      <style>{layoutStyles}</style>
      <div data-agent-ui="tab-bar">
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
    </>
  );
}
