export const channelsStyles = `
/* ================================================================
   Channels hub — multi-channel layout
   ================================================================ */

[data-agent-ui="channels-panel"] {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow-y: auto;
  font-family: "SF Mono", "Fira Code", "JetBrains Mono", ui-monospace, monospace;
  font-size: 0.75rem;
  background: var(--agent-ui-bg);
  color: var(--agent-ui-text);
}

[data-agent-ui="channels-panel-header"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  min-height: 2.5rem;
  border-bottom: 1px solid var(--agent-ui-border);
}

[data-agent-ui="channels-panel-title"] {
  margin: 0;
  color: var(--agent-ui-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.625rem;
  font-weight: 600;
}

[data-agent-ui="channels-panel-count"] {
  color: var(--agent-ui-text-muted);
  font-size: 0.625rem;
}

/* Empty hub state ------------------------------------------------ */

[data-agent-ui="channels-panel-empty-hub"] {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 3rem 1rem;
  color: var(--agent-ui-text-muted);
  text-align: center;
}

[data-agent-ui="channels-panel-empty-icon"] {
  color: var(--agent-ui-text-muted);
  opacity: 0.4;
  margin-bottom: 0.25rem;
}

[data-agent-ui="channels-panel-empty-title"] {
  font-size: 0.8125rem;
  color: var(--agent-ui-text-dim);
}

[data-agent-ui="channels-panel-empty-description"] {
  font-size: 0.625rem;
  color: var(--agent-ui-text-muted);
  max-width: 40ch;
  line-height: 1.5;
}

/* Channel sections container ------------------------------------- */

[data-agent-ui="channels-panel-sections"] {
  display: flex;
  flex-direction: column;
}

/* Individual channel section ------------------------------------- */

[data-agent-ui="channel-section"] {
  border-bottom: 1px solid var(--agent-ui-border);
}

[data-agent-ui="channel-section-header"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0.625rem 1rem;
  border: none;
  background: transparent;
  color: var(--agent-ui-text);
  cursor: pointer;
  font: inherit;
  font-size: 0.75rem;
  transition: background 0.15s ease;
}
[data-agent-ui="channel-section-header"]:hover {
  background: var(--agent-ui-bg-surface);
}

[data-agent-ui="channel-section-header-left"] {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

[data-agent-ui="channel-section-icon"] {
  flex-shrink: 0;
  opacity: 0.7;
}
[data-agent-ui="channel-section"][data-channel="telegram"]
  [data-agent-ui="channel-section-icon"] {
  color: #229ED9;
}

[data-agent-ui="channel-section-label"] {
  font-weight: 500;
  letter-spacing: 0.02em;
}

[data-agent-ui="channel-section-count"] {
  color: var(--agent-ui-text-muted);
  font-size: 0.625rem;
  font-weight: 400;
}

[data-agent-ui="channel-section-chevron"] {
  color: var(--agent-ui-text-muted);
  transition: transform 0.2s ease;
  flex-shrink: 0;
}
[data-agent-ui="channel-section"][data-expanded]
  [data-agent-ui="channel-section-chevron"] {
  transform: rotate(180deg);
}

/* Section body (shared across channel types) --------------------- */

[data-agent-ui="channel-section-body"] {
  display: flex;
  flex-direction: column;
  padding: 0 1rem 0.75rem;
  gap: 0.5rem;
}

[data-agent-ui="channel-section-toolbar"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.25rem 0;
}

[data-agent-ui="channel-section-hint"] {
  color: var(--agent-ui-text-dim);
  font-size: 0.625rem;
  line-height: 1.4;
}

[data-agent-ui="channel-section-add-btn"] {
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--agent-ui-border);
  border-radius: 4px;
  background: transparent;
  color: var(--agent-ui-text-dim);
  cursor: pointer;
  font: inherit;
  font-size: 0.625rem;
  line-height: 1;
  white-space: nowrap;
  transition: all 0.15s ease;
}
[data-agent-ui="channel-section-add-btn"]:hover {
  background: var(--agent-ui-bg-surface);
  color: var(--agent-ui-text);
  border-color: var(--agent-ui-text-muted);
}

[data-agent-ui="channel-section-loading"],
[data-agent-ui="channel-section-empty"] {
  color: var(--agent-ui-text-muted);
  padding: 0.5rem 0;
  font-size: 0.6875rem;
}

/* Account list --------------------------------------------------- */

[data-agent-ui="channels-account-list"] {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

[data-agent-ui="channels-account-list"] > li {
  display: block;
}

/* Account item --------------------------------------------------- */

[data-agent-ui="telegram-account-item"] {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--agent-ui-schedule-border);
  border-radius: 6px;
  background: var(--agent-ui-schedule-bg);
  transition: border-color 0.15s ease;
}
[data-agent-ui="telegram-account-item"]:hover {
  border-color: var(--agent-ui-border-input);
}
[data-agent-ui="telegram-account-item"][data-active] {
  border-left: 2px solid var(--agent-ui-success);
  padding-left: calc(0.75rem - 1px);
}
[data-agent-ui="telegram-account-item"][data-error] {
  border-left: 2px solid var(--agent-ui-error);
  padding-left: calc(0.75rem - 1px);
}

[data-agent-ui="telegram-account-item-main"] {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

[data-agent-ui="telegram-account-item-id"] {
  color: var(--agent-ui-text);
  font-weight: 600;
}

[data-agent-ui="telegram-account-item-token"] {
  color: var(--agent-ui-text-muted);
  font-size: 0.625rem;
}

[data-agent-ui="telegram-account-item-status"] {
  margin-left: auto;
  color: var(--agent-ui-text-muted);
  font-size: 0.625rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
[data-agent-ui="telegram-account-item"][data-active]
  [data-agent-ui="telegram-account-item-status"] {
  color: var(--agent-ui-success);
}

[data-agent-ui="telegram-account-item-webhook-url"] {
  color: var(--agent-ui-text-dim);
  font-size: 0.625rem;
  word-break: break-all;
}

[data-agent-ui="telegram-account-item-error"] {
  color: var(--agent-ui-error);
  background: var(--agent-ui-error-bg);
  border: 1px solid var(--agent-ui-error-border);
  border-radius: 4px;
  padding: 0.375rem 0.5rem;
  font-size: 0.625rem;
}

[data-agent-ui="telegram-account-item-actions"] {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

[data-agent-ui="telegram-account-item-confirm-label"] {
  color: var(--agent-ui-text-dim);
  font-size: 0.625rem;
}

[data-agent-ui="telegram-account-item-remove"],
[data-agent-ui="telegram-account-item-confirm-no"] {
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
[data-agent-ui="telegram-account-item-remove"]:hover,
[data-agent-ui="telegram-account-item-confirm-no"]:hover {
  background: var(--agent-ui-bg-surface);
  color: var(--agent-ui-text);
  border-color: var(--agent-ui-text-muted);
}

[data-agent-ui="telegram-account-item-confirm-yes"] {
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--agent-ui-error-border);
  border-radius: 4px;
  background: var(--agent-ui-error-bg);
  color: var(--agent-ui-error);
  cursor: pointer;
  font: inherit;
  font-size: 0.625rem;
  transition: all 0.15s ease;
}
[data-agent-ui="telegram-account-item-confirm-yes"]:hover {
  filter: brightness(1.15);
}

/* Add form ------------------------------------------------------- */

[data-agent-ui="add-telegram-account-form"] {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  border: 1px solid var(--agent-ui-border);
  border-radius: 6px;
  background: var(--agent-ui-bg-surface);
}

[data-agent-ui="add-telegram-account-form-row"] {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

[data-agent-ui="add-telegram-account-form-label"] {
  color: var(--agent-ui-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.5625rem;
  font-weight: 600;
}

[data-agent-ui="add-telegram-account-form-optional"] {
  color: var(--agent-ui-text-dim);
  text-transform: none;
  letter-spacing: normal;
  font-weight: 400;
}

[data-agent-ui="add-telegram-account-form-input"] {
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--agent-ui-border-input);
  border-radius: 4px;
  background: var(--agent-ui-bg);
  color: var(--agent-ui-text);
  font: inherit;
  font-size: 0.6875rem;
  outline: none;
  transition: border-color 0.15s ease;
}
[data-agent-ui="add-telegram-account-form-input"]:focus {
  border-color: var(--agent-ui-primary);
}

[data-agent-ui="add-telegram-account-form-secret-group"] {
  display: flex;
  gap: 0.375rem;
}
[data-agent-ui="add-telegram-account-form-secret-group"]
  [data-agent-ui="add-telegram-account-form-input"] {
  flex: 1;
  min-width: 0;
}

[data-agent-ui="add-telegram-account-form-generate"],
[data-agent-ui="add-telegram-account-form-secret-toggle"],
[data-agent-ui="add-telegram-account-form-secret-copy"] {
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--agent-ui-border);
  border-radius: 4px;
  background: transparent;
  color: var(--agent-ui-text-dim);
  cursor: pointer;
  font: inherit;
  font-size: 0.625rem;
  white-space: nowrap;
  transition: all 0.15s ease;
}
[data-agent-ui="add-telegram-account-form-generate"]:hover,
[data-agent-ui="add-telegram-account-form-secret-toggle"]:hover,
[data-agent-ui="add-telegram-account-form-secret-copy"]:hover {
  background: var(--agent-ui-bg);
  color: var(--agent-ui-text);
  border-color: var(--agent-ui-text-muted);
}
[data-agent-ui="add-telegram-account-form-secret-toggle"][aria-pressed="true"] {
  background: var(--agent-ui-bg);
  color: var(--agent-ui-text);
  border-color: var(--agent-ui-text-muted);
}
[data-agent-ui="add-telegram-account-form-secret-copy"][data-copied] {
  background: var(--agent-ui-primary-highlight);
  color: var(--agent-ui-primary);
  border-color: var(--agent-ui-primary);
}

[data-agent-ui="add-telegram-account-form-hint"] {
  color: var(--agent-ui-text-dim);
  font-size: 0.5625rem;
  line-height: 1.4;
}
[data-agent-ui="add-telegram-account-form-hint"] code {
  background: var(--agent-ui-bg);
  border: 1px solid var(--agent-ui-border);
  border-radius: 3px;
  padding: 0 0.25rem;
  font-size: inherit;
}

[data-agent-ui="add-telegram-account-form-link"] {
  color: var(--agent-ui-primary);
  text-decoration: none;
}
[data-agent-ui="add-telegram-account-form-link"]:hover {
  text-decoration: underline;
}

[data-agent-ui="add-telegram-account-form-error"] {
  color: var(--agent-ui-error);
  background: var(--agent-ui-error-bg);
  border: 1px solid var(--agent-ui-error-border);
  border-radius: 4px;
  padding: 0.375rem 0.5rem;
  font-size: 0.625rem;
}

[data-agent-ui="add-telegram-account-form-actions"] {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

[data-agent-ui="add-telegram-account-form-cancel"] {
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
[data-agent-ui="add-telegram-account-form-cancel"]:hover {
  background: var(--agent-ui-bg);
  color: var(--agent-ui-text);
  border-color: var(--agent-ui-text-muted);
}

[data-agent-ui="add-telegram-account-form-submit"] {
  padding: 0.375rem 0.875rem;
  border: 1px solid var(--agent-ui-primary);
  border-radius: 4px;
  background: var(--agent-ui-primary-highlight);
  color: var(--agent-ui-primary);
  cursor: pointer;
  font: inherit;
  font-size: 0.6875rem;
  font-weight: 500;
  transition: all 0.15s ease;
}
[data-agent-ui="add-telegram-account-form-submit"]:hover {
  filter: brightness(1.15);
}
`;
