export const appsStyles = `
[data-agent-ui="apps-panel"] {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow-y: auto;
  font-family: "SF Mono", "Fira Code", "JetBrains Mono", ui-monospace, monospace;
  font-size: 0.75rem;
  background: var(--agent-ui-bg);
}

[data-agent-ui="apps-panel-header"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  min-height: 2.5rem;
  border-bottom: 1px solid var(--agent-ui-border);
}

[data-agent-ui="apps-panel-title"] {
  color: var(--agent-ui-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.625rem;
  font-weight: 600;
}

[data-agent-ui="apps-panel-list"] {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0.5rem;
}

[data-agent-ui="app-card"] {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--agent-ui-schedule-border);
  border-radius: 6px;
  background: var(--agent-ui-schedule-bg);
  transition: all 0.15s ease;
}
[data-agent-ui="app-card"]:hover {
  border-color: var(--agent-ui-border-input);
}

[data-agent-ui="app-card-info"] {
  flex: 1;
  min-width: 0;
}

[data-agent-ui="app-card-name"] {
  color: var(--agent-ui-text);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

[data-agent-ui="app-card-meta"] {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.25rem;
  color: var(--agent-ui-text-dim);
  font-size: 0.625rem;
}

[data-agent-ui="app-card-version"] {
  color: var(--agent-ui-accent, #60a5fa);
  font-weight: 600;
}

[data-agent-ui="app-card-commit"] {
  font-family: inherit;
  color: var(--agent-ui-text-muted);
}

[data-agent-ui="app-card-actions"] {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-shrink: 0;
}

[data-agent-ui="app-action-btn"] {
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--agent-ui-border);
  border-radius: 4px;
  background: transparent;
  color: var(--agent-ui-text-dim);
  cursor: pointer;
  font: inherit;
  font-size: 0.625rem;
  text-decoration: none;
  transition: all 0.15s ease;
}
[data-agent-ui="app-action-btn"]:hover {
  background: var(--agent-ui-bg-surface);
  color: var(--agent-ui-text);
  border-color: var(--agent-ui-text-muted);
}

[data-agent-ui="app-backend-badge"] {
  display: inline-block;
  padding: 0.125rem 0.375rem;
  border-radius: 3px;
  background: rgba(96, 165, 250, 0.15);
  color: var(--agent-ui-accent, #60a5fa);
  font-size: 0.5625rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

[data-agent-ui="apps-empty"] {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 3rem 1rem;
  color: var(--agent-ui-text-muted);
  text-align: center;
}
[data-agent-ui="apps-empty-title"] {
  font-size: 0.8125rem;
  color: var(--agent-ui-text-dim);
}
`;
