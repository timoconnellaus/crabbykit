export const layoutStyles = `
[data-agent-ui="tab-bar"] {
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--agent-ui-border);
  background: var(--agent-ui-bg);
  font-family: "SF Mono", "Fira Code", "JetBrains Mono", ui-monospace, monospace;
  font-size: 0.6875rem;
  flex-shrink: 0;
  user-select: none;
}

[data-agent-ui="tab-item"] {
  padding: 0.5rem 1rem;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--agent-ui-text-muted);
  cursor: pointer;
  font: inherit;
  letter-spacing: 0.02em;
  transition: all 0.15s ease;
}
[data-agent-ui="tab-item"]:hover {
  color: var(--agent-ui-text-dim);
  background: var(--agent-ui-bg-surface);
}
[data-agent-ui="tab-item"][data-active] {
  color: var(--agent-ui-primary);
  border-bottom-color: var(--agent-ui-primary);
}

[data-agent-ui="message-timestamp"] {
  display: none;
}
`;
