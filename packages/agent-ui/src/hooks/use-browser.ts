import { useCallback, useState } from "react";

/** Current browser panel state. */
export interface BrowserState {
  open: boolean;
  debuggerFullscreenUrl?: string;
  pageUrl?: string;
  /** Timestamp (ms) when the idle timer will fire. Updated on open and each tool call. */
  expiresAt?: number;
  /** Idle timeout duration in seconds. */
  timeoutSeconds?: number;
  /** If set, the browser was auto-closed due to a timeout. */
  timeoutReason?: "idle" | "max_duration";
}

/** Return type for the useBrowser hook. */
export interface UseBrowserReturn {
  /** Current browser panel state. */
  browserState: BrowserState;
  /** Close the browser panel (local state only — does NOT send a command to the server). */
  closeBrowser: () => void;
  /**
   * Handle a custom event from the server. Returns true if the event was
   * handled (browser_open, browser_close, browser_timeout), false otherwise.
   */
  handleCustomEvent: (name: string, data: Record<string, unknown>) => boolean;
}

/**
 * Hook that manages browser panel state.
 *
 * Handles browser_open, browser_close, and browser_timeout custom events
 * from the server to show/hide the embedded Browserbase live view.
 */
export function useBrowser(): UseBrowserReturn {
  const [browserState, setBrowserState] = useState<BrowserState>({ open: false });

  const closeBrowser = useCallback(() => {
    setBrowserState({ open: false });
  }, []);

  const handleCustomEvent = useCallback((name: string, data: Record<string, unknown>): boolean => {
    switch (name) {
      case "browser_open":
        setBrowserState({
          open: true,
          debuggerFullscreenUrl: data.debuggerFullscreenUrl as string | undefined,
          pageUrl: data.pageUrl as string | undefined,
        });
        return true;
      case "browser_timeout":
        if (data.reason) {
          // Auto-close notification — the subsequent browser_close will close the panel
          setBrowserState((prev) => ({
            ...prev,
            timeoutReason: data.reason as "idle" | "max_duration",
          }));
        } else {
          // Proactive countdown update (expiresAt + timeoutSeconds)
          setBrowserState((prev) => ({
            ...prev,
            expiresAt: data.expiresAt as number,
            timeoutSeconds: data.timeoutSeconds as number,
          }));
        }
        return true;
      case "browser_close":
        setBrowserState((prev) => ({
          open: false,
          timeoutReason: prev.timeoutReason,
        }));
        return true;
      default:
        return false;
    }
  }, []);

  return {
    browserState,
    closeBrowser,
    handleCustomEvent,
  };
}
