import { memo, useState } from "react";
import {
  formatDuration,
  summarizeResult,
  summarizeToolInput,
  toolColorCategory,
} from "./chat-utils";
import type { ToolResultInfo } from "./message-list";
import {
  HighlightedCode,
  HighlightedDiff,
  extractPath,
  langFromPath,
  parseDiffLines,
} from "./syntax-highlight";

export interface ToolCallEntryProps {
  toolName: string;
  toolCallId: string;
  args?: unknown;
  /** Result info from the tool state / persisted result. */
  result?: ToolResultInfo;
  /** Execution duration in milliseconds. */
  duration?: number;
}

/** Extract a string field from args. */
function argStr(args: unknown, key: string): string | null {
  if (!args || typeof args !== "object") return null;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

export const ToolCallEntry = memo(function ToolCallEntry({
  toolName,
  toolCallId: _toolCallId,
  args,
  result,
  duration,
}: ToolCallEntryProps) {
  const [open, setOpen] = useState(false);
  const category = toolColorCategory(toolName);
  const detail = summarizeToolInput(args);

  const isComplete = result?.status === "complete";
  const isStreaming = result?.status === "streaming";
  const isError = isComplete && result.isError;
  const isRunning = !result || result.status === "executing" || isStreaming;

  const outputText =
    (isComplete && result.content ? result.content : null) ||
    (isStreaming && result.content ? result.content : null);

  const resultSummary = isComplete
    ? summarizeResult(toolName, result.content, result.isError)
    : null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: div used for complex layout with data attributes
    <div
      data-agent-ui="tool-entry"
      data-tool-category={category}
      data-status={result?.status ?? "executing"}
      data-error={isError || undefined}
      data-open={open || undefined}
      role="button"
      tabIndex={0}
      onClick={() => {
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
        setOpen(!open);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen(!open);
        }
      }}
    >
      {/* Collapsed header */}
      <div data-agent-ui="tool-entry-header">
        <span data-agent-ui="tool-entry-indicator" data-cat={category} />
        <span data-agent-ui="tool-entry-name">{toolName}</span>
        {detail && <span data-agent-ui="tool-entry-detail">{detail}</span>}

        {isRunning && <span data-agent-ui="tool-entry-spinner" data-tool-category={category} />}

        {!isRunning && resultSummary && (
          <>
            <span data-agent-ui="tool-entry-sep">{"\u00b7"}</span>
            <span data-agent-ui="tool-entry-result" data-variant={resultSummary.variant}>
              {resultSummary.text}
            </span>
          </>
        )}

        {duration != null && !isRunning && (
          <span data-agent-ui="tool-entry-duration">{formatDuration(duration)}</span>
        )}
      </div>

      {/* Expanded body — tool-specific rendering */}
      {open && (
        <div
          data-agent-ui="tool-entry-body"
          role="none"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {renderToolBody(toolName, args, outputText, isError)}
        </div>
      )}
    </div>
  );
});

/** Render tool-specific expanded body content. */
function renderToolBody(
  toolName: string,
  args: unknown,
  outputText: string | null,
  isError: boolean,
) {
  // ── Exec / shell commands ──
  if (toolName === "exec" || toolName === "bash") {
    return renderExecBody(args, outputText, isError);
  }

  // ── Elevation ──
  if (toolName === "elevate") {
    return renderElevateBody(args, outputText);
  }
  if (toolName === "de_elevate") {
    return renderDeElevateBody(outputText);
  }

  // ── File read ──
  if (toolName === "file_read" && outputText && !isError) {
    return renderFileReadBody(args, outputText);
  }

  // ── File write ──
  if (toolName === "file_write" && !isError) {
    // The tool output is just a confirmation message; the actual content is in args.content
    const writtenContent = argStr(args, "content");
    if (writtenContent) {
      return renderFileWriteBody(args, writtenContent);
    }
  }

  // ── File edit (diff) ──
  if (toolName === "file_edit" && !isError) {
    // Build a diff from args.old_string and args.new_string
    const oldStr = argStr(args, "old_string");
    const newStr = argStr(args, "new_string");
    if (oldStr && newStr) {
      return renderFileEditBodyFromArgs(args, oldStr, newStr);
    }
    // Fallback: if output contains diff markers, render that
    if (outputText) {
      const hasDiff = outputText.includes("\n+") || outputText.includes("\n-");
      if (hasDiff) return renderFileEditBody(args, outputText);
    }
  }

  // ── File copy / move ──
  if ((toolName === "file_copy" || toolName === "file_move") && outputText && !isError) {
    return renderFileCopyMoveBody(args, toolName);
  }

  // ── File tree ──
  if (toolName === "file_tree" && outputText && !isError) {
    return renderFileTreeBody(outputText);
  }

  // ── File list ──
  if (toolName === "file_list" && outputText && !isError) {
    return renderFileTreeBody(outputText);
  }

  // ── Web search ──
  if (toolName === "web_search" && outputText && !isError) {
    return renderWebSearchBody(args, outputText);
  }

  // ── Web fetch ──
  if (toolName === "web_fetch" && outputText && !isError) {
    return renderWebFetchBody(args, outputText);
  }

  // ── Deploy app ──
  if (toolName === "deploy_app" && outputText && !isError) {
    return renderDeployBody(args, outputText);
  }

  // ── Preview tools ──
  if (toolName === "show_preview" && !isError) {
    return renderShowPreviewBody(args);
  }
  if (toolName === "hide_preview" && !isError) {
    return (
      <div data-agent-ui="preview-card">
        <span data-agent-ui="preview-icon">{"\u25A0"}</span>
        <span data-agent-ui="preview-text">Preview closed</span>
      </div>
    );
  }

  // ── Console logs ──
  if (toolName === "get_console_logs" && outputText && !isError) {
    return renderConsoleLogsBody(outputText);
  }

  // ── Start backend ──
  if (toolName === "start_backend" && outputText && !isError) {
    return renderSimpleConfirm("\u26A1", outputText.split("\n")[0]);
  }

  // ── File delete ──
  if (toolName === "file_delete" && !isError) {
    const path = extractPath(args);
    return (
      <div data-agent-ui="action-confirm">
        <span data-agent-ui="action-confirm-icon" data-danger={true}>{"\u2715"}</span>
        <span data-agent-ui="action-confirm-text">{path ?? "File deleted"}</span>
      </div>
    );
  }

  // ── File find ──
  if (toolName === "file_find" && outputText && !isError) {
    return renderFileFindBody(args, outputText);
  }

  // ── Credentials ──
  if (toolName === "save_file_credential" && !isError) {
    const path = argStr(args, "path");
    return (
      <div data-agent-ui="action-confirm">
        <span data-agent-ui="action-confirm-icon">{"\uD83D\uDD12"}</span>
        <span data-agent-ui="action-confirm-text">
          Saved <strong>{path ?? "credential"}</strong>
        </span>
      </div>
    );
  }
  if (toolName === "delete_file_credential" && !isError) {
    const path = argStr(args, "path");
    return (
      <div data-agent-ui="action-confirm">
        <span data-agent-ui="action-confirm-icon">{"\uD83D\uDD12"}</span>
        <span data-agent-ui="action-confirm-text">
          Deleted <strong>{path ?? "credential"}</strong>
        </span>
      </div>
    );
  }
  if (toolName === "list_file_credentials" && outputText && !isError) {
    return renderOutputAsMonospace(outputText);
  }

  // ── App management ──
  if (toolName === "list_apps" && outputText && !isError) {
    return renderOutputAsMonospace(outputText);
  }
  if (toolName === "get_app_history" && outputText && !isError) {
    return renderOutputAsMonospace(outputText);
  }
  if (toolName === "rollback_app" && outputText && !isError) {
    // Parse: "Rolled back App Name to vN\nCommit: abc123 — message"
    const lines = outputText.split("\n");
    return (
      <div data-agent-ui="action-confirm">
        <span data-agent-ui="action-confirm-icon">{"\u21BA"}</span>
        <span data-agent-ui="action-confirm-text">
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Static lines
            <div key={i}>{line}</div>
          ))}
        </span>
      </div>
    );
  }
  if (toolName === "delete_app" && outputText && !isError) {
    return (
      <div data-agent-ui="action-confirm">
        <span data-agent-ui="action-confirm-icon" data-danger={true}>{"\u2715"}</span>
        <span data-agent-ui="action-confirm-text">{outputText.split("\n")[0]}</span>
      </div>
    );
  }

  // ── Memory tools ──
  if (toolName === "memory_write" && !isError) {
    return renderMemoryWriteBody(args, outputText);
  }
  if (toolName === "memory_read" && outputText && !isError) {
    return renderMemoryReadBody(args, outputText);
  }
  if (toolName === "memory_search" && outputText && !isError) {
    return renderOutputAsMonospace(outputText);
  }
  if (toolName === "memory_get" && outputText && !isError) {
    return renderMemoryReadBody(args, outputText);
  }

  // ── Process tool ──
  if (toolName === "process" && outputText) {
    return renderProcessBody(args, outputText, isError);
  }

  // ── Default fallback ──
  return renderDefaultBody(args, outputText, isError);
}

// ─── EXEC ───────────────────────────────────────────────────────────────────

function renderExecBody(args: unknown, outputText: string | null, isError: boolean) {
  const command = argStr(args, "command");
  const exitMatch = outputText?.match(/\[exit code: (\d+)\]/);
  const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : null;

  return (
    <>
      {command && (
        <div data-agent-ui="exec-input">
          <span data-agent-ui="exec-prompt">$</span>
          <span data-agent-ui="exec-command">{command}</span>
        </div>
      )}
      {outputText && (
        <pre data-agent-ui="exec-output" data-error={isError || undefined}>
          {outputText}
          {exitCode !== null && (
            <>
              {"\n"}
              <span
                data-agent-ui="exit-code-badge"
                data-exit-ok={exitCode === 0 || undefined}
                data-exit-err={exitCode !== 0 || undefined}
              >
                exit {exitCode}
              </span>
            </>
          )}
        </pre>
      )}
    </>
  );
}

// ─── ELEVATE / DE_ELEVATE ───────────────────────────────────────────────────

function renderElevateBody(args: unknown, _outputText: string | null) {
  const reason = argStr(args, "reason");
  const obj = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const timeout = typeof obj.timeout === "number" ? obj.timeout : null;

  return (
    <div data-agent-ui="elevation-card">
      <span data-agent-ui="elevation-icon">{"\u26A1"}</span>
      <span data-agent-ui="elevation-text">
        Shell access granted{reason ? <> &mdash; <strong>{reason}</strong></> : null}
      </span>
      {timeout && (
        <span data-agent-ui="elevation-timeout">auto-off in {formatTimeout(timeout)}</span>
      )}
    </div>
  );
}

function formatTimeout(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m`;
}

function renderDeElevateBody(_outputText: string | null) {
  return (
    <div data-agent-ui="elevation-card">
      <span data-agent-ui="elevation-icon">{"\u23F9"}</span>
      <span data-agent-ui="elevation-text">Sandbox deactivated</span>
    </div>
  );
}

// ─── FILE READ ──────────────────────────────────────────────────────────────

function renderFileReadBody(args: unknown, outputText: string) {
  const filePath = extractPath(args);
  const lang = filePath ? langFromPath(filePath) : null;
  return <HighlightedCode code={outputText} lang={lang} lineNumbers maxHeight={400} />;
}

// ─── FILE WRITE ─────────────────────────────────────────────────────────────

function renderFileWriteBody(args: unknown, outputText: string) {
  const filePath = extractPath(args);
  const lang = filePath ? langFromPath(filePath) : null;
  const byteCount = new Blob([outputText]).size;

  return (
    <>
      {filePath && (
        <div data-agent-ui="file-write-header">
          <span data-agent-ui="file-write-icon">{"\u271A"}</span>
          <span data-agent-ui="file-write-path">{filePath}</span>
          <span data-agent-ui="file-write-size">{formatBytes(byteCount)}</span>
        </div>
      )}
      <HighlightedCode code={outputText} lang={lang} lineNumbers maxHeight={320} />
    </>
  );
}

// ─── FILE EDIT ──────────────────────────────────────────────────────────────

function renderFileEditBody(args: unknown, outputText: string) {
  const filePath = extractPath(args);
  const lang = filePath ? langFromPath(filePath) : null;
  const diffLines = parseDiffLines(outputText);

  return (
    <>
      {filePath && (
        <div data-agent-ui="diff-meta">
          <span data-agent-ui="diff-meta-path">{filePath}</span>
        </div>
      )}
      <HighlightedDiff lines={diffLines} lang={lang} maxHeight={400} />
    </>
  );
}

/** Build diff lines from old_string/new_string args (not a unified diff, just the replacement). */
function renderFileEditBodyFromArgs(args: unknown, oldStr: string, newStr: string) {
  const filePath = extractPath(args);
  const lang = filePath ? langFromPath(filePath) : null;

  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  const diffLines = [
    ...oldLines.map((line): { type: "add" | "remove" | "context"; content: string } => ({
      type: "remove",
      content: line,
    })),
    ...newLines.map((line): { type: "add" | "remove" | "context"; content: string } => ({
      type: "add",
      content: line,
    })),
  ];

  return (
    <>
      {filePath && (
        <div data-agent-ui="diff-meta">
          <span data-agent-ui="diff-meta-path">{filePath}</span>
        </div>
      )}
      <HighlightedDiff lines={diffLines} lang={lang} maxHeight={400} />
    </>
  );
}

// ─── FILE COPY / MOVE ───────────────────────────────────────────────────────

function renderFileCopyMoveBody(args: unknown, _toolName: string) {
  const obj = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const source = typeof obj.source === "string" ? obj.source : "?";
  const dest = typeof obj.destination === "string" ? obj.destination : "?";

  return (
    <div data-agent-ui="file-op-confirm">
      <span data-agent-ui="file-op-path">{source}</span>
      <span data-agent-ui="file-op-arrow">{"\u2192"}</span>
      <span data-agent-ui="file-op-path">{dest}</span>
    </div>
  );
}

// ─── FILE TREE / FILE LIST ──────────────────────────────────────────────────

function renderFileTreeBody(outputText: string) {
  return (
    <pre data-agent-ui="file-tree-output">
      {outputText.split("\n").map((line, i) => {
        const isDir = line.trimEnd().endsWith("/");
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: Tree lines have no stable ID
          <div key={i} data-agent-ui={isDir ? "file-tree-dir-line" : "file-tree-file-line"}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}

// ─── WEB SEARCH ─────────────────────────────────────────────────────────────

function renderWebSearchBody(args: unknown, outputText: string) {
  const query = argStr(args, "query");

  // Parse numbered results from the formatted output
  const results = parseSearchResults(outputText);

  return (
    <div data-agent-ui="search-results">
      {query && (
        <div data-agent-ui="search-query">
          <span data-agent-ui="search-query-icon">{"\uD83D\uDD0D"}</span>
          {query}
        </div>
      )}
      {results.length > 0
        ? results.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Search results have no stable ID
            <div key={i} data-agent-ui="search-result">
              <div data-agent-ui="search-result-title">{r.title}</div>
              <div data-agent-ui="search-result-url">{r.url}</div>
              {r.snippet && <div data-agent-ui="search-result-snippet">{r.snippet}</div>}
            </div>
          ))
        : (
          <pre data-agent-ui="tool-entry-output">{outputText}</pre>
        )}
    </div>
  );
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseSearchResults(text: string): SearchResult[] {
  const results: SearchResult[] = [];
  // Format: "N. **Title**\n   URL\n   snippet"
  const blocks = text.split(/\n(?=\d+\.\s)/);
  for (const block of blocks) {
    const titleMatch = block.match(/\d+\.\s+\*\*(.+?)\*\*/);
    if (!titleMatch) continue;
    const lines = block.split("\n").map((l) => l.trim());
    const url = lines[1] ?? "";
    const snippet = lines.slice(2).join(" ").trim();
    results.push({ title: titleMatch[1], url, snippet });
  }
  return results;
}

// ─── WEB FETCH ──────────────────────────────────────────────────────────────

function renderWebFetchBody(args: unknown, outputText: string) {
  const url = argStr(args, "url");
  const isJson = outputText.trimStart().startsWith("{") || outputText.trimStart().startsWith("[");
  const lang = isJson ? "json" : null;

  return (
    <>
      {url && (
        <div data-agent-ui="fetch-url">
          <span data-agent-ui="fetch-badge">GET</span>
          <span>{url}</span>
        </div>
      )}
      {isJson ? (
        <HighlightedCode code={outputText} lang={lang} lineNumbers={false} maxHeight={320} />
      ) : (
        <pre data-agent-ui="tool-entry-output">{outputText}</pre>
      )}
    </>
  );
}

// ─── DEPLOY APP ─────────────────────────────────────────────────────────────

function renderDeployBody(args: unknown, outputText: string) {
  const name = argStr(args, "name");
  const slug = argStr(args, "slug");
  // Parse version and URL from output text
  const versionMatch = outputText.match(/Version:\s*v(\d+)/);
  const urlMatch = outputText.match(/URL:\s*(\S+)/);
  const commitMatch = outputText.match(/Commit:\s*(\w+)\s*[—-]\s*(.+)/);
  const filesMatch = outputText.match(/Files:\s*(\d+)/);
  const hasBackend = outputText.includes("Backend:");

  return (
    <div data-agent-ui="deploy-card">
      <div data-agent-ui="deploy-card-header">
        <span data-agent-ui="deploy-app-name">{name ?? slug ?? "App"}</span>
        {versionMatch && <span data-agent-ui="deploy-badge" data-badge-type="version">v{versionMatch[1]}</span>}
        {hasBackend && <span data-agent-ui="deploy-badge" data-badge-type="backend">full-stack</span>}
      </div>
      <div data-agent-ui="deploy-meta">
        {commitMatch && (
          <span data-agent-ui="deploy-meta-item">
            <strong>{commitMatch[1]}</strong> &mdash; {commitMatch[2]}
          </span>
        )}
        {filesMatch && <span data-agent-ui="deploy-meta-item">{filesMatch[1]} assets</span>}
      </div>
      {urlMatch && (
        <a
          href={urlMatch[1]}
          target="_blank"
          rel="noopener noreferrer"
          data-agent-ui="deploy-url"
        >
          <span>{"\u2197"}</span> {urlMatch[1]}
        </a>
      )}
    </div>
  );
}

// ─── PREVIEW ────────────────────────────────────────────────────────────────

function renderShowPreviewBody(args: unknown) {
  const obj = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const port = typeof obj.port === "number" ? obj.port : null;

  return (
    <div data-agent-ui="preview-card">
      <span data-agent-ui="preview-icon">{"\u25B6"}</span>
      <span data-agent-ui="preview-text">Live preview opened</span>
      {port && <span data-agent-ui="preview-port">:{port}</span>}
    </div>
  );
}

// ─── CONSOLE LOGS ───────────────────────────────────────────────────────────

function renderConsoleLogsBody(outputText: string) {
  const lines = outputText.split("\n").filter((l) => l.length > 0);

  return (
    <pre data-agent-ui="console-logs">
      {lines.map((line, i) => {
        const levelMatch = line.match(/^\[(\w+)\]\s*(.*)/);
        if (levelMatch) {
          const level = levelMatch[1].toLowerCase();
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: Log lines have no stable ID
            <div key={i} data-agent-ui="console-log-line">
              <span data-agent-ui="console-log-level" data-log-level={level}>
                {levelMatch[1]}
              </span>
              <span data-agent-ui="console-log-text">{levelMatch[2]}</span>
            </div>
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: Log lines have no stable ID
          <div key={i} data-agent-ui="console-log-line">
            <span data-agent-ui="console-log-text">{line}</span>
          </div>
        );
      })}
    </pre>
  );
}

// ─── FILE FIND ──────────────────────────────────────────────────────────────

function renderFileFindBody(args: unknown, outputText: string) {
  const pattern = argStr(args, "pattern");

  return (
    <>
      {pattern && (
        <div data-agent-ui="file-find-pattern">
          <span data-agent-ui="file-find-badge">glob</span>
          <span>{pattern}</span>
        </div>
      )}
      <pre data-agent-ui="file-find-results">
        {outputText.split("\n").filter((l) => l.length > 0).map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Match lines have no stable ID
          <div key={i} data-agent-ui="file-find-match">{line}</div>
        ))}
      </pre>
    </>
  );
}

// ─── MEMORY ─────────────────────────────────────────────────────────────────

function renderMemoryWriteBody(args: unknown, _outputText: string | null) {
  const key = argStr(args, "key") ?? argStr(args, "id");
  const content = argStr(args, "content") ?? argStr(args, "value");

  return (
    <div data-agent-ui="memory-card">
      {key && <div data-agent-ui="memory-key">{key}</div>}
      {content && <div data-agent-ui="memory-content">{content}</div>}
    </div>
  );
}

function renderMemoryReadBody(args: unknown, outputText: string) {
  const key = argStr(args, "key") ?? argStr(args, "id");

  return (
    <div data-agent-ui="memory-card">
      {key && <div data-agent-ui="memory-key">{key}</div>}
      <div data-agent-ui="memory-content">{outputText}</div>
    </div>
  );
}

// ─── SIMPLE CONFIRMATIONS ───────────────────────────────────────────────────

function renderSimpleConfirm(icon: string, text: string, danger?: boolean) {
  return (
    <div data-agent-ui="action-confirm">
      <span data-agent-ui="action-confirm-icon" data-danger={danger || undefined}>{icon}</span>
      <span data-agent-ui="action-confirm-text">{text}</span>
    </div>
  );
}

function renderOutputAsMonospace(outputText: string) {
  return (
    <pre data-agent-ui="exec-output">{outputText}</pre>
  );
}

// ─── PROCESS ────────────────────────────────────────────────────────────────

function renderProcessBody(_args: unknown, outputText: string, isError: boolean) {
  return (
    <pre data-agent-ui="exec-output" data-error={isError || undefined}>
      {outputText}
    </pre>
  );
}

// ─── DEFAULT ────────────────────────────────────────────────────────────────

function renderDefaultBody(args: unknown, outputText: string | null, isError: boolean) {
  return (
    <>
      {args != null && (
        <>
          <div data-agent-ui="tool-entry-section-label">input</div>
          <pre data-agent-ui="tool-entry-input">
            {typeof args === "string" ? args : JSON.stringify(args, null, 2)}
          </pre>
        </>
      )}

      {outputText && (
        <>
          <div data-agent-ui="tool-entry-section-label">output</div>
          <pre data-agent-ui="tool-entry-output" data-error={isError || undefined}>
            {outputText}
          </pre>
        </>
      )}

      {isError && !outputText && (
        <div data-agent-ui="tool-entry-error">Error</div>
      )}
    </>
  );
}

// ─── UTILS ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
