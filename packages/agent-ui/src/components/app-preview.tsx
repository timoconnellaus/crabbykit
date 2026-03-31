import { useCallback, useState } from "react";

export interface ConsoleLogEntry {
  level: "log" | "warn" | "error" | "info";
  text: string;
  ts: number;
}

export interface AppPreviewProps {
  /** URL to load in the preview iframe. */
  previewUrl: string;
  /** Console logs captured from the iframe. */
  logs: ConsoleLogEntry[];
  /** Called when the user clicks the clear logs button. */
  onClearLogs?: () => void;
  /** Current log filter level. */
  logFilter?: "all" | "error" | "warn" | "info" | "log";
  /** Called when the user changes the log filter. */
  onLogFilterChange?: (filter: string) => void;
  /** Called when the user clicks the close preview button. */
  onClose?: () => void;
  /** Whether the client is connected to the server. When false, shows a disconnected overlay. */
  connected?: boolean;
}

const LOG_FILTERS = ["all", "error", "warn", "info", "log"] as const;

/**
 * Live app preview with embedded console panel.
 * Uses `data-agent-ui` attribute selectors for styling.
 */
export function AppPreview({
  previewUrl,
  logs,
  onClearLogs,
  logFilter = "all",
  onLogFilterChange,
  onClose,
  connected = true,
}: AppPreviewProps) {
  const [loaded, setLoaded] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(true);

  const handleIframeLoad = useCallback(() => {
    setLoaded(true);
  }, []);

  const filteredLogs =
    logFilter === "all" ? logs : logs.filter((entry) => entry.level === logFilter);

  const errorCount = logs.filter((l) => l.level === "error").length;
  const warnCount = logs.filter((l) => l.level === "warn").length;

  return (
    <div data-agent-ui="app-preview">
      <div data-agent-ui="app-preview-iframe-container">
        {!loaded && <div data-agent-ui="app-preview-loading">Loading preview...</div>}
        {!connected && (
          <div data-agent-ui="app-preview-disconnected">Lost Connection</div>
        )}
        {onClose && (
          <button
            type="button"
            data-agent-ui="app-preview-close-btn"
            onClick={onClose}
            title="Close preview"
          >
            ✕
          </button>
        )}
        <iframe
          data-agent-ui="app-preview-iframe"
          src={previewUrl}
          title="App Preview"
          onLoad={handleIframeLoad}
          style={{ opacity: loaded ? 1 : 0 }}
        />
      </div>

      <div data-agent-ui="app-preview-console-bar">
        <button
          type="button"
          data-agent-ui="app-preview-console-toggle"
          onClick={() => setConsoleOpen((prev) => !prev)}
        >
          Console
          {errorCount > 0 && (
            <span data-agent-ui="app-preview-badge" data-level="error">
              {errorCount}
            </span>
          )}
          {warnCount > 0 && (
            <span data-agent-ui="app-preview-badge" data-level="warn">
              {warnCount}
            </span>
          )}
        </button>

        {consoleOpen && (
          <div data-agent-ui="app-preview-console-actions">
            <div data-agent-ui="app-preview-filters">
              {LOG_FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  data-agent-ui="app-preview-filter"
                  data-active={f === logFilter || undefined}
                  onClick={() => onLogFilterChange?.(f)}
                >
                  {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
            {onClearLogs && (
              <button type="button" data-agent-ui="app-preview-clear" onClick={onClearLogs}>
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {consoleOpen && (
        <div data-agent-ui="app-preview-console">
          {filteredLogs.length === 0 ? (
            <div data-agent-ui="app-preview-console-empty">No logs</div>
          ) : (
            filteredLogs.map((entry, i) => (
              <div
                key={`${entry.ts}-${i}`}
                data-agent-ui="app-preview-console-entry"
                data-level={entry.level}
              >
                <span data-agent-ui="app-preview-console-level">{entry.level}</span>
                <span data-agent-ui="app-preview-console-text">{entry.text}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
