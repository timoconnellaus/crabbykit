export const skillsStyles = `
[data-agent-ui="skills-panel"] {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow-y: auto;
  font-family: "SF Mono", "Fira Code", "JetBrains Mono", ui-monospace, monospace;
  font-size: 0.75rem;
  background: var(--agent-ui-bg);
}

[data-agent-ui="skills-panel-header"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--agent-ui-border);
}

[data-agent-ui="skills-panel-title"] {
  color: var(--agent-ui-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.625rem;
  font-weight: 600;
}

[data-agent-ui="skills-panel-count"] {
  color: var(--agent-ui-text-muted);
  font-size: 0.625rem;
}

[data-agent-ui="skills-panel-list"] {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0.5rem;
}

[data-agent-ui="skill-card"] {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--agent-ui-schedule-border);
  border-radius: 6px;
  background: var(--agent-ui-schedule-bg);
  transition: all 0.15s ease;
}
[data-agent-ui="skill-card"]:hover {
  border-color: var(--agent-ui-border-input);
}
[data-agent-ui="skill-card"][data-disabled] {
  opacity: 0.5;
}

[data-agent-ui="skill-status-dot"] {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
[data-agent-ui="skill-status-dot"][data-status="enabled"] {
  background: var(--agent-ui-success);
}
[data-agent-ui="skill-status-dot"][data-status="disabled"] {
  background: var(--agent-ui-text-muted);
  opacity: 0.4;
}
[data-agent-ui="skill-status-dot"][data-status="stale"] {
  background: #f59e0b;
  animation: skill-pulse 1.5s ease-in-out infinite;
}

@keyframes skill-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

[data-agent-ui="skill-card-info"] {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

[data-agent-ui="skill-card-name"] {
  color: var(--agent-ui-text);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-agent-ui="skill-card-meta"] {
  color: var(--agent-ui-text-muted);
  font-size: 0.625rem;
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

[data-agent-ui="skill-card-description"] {
  color: var(--agent-ui-text-muted);
  font-size: 0.625rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 32ch;
}

[data-agent-ui="skill-card-badges"] {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-shrink: 0;
}

[data-agent-ui="skill-badge"] {
  padding: 0.125rem 0.375rem;
  border-radius: 3px;
  font-size: 0.5625rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
[data-agent-ui="skill-badge"][data-variant="stale"] {
  background: rgba(245, 158, 11, 0.12);
  color: #f59e0b;
}
[data-agent-ui="skill-badge"][data-variant="auto-update"] {
  background: var(--agent-ui-primary-highlight);
  color: var(--agent-ui-primary);
}
[data-agent-ui="skill-badge"][data-variant="version"] {
  background: transparent;
  color: var(--agent-ui-text-muted);
}

[data-agent-ui="skills-empty"] {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 3rem 1rem;
  color: var(--agent-ui-text-muted);
  text-align: center;
}

[data-agent-ui="skills-empty-title"] {
  font-size: 0.8125rem;
  color: var(--agent-ui-text-dim);
}

[data-agent-ui="skills-error"] {
  color: var(--agent-ui-error);
  font-size: 0.625rem;
  padding: 0.375rem 0.75rem;
  margin: 0.5rem;
  background: var(--agent-ui-error-bg);
  border: 1px solid var(--agent-ui-error-border);
  border-radius: 4px;
}

[data-agent-ui="skills-panel-header"][data-section="available"] {
  margin-top: 0.25rem;
  border-top: 1px solid var(--agent-ui-border);
}

[data-agent-ui="skill-status-dot"][data-status="available"] {
  background: var(--agent-ui-primary);
  opacity: 0.4;
}

[data-agent-ui="skill-card"][data-available] {
  border-style: dashed;
}

[data-agent-ui="skill-action-btn"] {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--agent-ui-border);
  border-radius: 4px;
  background: transparent;
  color: var(--agent-ui-text-muted);
  cursor: pointer;
  font-size: 0.75rem;
  transition: all 0.15s ease;
}
[data-agent-ui="skill-action-btn"]:hover {
  background: var(--agent-ui-bg-surface);
  color: var(--agent-ui-text);
  border-color: var(--agent-ui-text-muted);
}
[data-agent-ui="skill-action-btn"][data-danger]:hover {
  color: var(--agent-ui-danger);
  border-color: var(--agent-ui-danger);
  background: var(--agent-ui-danger-bg-subtle);
}
[data-agent-ui="skill-action-btn"]:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

[data-agent-ui="skill-install-btn"] {
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--agent-ui-border);
  border-radius: 4px;
  background: transparent;
  color: var(--agent-ui-text-dim);
  cursor: pointer;
  font: inherit;
  font-size: 0.625rem;
  transition: all 0.15s ease;
  white-space: nowrap;
}
[data-agent-ui="skill-install-btn"]:hover {
  background: var(--agent-ui-primary-highlight);
  color: var(--agent-ui-primary);
  border-color: var(--agent-ui-primary);
}
[data-agent-ui="skill-install-btn"]:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
`;
