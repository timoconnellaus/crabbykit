import type { ComponentPropsWithoutRef } from "react";

export interface SkillViewerProps extends ComponentPropsWithoutRef<"div"> {
  skillId: string;
  onClose: () => void;
}

/**
 * Read-only viewer for SKILL.md content.
 *
 * Note: The actual content would be fetched via the agent (skill_load tool)
 * or a dedicated HTTP endpoint. For now, this renders a placeholder that
 * the consumer can style and populate.
 */
export function SkillViewer({ skillId, onClose, ...props }: SkillViewerProps) {
  return (
    <div data-agent-ui="skill-viewer" {...props}>
      <div data-agent-ui="skill-viewer-header">
        <span data-agent-ui="skill-viewer-title">{skillId}</span>
        <button type="button" data-agent-ui="skill-viewer-close" onClick={onClose}>
          &times;
        </button>
      </div>
      <div data-agent-ui="skill-viewer-content">
        <p data-agent-ui="skill-viewer-placeholder">
          Use <code>skill_load</code> to view the contents of this skill.
        </p>
      </div>
    </div>
  );
}
