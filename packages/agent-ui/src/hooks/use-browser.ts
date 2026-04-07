import { useCallback, useState } from "react";

/** Current browser panel state. */
export interface BrowserState {
  open: boolean;
  debuggerFullscreenUrl?: string;
  pageUrl?: string;
}

/** Return type for the useBrowser hook. */
export interface UseBrowserReturn {
  /** Current browser panel state. */
  browserState: BrowserState;
  /** Close the browser panel (local state only — does NOT send a command to the server). */
  closeBrowser: () => void;
  /**
   * Handle a custom event from the server. Returns true if the event was
   * handled (browser_open, browser_close), false otherwise.
   */
  handleCustomEvent: (name: string, data: Record<string, unknown>) => boolean;
}

/**
 * Hook that manages browser panel state.
 *
 * Handles browser_open and browser_close custom events from the server
 * to show/hide the embedded Browserbase live view.
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
      case "browser_close":
        setBrowserState({ open: false });
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
