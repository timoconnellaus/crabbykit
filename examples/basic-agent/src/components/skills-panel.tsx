import type { SkillListEntry } from "@claw-for-cloudflare/agent-runtime";
import { useEffect } from "react";
import type { RegistrySkill } from "../hooks/use-skills-api";
import { useSkillsApi } from "../hooks/use-skills-api";
import { skillsStyles } from "../styles/skills";

interface SkillsPanelProps {
  skills: SkillListEntry[];
  agentId: string;
}

function skillStatus(skill: SkillListEntry): "enabled" | "disabled" | "stale" {
  if (skill.stale) return "stale";
  return skill.enabled ? "enabled" : "disabled";
}

function SkillCard({
  skill,
  onUninstall,
  uninstallLoading,
}: {
  skill: SkillListEntry;
  onUninstall?: () => void;
  uninstallLoading?: boolean;
}) {
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
        {onUninstall && !skill.builtIn && (
          <button
            type="button"
            data-agent-ui="skill-action-btn"
            data-danger=""
            title="Uninstall"
            disabled={uninstallLoading}
            onClick={onUninstall}
          >
            &times;
          </button>
        )}
      </div>
    </div>
  );
}

function AvailableSkillCard({
  skill,
  onInstall,
  loading,
}: {
  skill: RegistrySkill;
  onInstall: () => void;
  loading: boolean;
}) {
  return (
    <div data-agent-ui="skill-card" data-available="">
      <span data-agent-ui="skill-status-dot" data-status="available" />
      <div data-agent-ui="skill-card-info">
        <div data-agent-ui="skill-card-name">{skill.name}</div>
        <div data-agent-ui="skill-card-meta">
          <span data-agent-ui="skill-card-description">{skill.description}</span>
        </div>
      </div>
      <div data-agent-ui="skill-card-badges">
        <span data-agent-ui="skill-badge" data-variant="version">
          v{skill.version}
        </span>
        <button
          type="button"
          data-agent-ui="skill-install-btn"
          disabled={loading}
          onClick={onInstall}
        >
          {loading ? "..." : "+ Install"}
        </button>
      </div>
    </div>
  );
}

export function SkillsPanel({ skills, agentId }: SkillsPanelProps) {
  const api = useSkillsApi(agentId);
  const enabledCount = skills.filter((s) => s.enabled).length;

  useEffect(() => {
    api.fetchAvailable();
  }, [api.fetchAvailable]);

  return (
    <>
      <style>{skillsStyles}</style>
      <div data-agent-ui="skills-panel">
        <div data-agent-ui="skills-panel-header">
          <span data-agent-ui="skills-panel-title">Installed Skills</span>
          {skills.length > 0 && (
            <span data-agent-ui="skills-panel-count">
              {enabledCount}/{skills.length} enabled
            </span>
          )}
        </div>

        {api.error && (
          <div data-agent-ui="skills-error">{api.error}</div>
        )}

        {skills.length === 0 ? (
          <div data-agent-ui="skills-empty">
            <div data-agent-ui="skills-empty-title">No skills installed</div>
            <div>Install skills from the registry below</div>
          </div>
        ) : (
          <div data-agent-ui="skills-panel-list">
            {skills.map((s) => (
              <SkillCard
                key={s.id}
                skill={s}
                onUninstall={s.builtIn ? undefined : () => api.uninstallSkill(s.id)}
                uninstallLoading={api.loading}
              />
            ))}
          </div>
        )}

        {api.available.length > 0 && (
          <>
            <div data-agent-ui="skills-panel-header" data-section="available">
              <span data-agent-ui="skills-panel-title">Available from Registry</span>
              <span data-agent-ui="skills-panel-count">{api.available.length} available</span>
            </div>
            <div data-agent-ui="skills-panel-list">
              {api.available.map((s) => (
                <AvailableSkillCard
                  key={s.id}
                  skill={s}
                  onInstall={() => api.installSkill(s.id)}
                  loading={api.loading}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
