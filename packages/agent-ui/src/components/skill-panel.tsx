import type { ComponentPropsWithoutRef } from "react";
import { useState } from "react";
import { useChat } from "./chat-provider";
import { SkillViewer } from "./skill-viewer";

export interface SkillPanelProps extends ComponentPropsWithoutRef<"div"> {}

export function SkillPanel(props: SkillPanelProps) {
  const { skills } = useChat();
  const [viewingSkill, setViewingSkill] = useState<string | null>(null);

  if (skills.length === 0) return null;

  return (
    <div data-agent-ui="skill-panel" {...props}>
      <div data-agent-ui="skill-panel-header">Skills</div>
      <div data-agent-ui="skill-list">
        {skills.map((skill) => (
          <div
            key={skill.id}
            data-agent-ui="skill-item"
            data-enabled={skill.enabled || undefined}
            data-stale={skill.stale || undefined}
          >
            <div data-agent-ui="skill-item-info">
              <span data-agent-ui="skill-item-name">{skill.name}</span>
              <span data-agent-ui="skill-item-version">v{skill.version}</span>
              {skill.stale && <span data-agent-ui="skill-item-stale">update available</span>}
            </div>
            <div data-agent-ui="skill-item-description">{skill.description}</div>
            <div data-agent-ui="skill-item-actions">
              <span data-agent-ui="skill-item-status">
                {skill.enabled ? "Enabled" : "Disabled"}
              </span>
              {skill.autoUpdate && (
                <span data-agent-ui="skill-item-auto-update">Auto-update</span>
              )}
              <button
                type="button"
                data-agent-ui="skill-item-view"
                onClick={() => setViewingSkill(skill.id)}
              >
                View
              </button>
            </div>
          </div>
        ))}
      </div>
      {viewingSkill && (
        <SkillViewer skillId={viewingSkill} onClose={() => setViewingSkill(null)} />
      )}
    </div>
  );
}
