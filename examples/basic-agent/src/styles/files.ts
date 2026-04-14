export const filesStyles = `
/* ================================================================
   Files panel — tree + editor
   ================================================================ */

[data-agent-ui="files-panel"] {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--agent-ui-bg);
  color: var(--agent-ui-text);
  font-family: "SF Mono", "Fira Code", "JetBrains Mono", ui-monospace, monospace;
  font-size: 0.75rem;
}

[data-agent-ui="files-panel-error"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: rgba(239, 68, 68, 0.12);
  border-bottom: 1px solid rgba(239, 68, 68, 0.3);
  color: #fca5a5;
  font-size: 0.6875rem;
}

[data-agent-ui="files-panel-error-dismiss"] {
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
}

[data-agent-ui="files-panel-body"] {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

[data-agent-ui="files-panel-sidebar"] {
  width: 14rem;
  flex-shrink: 0;
  border-right: 1px solid var(--agent-ui-border);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

[data-agent-ui="files-panel-main"] {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

[data-agent-ui="files-panel-empty"] {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--agent-ui-text-muted);
  font-size: 0.6875rem;
}

/* File tree ------------------------------------------------------- */

[data-agent-ui="file-tree"] {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

[data-agent-ui="file-tree-header"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--agent-ui-border);
  min-height: 2.25rem;
}

[data-agent-ui="file-tree-title"] {
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.5625rem;
  font-weight: 600;
  color: var(--agent-ui-text-muted);
}

[data-agent-ui="file-tree-header-actions"] {
  display: flex;
  gap: 0.25rem;
}

[data-agent-ui="file-tree-new-file"],
[data-agent-ui="file-tree-new-folder"],
[data-agent-ui="file-tree-refresh"] {
  background: transparent;
  border: 0;
  color: var(--agent-ui-text-muted);
  cursor: pointer;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  font-family: inherit;
  font-size: 0.5625rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

[data-agent-ui="file-tree-new-file"]:hover,
[data-agent-ui="file-tree-new-folder"]:hover,
[data-agent-ui="file-tree-refresh"]:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--agent-ui-text);
}

[data-agent-ui="file-tree-body"] {
  flex: 1;
  overflow-y: auto;
  padding: 0.25rem 0;
}

[data-agent-ui="file-tree-row"] {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

[data-agent-ui="file-tree-row"]:hover {
  background: rgba(255, 255, 255, 0.05);
}

[data-agent-ui="file-tree-dir-button"],
[data-agent-ui="file-tree-file-button"] {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex: 1;
  min-width: 0;
  padding: 0.2rem 0.25rem;
  background: transparent;
  border: 0;
  color: var(--agent-ui-text);
  text-align: left;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.6875rem;
}

[data-agent-ui="file-tree-file-button"][data-selected] {
  color: var(--agent-ui-accent, #a5b4fc);
}

[data-agent-ui="file-tree-row"]:has([data-selected]) {
  background: rgba(99, 102, 241, 0.15);
}

[data-agent-ui="file-tree-name"] {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-agent-ui="file-tree-icon"] {
  flex-shrink: 0;
}

[data-agent-ui="file-tree-row-actions"] {
  display: none;
  gap: 0.1rem;
  padding-right: 0.4rem;
  flex-shrink: 0;
}

[data-agent-ui="file-tree-row"]:hover [data-agent-ui="file-tree-row-actions"] {
  display: flex;
}

[data-agent-ui="file-tree-row-action"] {
  background: transparent;
  border: 0;
  color: var(--agent-ui-text-muted);
  cursor: pointer;
  padding: 0.1rem 0.3rem;
  border-radius: 3px;
  font-family: inherit;
  font-size: 0.6875rem;
  line-height: 1;
}

[data-agent-ui="file-tree-row-action"]:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--agent-ui-text);
}

[data-agent-ui="file-tree-row-action"][data-danger]:hover {
  color: #fca5a5;
}

[data-agent-ui="file-tree-chevron"] {
  width: 0.75rem;
  color: var(--agent-ui-text-muted);
  font-size: 0.5625rem;
}

[data-agent-ui="file-tree-loading"],
[data-agent-ui="file-tree-empty-dir"] {
  padding: 0.25rem 0.5rem;
  color: var(--agent-ui-text-muted);
  font-size: 0.625rem;
  font-style: italic;
}

[data-agent-ui="file-tree-empty"] {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 2rem 1rem;
  color: var(--agent-ui-text-muted);
  font-size: 0.6875rem;
}

[data-agent-ui="file-tree-empty-create"] {
  padding: 0.3rem 0.75rem;
  background: rgba(99, 102, 241, 0.15);
  color: var(--agent-ui-accent, #a5b4fc);
  border: 0;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.625rem;
}

[data-agent-ui="file-tree-rename-input"],
[data-agent-ui="file-tree-new-file-input"] {
  flex: 1;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(99, 102, 241, 0.5);
  border-radius: 3px;
  padding: 0.15rem 0.3rem;
  font-family: inherit;
  font-size: 0.6875rem;
  color: var(--agent-ui-text);
  outline: none;
}

/* Context menu + delete confirm ---------------------------------- */

[data-agent-ui="file-tree-context-menu"] {
  position: fixed;
  z-index: 50;
  background: var(--agent-ui-bg-elevated, #1f2937);
  border: 1px solid var(--agent-ui-border);
  border-radius: 6px;
  padding: 0.25rem 0;
  min-width: 8rem;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
}

[data-agent-ui="file-tree-context-item"] {
  display: block;
  width: 100%;
  padding: 0.35rem 0.75rem;
  background: transparent;
  border: 0;
  text-align: left;
  color: var(--agent-ui-text);
  cursor: pointer;
  font-family: inherit;
  font-size: 0.6875rem;
}

[data-agent-ui="file-tree-context-item"]:hover {
  background: rgba(255, 255, 255, 0.06);
}

[data-agent-ui="file-tree-context-item"][data-danger]:hover {
  color: #fca5a5;
}

[data-agent-ui="file-tree-delete-confirm"] {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
}

[data-agent-ui="file-tree-delete-dialog"] {
  max-width: 22rem;
  background: var(--agent-ui-bg-elevated, #1f2937);
  border: 1px solid var(--agent-ui-border);
  border-radius: 8px;
  padding: 1.25rem;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

[data-agent-ui="file-tree-delete-dialog"] h3 {
  margin: 0 0 0.5rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

[data-agent-ui="file-tree-delete-dialog"] p {
  margin: 0 0 1rem;
  color: var(--agent-ui-text-muted);
  font-size: 0.6875rem;
}

[data-agent-ui="file-tree-delete-actions"] {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

[data-agent-ui="file-tree-delete-cancel"],
[data-agent-ui="file-tree-delete-confirm-button"] {
  padding: 0.35rem 0.75rem;
  border-radius: 4px;
  border: 0;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.625rem;
}

[data-agent-ui="file-tree-delete-cancel"] {
  background: transparent;
  color: var(--agent-ui-text-muted);
  border: 1px solid var(--agent-ui-border);
}

[data-agent-ui="file-tree-delete-confirm-button"] {
  background: rgba(239, 68, 68, 0.2);
  color: #fca5a5;
}

/* Editor --------------------------------------------------------- */

[data-agent-ui="file-editor"] {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

[data-agent-ui="file-editor-toolbar"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--agent-ui-border);
  min-height: 2rem;
}

[data-agent-ui="file-editor-breadcrumb"] {
  font-family: inherit;
  font-size: 0.625rem;
  color: var(--agent-ui-text-muted);
}

[data-agent-ui="file-editor-actions"] {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

[data-agent-ui="file-editor-dirty"] {
  font-size: 0.5625rem;
  color: #fbbf24;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

[data-agent-ui="file-editor-conflict"] {
  font-size: 0.5625rem;
  color: #fca5a5;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

[data-agent-ui="file-editor-save"],
[data-agent-ui="file-editor-reload"] {
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
  border: 0;
  background: rgba(99, 102, 241, 0.15);
  color: var(--agent-ui-accent, #a5b4fc);
  font-family: inherit;
  font-size: 0.625rem;
  cursor: pointer;
}

[data-agent-ui="file-editor-save"]:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

[data-agent-ui="file-editor-reload"] {
  background: rgba(251, 191, 36, 0.2);
  color: #fcd34d;
}

[data-agent-ui="file-editor-surface"] {
  flex: 1;
  overflow: hidden;
}

[data-agent-ui="file-editor-placeholder"] {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--agent-ui-text-muted);
  padding: 1rem;
  text-align: center;
  font-size: 0.6875rem;
}

/* CodeMirror surface — let the editor use its own monospace stack */
[data-agent-ui="file-editor-surface"] .cm-editor {
  font-family: "SF Mono", "Fira Code", "JetBrains Mono", ui-monospace, monospace;
}
`;
