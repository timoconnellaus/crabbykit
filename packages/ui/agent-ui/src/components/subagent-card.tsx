export interface SubagentInfo {
  subagentId: string;
  profileId: string;
  childSessionId: string;
  state: "running" | "completed" | "failed" | "canceled";
  prompt: string;
  taskId?: string;
  /** Latest streaming text from the subagent. */
  latestText?: string;
  /** Breadcrumb path (e.g., ["Epic", "Task", "Subtask"]). */
  breadcrumb?: string[];
}

export interface SubagentCardProps {
  subagent: SubagentInfo;
  /** Called when the card is clicked (e.g., to navigate to child session). */
  onClick?: (subagentId: string) => void;
}

const STATE_INDICATORS: Record<string, { icon: string; label: string }> = {
  running: { icon: "⟳", label: "Running" },
  completed: { icon: "✓", label: "Completed" },
  failed: { icon: "✗", label: "Failed" },
  canceled: { icon: "—", label: "Canceled" },
};

export function SubagentCard({ subagent, onClick }: SubagentCardProps) {
  const indicator = STATE_INDICATORS[subagent.state] ?? STATE_INDICATORS.running;

  return (
    // biome-ignore lint/a11y/useSemanticElements: div needed for card layout
    <div
      data-agent-ui="subagent-card"
      data-state={subagent.state}
      onClick={() => onClick?.(subagent.subagentId)}
      onKeyDown={(e) => e.key === "Enter" && onClick?.(subagent.subagentId)}
      role="button"
      tabIndex={0}
    >
      <div data-agent-ui="subagent-card-header">
        <span data-agent-ui="subagent-card-indicator">{indicator.icon}</span>
        <span data-agent-ui="subagent-card-profile">{subagent.profileId}</span>
        <span data-agent-ui="subagent-card-state">{indicator.label}</span>
      </div>
      {subagent.breadcrumb && subagent.breadcrumb.length > 0 && (
        <div data-agent-ui="subagent-card-breadcrumb">{subagent.breadcrumb.join(" › ")}</div>
      )}
      {subagent.latestText && subagent.state === "running" && (
        <div data-agent-ui="subagent-card-stream">{subagent.latestText}</div>
      )}
      {subagent.state !== "running" && subagent.latestText && (
        <div data-agent-ui="subagent-card-result">
          {subagent.latestText.slice(0, 200)}
          {subagent.latestText.length > 200 ? "…" : ""}
        </div>
      )}
    </div>
  );
}

export interface SubagentListProps {
  subagents: SubagentInfo[];
  onClick?: (subagentId: string) => void;
}

/**
 * Renders a list of subagent cards. Shows nothing when empty.
 */
export function SubagentList({ subagents, onClick }: SubagentListProps) {
  if (subagents.length === 0) return null;

  return (
    <div data-agent-ui="subagent-list">
      {subagents.map((sub) => (
        <SubagentCard key={sub.subagentId} subagent={sub} onClick={onClick} />
      ))}
    </div>
  );
}
