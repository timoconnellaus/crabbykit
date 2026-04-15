import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { useCallback, useEffect, useRef, useState } from "react";

async function getLanguageExtension(filename: string): Promise<Extension | null> {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":
    case "jsx":
    case "ts":
    case "tsx": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ jsx: ext.includes("x"), typescript: ext.startsWith("t") });
    }
    case "md":
    case "markdown": {
      const { markdown } = await import("@codemirror/lang-markdown");
      return markdown();
    }
    case "json": {
      const { json } = await import("@codemirror/lang-json");
      return json();
    }
    case "py":
    case "python": {
      const { python } = await import("@codemirror/lang-python");
      return python();
    }
    case "html":
    case "htm": {
      const { html } = await import("@codemirror/lang-html");
      return html();
    }
    case "css":
    case "scss":
    case "less": {
      const { css } = await import("@codemirror/lang-css");
      return css();
    }
    case "yaml":
    case "yml": {
      const { yaml } = await import("@codemirror/lang-yaml");
      return yaml();
    }
    default:
      return null;
  }
}

export interface FileEditorProps {
  path: string;
  content: string;
  etag: string;
  isBinary: boolean;
  isLarge: boolean;
  largeSize?: number;
  conflict?: boolean;
  onSave: (content: string, etag: string) => Promise<{ etag?: string; conflict?: boolean } | null>;
  onReload: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export function FileEditor({
  path,
  content,
  etag,
  isBinary,
  isLarge,
  largeSize,
  conflict,
  onSave,
  onReload,
  onDirtyChange,
}: FileEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedContentRef = useRef(content);
  const etagRef = useRef(etag);
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    etagRef.current = etag;
  }, [etag]);

  const updateDirty = useCallback(
    (currentContent: string) => {
      const dirty = currentContent !== savedContentRef.current;
      setIsDirty(dirty);
      onDirtyChange?.(dirty);
    },
    [onDirtyChange],
  );

  const handleSave = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    const currentContent = view.state.doc.toString();
    if (currentContent === savedContentRef.current) return;

    setSaving(true);
    try {
      const result = await onSave(currentContent, etagRef.current);
      if (result?.etag) {
        etagRef.current = result.etag;
        savedContentRef.current = currentContent;
        setIsDirty(false);
        onDirtyChange?.(false);
      }
    } finally {
      setSaving(false);
    }
  }, [onSave, onDirtyChange]);

  // Mount CodeMirror
  useEffect(() => {
    if (!containerRef.current || isBinary || isLarge) return;
    const container = containerRef.current;

    savedContentRef.current = content;
    setIsDirty(false);
    onDirtyChange?.(false);

    const saveRef = { current: handleSave };
    let disposed = false;

    const setup = async () => {
      const langExt = await getLanguageExtension(path);
      if (disposed) return;

      const extensions: Extension[] = [
        lineNumbers(),
        history(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        oneDark,
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          {
            key: "Mod-s",
            run: () => {
              saveRef.current();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            updateDirty(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "12px" },
          ".cm-scroller": { overflow: "auto" },
          ".cm-content": {
            fontFamily:
              '"SF Mono", "Fira Code", "JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
          },
        }),
      ];
      if (langExt) extensions.push(langExt);

      const state = EditorState.create({ doc: content, extensions });
      if (viewRef.current) viewRef.current.destroy();

      const view = new EditorView({ state, parent: container });
      viewRef.current = view;
      saveRef.current = handleSave;
    };

    setup();

    return () => {
      disposed = true;
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, [path, content, isBinary, isLarge, handleSave, onDirtyChange, updateDirty]);

  if (isBinary) {
    return (
      <div data-agent-ui="file-editor-placeholder">
        Binary file — cannot be displayed in the editor.
      </div>
    );
  }

  if (isLarge) {
    const sizeLabel = largeSize ? ` (${(largeSize / 1024 / 1024).toFixed(1)} MB)` : "";
    return (
      <div data-agent-ui="file-editor-placeholder">
        File is too large to edit{sizeLabel}. Use the agent's tools to work with this file.
      </div>
    );
  }

  return (
    <div data-agent-ui="file-editor">
      <div data-agent-ui="file-editor-toolbar">
        <div data-agent-ui="file-editor-breadcrumb">{path}</div>
        <div data-agent-ui="file-editor-actions">
          {isDirty && <span data-agent-ui="file-editor-dirty">Unsaved</span>}
          {conflict && <span data-agent-ui="file-editor-conflict">Modified externally</span>}
          {conflict && (
            <button type="button" data-agent-ui="file-editor-reload" onClick={onReload}>
              Reload
            </button>
          )}
          <button
            type="button"
            data-agent-ui="file-editor-save"
            disabled={!isDirty || saving || conflict}
            onClick={handleSave}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <div ref={containerRef} data-agent-ui="file-editor-surface" />
    </div>
  );
}
