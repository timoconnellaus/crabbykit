import { useCallback, useState } from "react";

export interface BrowserPanelProps {
  /** Browserbase live debug viewer URL to embed. */
  debuggerFullscreenUrl: string;
  /** Current page URL (displayed in the URL bar). */
  pageUrl?: string;
  /** Called when the user clicks the close button. */
  onClose?: () => void;
  /** Whether the client is connected to the server. */
  connected?: boolean;
  /** If set, the browser was auto-closed due to a timeout. */
  timeoutReason?: "idle" | "max_duration";
}

/** Human-readable label for a timeout reason. */
function timeoutLabel(reason: "idle" | "max_duration"): string {
  return reason === "idle"
    ? "Browser closed due to inactivity"
    : "Browser closed — maximum session duration reached";
}

/**
 * Embedded browser live view panel.
 * Shows a Browserbase debug viewer in an iframe with a URL bar and close button.
 * Uses `data-agent-ui` attribute selectors for styling.
 */
export function BrowserPanel({
  debuggerFullscreenUrl,
  pageUrl,
  onClose,
  connected = true,
  timeoutReason,
}: BrowserPanelProps) {
  const [loaded, setLoaded] = useState(false);

  const handleIframeLoad = useCallback(() => {
    setLoaded(true);
  }, []);

  return (
    <div data-agent-ui="browser-panel">
      <div data-agent-ui="browser-panel-toolbar">
        <div data-agent-ui="browser-panel-url-bar">
          <span data-agent-ui="browser-panel-url-icon">🌐</span>
          <span data-agent-ui="browser-panel-url-text">{pageUrl ?? "about:blank"}</span>
        </div>
        {onClose && (
          <button
            type="button"
            data-agent-ui="browser-panel-close-btn"
            onClick={onClose}
            title="Close browser"
          >
            ✕
          </button>
        )}
      </div>
      <div data-agent-ui="browser-panel-iframe-container">
        {!loaded && <div data-agent-ui="browser-panel-loading">Loading browser...</div>}
        {!connected && <div data-agent-ui="browser-panel-disconnected">Lost Connection</div>}
        {timeoutReason && (
          <div data-agent-ui="browser-panel-timeout">{timeoutLabel(timeoutReason)}</div>
        )}
        <iframe
          data-agent-ui="browser-panel-iframe"
          src={debuggerFullscreenUrl}
          title="Browser View"
          onLoad={handleIframeLoad}
          style={{ opacity: loaded ? 1 : 0 }}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      </div>
    </div>
  );
}
