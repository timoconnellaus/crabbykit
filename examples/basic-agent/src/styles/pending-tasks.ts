export const pendingTasksStyles = `
[data-agent-ui="pending-tasks-banner"] {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  margin: 0 0.75rem;
  background: color-mix(in srgb, var(--agent-ui-primary) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--agent-ui-primary) 20%, transparent);
  border-radius: 6px;
  font-family: "SF Mono", "Fira Code", "JetBrains Mono", ui-monospace, monospace;
  font-size: 0.6875rem;
  color: var(--agent-ui-text-dim);
  letter-spacing: 0.01em;
}

[data-agent-ui="pending-tasks-dot"] {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--agent-ui-primary);
  animation: a2a-pulse 2s ease-in-out infinite;
  flex-shrink: 0;
}

@keyframes a2a-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

[data-agent-ui="pending-tasks-label"] {
  color: var(--agent-ui-text-muted);
}

[data-agent-ui="pending-tasks-names"] {
  color: var(--agent-ui-text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
`;
