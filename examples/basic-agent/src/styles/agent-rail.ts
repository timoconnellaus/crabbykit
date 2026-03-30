export const agentRailStyles = `
[data-agent-ui="agent-rail"] {
  display: flex;
  flex-direction: column;
  width: 200px;
  min-width: 200px;
  background: color-mix(in srgb, var(--agent-ui-bg) 100%, black 0%);
  border-right: 1px solid var(--agent-ui-border);
  font-family: "SF Mono", "Fira Code", "JetBrains Mono", ui-monospace, monospace;
  font-size: 0.75rem;
  overflow-y: auto;
}

[data-agent-ui="agent-rail-header"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 0.75rem 0.5rem;
  color: var(--agent-ui-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.625rem;
  font-weight: 600;
  user-select: none;
}

[data-agent-ui="agent-rail-add"] {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--agent-ui-border);
  border-radius: 4px;
  background: transparent;
  color: var(--agent-ui-text-muted);
  cursor: pointer;
  font-size: 0.875rem;
  line-height: 1;
  transition: all 0.15s ease;
}
[data-agent-ui="agent-rail-add"]:hover {
  background: var(--agent-ui-bg-surface);
  color: var(--agent-ui-text);
  border-color: var(--agent-ui-text-muted);
}

[data-agent-ui="agent-rail-list"] {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 0.375rem 0.5rem;
}

[data-agent-ui="agent-rail-item"] {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.5rem;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--agent-ui-text-dim);
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition: all 0.12s ease;
  position: relative;
}
[data-agent-ui="agent-rail-item"]:hover {
  background: var(--agent-ui-bg-surface);
  color: var(--agent-ui-text);
}
[data-agent-ui="agent-rail-item"][data-active] {
  background: var(--agent-ui-primary-highlight);
  color: var(--agent-ui-primary);
}

[data-agent-ui="agent-rail-dot"] {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--agent-ui-text-muted);
  flex-shrink: 0;
  opacity: 0.5;
}
[data-agent-ui="agent-rail-item"][data-active] [data-agent-ui="agent-rail-dot"] {
  background: var(--agent-ui-primary);
  opacity: 1;
  box-shadow: 0 0 6px var(--agent-ui-primary-focus-ring);
}

[data-agent-ui="agent-rail-name"] {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

[data-agent-ui="agent-rail-empty"] {
  padding: 1rem 0.75rem;
  color: var(--agent-ui-text-muted);
  font-style: italic;
  text-align: center;
}
`;
