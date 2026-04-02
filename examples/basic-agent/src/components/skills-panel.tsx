import type { SkillListEntry } from "@claw-for-cloudflare/agent-runtime";
import { skillsStyles } from "../styles/skills";

interface SkillsPanelProps {
  skills: SkillListEntry[];
}

function skillStatus(skill: SkillListEntry): "enabled" | "disabled" | "stale" {
  if (skill.stale) return "stale";
  return skill.enabled ? "enabled" : "disabled";
}

function SkillCard({ skill }: { skill: SkillListEntry }) {
  return (
    <div data-agent-ui="skill-card" data-disabled={!skill.enabled || undefined}>
      <span
        data-agent-ui="skill-status-dot"
        data-status={skillStatus(skill)}
        title={skillStatus(skill)}
      />
      <div data-agent-ui="skill-card-info">
        <div data-agent-ui="skill-card-name">{skill.name}</div>
        <div data-agent-ui="skill-card-meta">
          <span data-agent-ui="skill-card-description">{skill.description}</span>
        </div>
      </div>
      <div data-agent-ui="skill-card-badges">
        {skill.stale && (
          <span data-agent-ui="skill-badge" data-variant="stale">
            update available
          </span>
        )}
        {skill.autoUpdate && (
          <span data-agent-ui="skill-badge" data-variant="auto-update">
            auto-update
          </span>
        )}
        <span data-agent-ui="skill-badge" data-variant="version">
          v{skill.version}
        </span>
      </div>
    </div>
  );
}

export function SkillsPanel({ skills }: SkillsPanelProps) {
  const enabledCount = skills.filter((s) => s.enabled).length;

  return (
    <>
      <style>{skillsStyles}</style>
      <div data-agent-ui="skills-panel">
        <div data-agent-ui="skills-panel-header">
          <span data-agent-ui="skills-panel-title">Skills</span>
          {skills.length > 0 && (
            <span data-agent-ui="skills-panel-count">
              {enabledCount}/{skills.length} enabled
            </span>
          )}
        </div>

        {skills.length === 0 ? (
          <div data-agent-ui="skills-empty">
            <div data-agent-ui="skills-empty-title">No skills installed</div>
            <div>Skills provide on-demand instructions for specific tasks</div>
          </div>
        ) : (
          <div data-agent-ui="skills-panel-list">
            {skills.map((s) => (
              <SkillCard key={s.id} skill={s} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
