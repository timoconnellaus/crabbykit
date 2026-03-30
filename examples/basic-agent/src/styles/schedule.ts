export const scheduleStyles = `
[data-agent-ui="schedule-panel"] {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow-y: auto;
  font-family: "SF Mono", "Fira Code", "JetBrains Mono", ui-monospace, monospace;
  font-size: 0.75rem;
  background: var(--agent-ui-bg);
}

[data-agent-ui="schedule-panel-header"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--agent-ui-border);
}

[data-agent-ui="schedule-panel-title"] {
  color: var(--agent-ui-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.625rem;
  font-weight: 600;
}

[data-agent-ui="schedule-panel-add"] {
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--agent-ui-border);
  border-radius: 4px;
  background: transparent;
  color: var(--agent-ui-text-dim);
  cursor: pointer;
  font: inherit;
  font-size: 0.625rem;
  transition: all 0.15s ease;
}
[data-agent-ui="schedule-panel-add"]:hover {
  background: var(--agent-ui-bg-surface);
  color: var(--agent-ui-text);
  border-color: var(--agent-ui-text-muted);
}

[data-agent-ui="schedule-panel-list"] {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0.5rem;
}

[data-agent-ui="schedule-card"] {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--agent-ui-schedule-border);
  border-radius: 6px;
  background: var(--agent-ui-schedule-bg);
  transition: all 0.15s ease;
}
[data-agent-ui="schedule-card"]:hover {
  border-color: var(--agent-ui-border-input);
}
[data-agent-ui="schedule-card"][data-disabled] {
  opacity: 0.5;
}

[data-agent-ui="schedule-status-dot"] {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
[data-agent-ui="schedule-status-dot"][data-status="idle"] {
  background: var(--agent-ui-success);
}
[data-agent-ui="schedule-status-dot"][data-status="running"] {
  background: var(--agent-ui-primary);
  animation: schedule-pulse 1.5s ease-in-out infinite;
}
[data-agent-ui="schedule-status-dot"][data-status="failed"] {
  background: var(--agent-ui-danger);
}

@keyframes schedule-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

[data-agent-ui="schedule-card-info"] {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

[data-agent-ui="schedule-card-name"] {
  color: var(--agent-ui-text);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-agent-ui="schedule-card-meta"] {
  color: var(--agent-ui-text-muted);
  font-size: 0.625rem;
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

[data-agent-ui="schedule-card-actions"] {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-shrink: 0;
}

[data-agent-ui="schedule-action-btn"] {
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
[data-agent-ui="schedule-action-btn"]:hover {
  background: var(--agent-ui-bg-surface);
  color: var(--agent-ui-text);
  border-color: var(--agent-ui-text-muted);
}
[data-agent-ui="schedule-action-btn"][data-danger]:hover {
  color: var(--agent-ui-danger);
  border-color: var(--agent-ui-danger);
  background: var(--agent-ui-danger-bg-subtle);
}

[data-agent-ui="schedule-toggle"] {
  width: 32px;
  height: 18px;
  border-radius: 9px;
  border: none;
  cursor: pointer;
  background: var(--agent-ui-text-muted);
  transition: background 0.2s;
  padding: 0;
  flex-shrink: 0;
}
[data-agent-ui="schedule-toggle"][data-on] {
  background: var(--agent-ui-success);
}

[data-agent-ui="schedule-toggle-knob"] {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s;
  transform: translateX(2px);
}
[data-agent-ui="schedule-toggle"][data-on] [data-agent-ui="schedule-toggle-knob"] {
  transform: translateX(16px);
}

[data-agent-ui="schedule-empty"] {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 3rem 1rem;
  color: var(--agent-ui-text-muted);
  text-align: center;
}

[data-agent-ui="schedule-empty-title"] {
  font-size: 0.8125rem;
  color: var(--agent-ui-text-dim);
}

/* --- Schedule Form --- */

[data-agent-ui="schedule-form"] {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  padding: 0.75rem;
  margin: 0.5rem;
  border: 1px solid var(--agent-ui-border);
  border-radius: 6px;
  background: var(--agent-ui-bg-surface);
}

[data-agent-ui="schedule-form-title"] {
  color: var(--agent-ui-text-dim);
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

[data-agent-ui="schedule-form-field"] {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

[data-agent-ui="schedule-form-label"] {
  color: var(--agent-ui-text-muted);
  font-size: 0.625rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

[data-agent-ui="schedule-form-input"],
[data-agent-ui="schedule-form-textarea"],
[data-agent-ui="schedule-form-select"] {
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--agent-ui-border-input);
  border-radius: 4px;
  background: var(--agent-ui-bg);
  color: var(--agent-ui-text);
  font: inherit;
  font-size: 0.75rem;
  transition: border-color 0.15s ease;
}
[data-agent-ui="schedule-form-input"]:focus,
[data-agent-ui="schedule-form-textarea"]:focus,
[data-agent-ui="schedule-form-select"]:focus {
  outline: none;
  border-color: var(--agent-ui-primary);
  box-shadow: 0 0 0 2px var(--agent-ui-primary-focus-ring);
}

[data-agent-ui="schedule-form-textarea"] {
  resize: vertical;
  min-height: 3rem;
}

[data-agent-ui="schedule-form-row"] {
  display: flex;
  gap: 0.5rem;
}

[data-agent-ui="schedule-form-actions"] {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  padding-top: 0.25rem;
}

[data-agent-ui="schedule-form-btn"] {
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--agent-ui-border);
  border-radius: 4px;
  background: transparent;
  color: var(--agent-ui-text-dim);
  cursor: pointer;
  font: inherit;
  font-size: 0.6875rem;
  transition: all 0.15s ease;
}
[data-agent-ui="schedule-form-btn"]:hover {
  background: var(--agent-ui-bg-surface);
  border-color: var(--agent-ui-text-muted);
}
[data-agent-ui="schedule-form-btn"][data-primary] {
  background: var(--agent-ui-primary);
  border-color: var(--agent-ui-primary);
  color: white;
}
[data-agent-ui="schedule-form-btn"][data-primary]:hover {
  background: var(--agent-ui-primary-hover);
}
[data-agent-ui="schedule-form-btn"]:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

[data-agent-ui="schedule-form-error"] {
  color: var(--agent-ui-error);
  font-size: 0.625rem;
  padding: 0.25rem 0.5rem;
  background: var(--agent-ui-error-bg);
  border: 1px solid var(--agent-ui-error-border);
  border-radius: 4px;
}

[data-agent-ui="schedule-form-hint"] {
  color: var(--agent-ui-text-muted);
  font-size: 0.5625rem;
}
`;
