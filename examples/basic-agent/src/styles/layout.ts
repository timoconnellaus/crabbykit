export const layoutStyles = `
[data-agent-ui="sidebar-nav"] {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--agent-ui-border);
  background: var(--agent-ui-bg);
  font-family: "SF Mono", "Fira Code", "JetBrains Mono", ui-monospace, monospace;
  font-size: 0.6875rem;
  flex-shrink: 0;
  user-select: none;
  position: relative;
  z-index: 20;
  width: 200px;
}

[data-agent-ui="sidebar-nav-tabs"] {
  display: flex;
  flex-direction: column;
}

[data-agent-ui="tab-item"] {
  padding: 0.55rem 0.85rem;
  border: none;
  border-left: 2px solid transparent;
  background: transparent;
  color: var(--agent-ui-text-muted);
  cursor: pointer;
  font: inherit;
  letter-spacing: 0.02em;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
}
[data-agent-ui="tab-item"]:hover {
  color: var(--agent-ui-text-dim);
  background: var(--agent-ui-bg-surface);
}
[data-agent-ui="tab-item"][data-active] {
  color: var(--agent-ui-primary);
  border-left-color: var(--agent-ui-primary);
}

[data-agent-ui="message-timestamp"] {
  display: none;
}

/* ---------- Agent picker ---------- */

[data-agent-ui="agent-picker"] {
  position: relative;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--agent-ui-border);
}

[data-agent-ui="agent-picker-trigger"] {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.55rem 0.85rem;
  border: none;
  background: transparent;
  color: var(--agent-ui-text);
  cursor: pointer;
  font: inherit;
  letter-spacing: 0.02em;
  transition: background 0.15s ease, color 0.15s ease;
  width: 100%;
}
[data-agent-ui="agent-picker-trigger"]:hover,
[data-agent-ui="agent-picker-trigger"][data-open] {
  background: var(--agent-ui-bg-surface);
}

[data-agent-ui="agent-picker-label"] {
  color: var(--agent-ui-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 0.5625rem;
  font-weight: 600;
}

[data-agent-ui="agent-picker-dot"] {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--agent-ui-primary);
  box-shadow: 0 0 6px var(--agent-ui-primary-focus-ring);
  flex-shrink: 0;
}

[data-agent-ui="agent-picker-name"] {
  color: var(--agent-ui-text);
  font-weight: 500;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

[data-agent-ui="agent-picker-chevron"] {
  color: var(--agent-ui-text-muted);
  transition: transform 0.2s ease;
  flex-shrink: 0;
}
[data-agent-ui="agent-picker-trigger"][data-open] [data-agent-ui="agent-picker-chevron"] {
  transform: rotate(180deg);
  color: var(--agent-ui-text);
}

[data-agent-ui="agent-picker-menu"] {
  position: absolute;
  top: 0;
  left: calc(100% + 4px);
  width: 280px;
  background: var(--agent-ui-bg);
  border: 1px solid var(--agent-ui-border);
  border-radius: 6px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28), 0 2px 6px rgba(0, 0, 0, 0.18);
  padding: 0.25rem;
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 30;
  animation: agent-picker-in 0.14s ease-out;
}

@keyframes agent-picker-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

[data-agent-ui="agent-picker-menu-header"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.55rem 0.625rem 0.45rem;
  color: var(--agent-ui-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 0.5625rem;
  font-weight: 600;
  border-bottom: 1px dashed var(--agent-ui-border);
  margin-bottom: 0.25rem;
}

[data-agent-ui="agent-picker-count"] {
  color: var(--agent-ui-text-dim);
  font-variant-numeric: tabular-nums;
}

[data-agent-ui="agent-picker-menu-list"] {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 320px;
  overflow-y: auto;
}

[data-agent-ui="agent-picker-empty"] {
  padding: 0.85rem 0.75rem;
  color: var(--agent-ui-text-muted);
  font-style: italic;
  text-align: center;
}

[data-agent-ui="agent-picker-item"] {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.55rem 0.625rem;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--agent-ui-text-dim);
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition: background 0.12s ease, color 0.12s ease;
}
[data-agent-ui="agent-picker-item"]:hover {
  background: var(--agent-ui-bg-surface);
  color: var(--agent-ui-text);
}
[data-agent-ui="agent-picker-item"][data-active] {
  background: var(--agent-ui-primary-highlight);
  color: var(--agent-ui-primary);
}

[data-agent-ui="agent-picker-item-dot"] {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--agent-ui-text-muted);
  flex-shrink: 0;
  opacity: 0.5;
}
[data-agent-ui="agent-picker-item"][data-active] [data-agent-ui="agent-picker-item-dot"] {
  background: var(--agent-ui-primary);
  opacity: 1;
  box-shadow: 0 0 6px var(--agent-ui-primary-focus-ring);
}

[data-agent-ui="agent-picker-item-name"] {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-agent-ui="agent-picker-item-mark"] {
  font-size: 0.5625rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--agent-ui-primary);
  opacity: 0.85;
}

[data-agent-ui="agent-picker-create"] {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.6rem 0.625rem;
  margin-top: 0.25rem;
  border: 1px dashed var(--agent-ui-border);
  border-radius: 4px;
  background: transparent;
  color: var(--agent-ui-text-muted);
  cursor: pointer;
  font: inherit;
  letter-spacing: 0.02em;
  transition: all 0.15s ease;
}
[data-agent-ui="agent-picker-create"]:hover {
  color: var(--agent-ui-text);
  border-color: var(--agent-ui-text-muted);
  background: var(--agent-ui-bg-surface);
}

[data-agent-ui="agent-picker-plus"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1px solid currentColor;
  font-size: 0.75rem;
  line-height: 1;
  flex-shrink: 0;
}
`;
