import { layoutStyles } from "../styles/layout";

export interface Tab {
  id: string;
  label: string;
}

export function TabBar({
  tabs,
  activeTab,
  onTabChange,
}: {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tab: string) => void;
}) {
  return (
    <>
      <style>{layoutStyles}</style>
      <div data-agent-ui="tab-bar">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            data-agent-ui="tab-item"
            data-active={tab.id === activeTab || undefined}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </>
  );
}
