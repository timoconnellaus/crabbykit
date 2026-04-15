import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsoleLogEntry } from "../components/app-preview";

const MAX_CONSOLE_LOGS = 1000;

/** Return type for the usePreview hook. */
export interface UsePreviewReturn {
  /** Current preview state (open, port, previewBasePath). */
  previewState: { open: boolean; port?: number; previewBasePath?: string };
  /** Console log entries captured from the preview iframe. */
  consoleLogs: ConsoleLogEntry[];
  /** Current log filter level. */
  logFilter: "all" | "error" | "warn" | "info" | "log";
  /** Update the log filter level. */
  setLogFilter: (filter: "all" | "error" | "warn" | "info" | "log") => void;
  /** Clear all captured console logs. */
  clearLogs: () => void;
  /** Close the preview (local state only -- does NOT send a command to the server). */
  closePreview: () => void;
  /**
   * Handle a custom event from the server. Returns true if the event was
   * handled (preview_open, preview_close), false otherwise.
   */
  handleCustomEvent: (name: string, data: Record<string, unknown>) => boolean;
  /**
   * Handle a custom request from the server. Returns a response object
   * if handled (get_console_logs), or null otherwise.
   */
  handleCustomRequest: (
    name: string,
    data: Record<string, unknown>,
  ) => Record<string, unknown> | null;
}

/**
 * Hook that encapsulates all preview-related client-side state and logic.
 *
 * Manages:
 * - Preview open/close state
 * - Console log capture from the preview iframe via postMessage
 * - Log filtering
 * - Custom event/request handling for preview_open, preview_close, get_console_logs
 */
export function usePreview(): UsePreviewReturn {
  const [previewState, setPreviewState] = useState<{
    open: boolean;
    port?: number;
    previewBasePath?: string;
  }>({ open: false });
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLogEntry[]>([]);
  const [logFilter, setLogFilter] = useState<"all" | "error" | "warn" | "info" | "log">("all");

  // Ref for console logs so the request handler always reads latest
  const consoleLogsRef = useRef(consoleLogs);
  consoleLogsRef.current = consoleLogs;

  // Listen for console messages from the preview iframe
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "claw:console") {
        const entry: ConsoleLogEntry = {
          level: event.data.level,
          text: event.data.text,
          ts: event.data.ts,
        };
        setConsoleLogs((prev) => {
          const next = [...prev, entry];
          return next.length > MAX_CONSOLE_LOGS ? next.slice(-MAX_CONSOLE_LOGS) : next;
        });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const clearLogs = useCallback(() => {
    setConsoleLogs([]);
  }, []);

  const closePreview = useCallback(() => {
    setPreviewState({ open: false });
  }, []);

  const handleCustomEvent = useCallback((name: string, data: Record<string, unknown>): boolean => {
    if (name === "preview_open") {
      setPreviewState({
        open: true,
        port: data.port as number,
        previewBasePath: data.previewBasePath as string | undefined,
      });
      setConsoleLogs([]);
      return true;
    }
    if (name === "preview_close") {
      setPreviewState({ open: false });
      return true;
    }
    return false;
  }, []);

  const handleCustomRequest = useCallback(
    (name: string, data: Record<string, unknown>): Record<string, unknown> | null => {
      if (name === "get_console_logs") {
        const level = data.level as string;
        const logs = consoleLogsRef.current;
        const filtered = level === "all" ? logs : logs.filter((l) => l.level === level);
        return { logs: filtered };
      }
      return null;
    },
    [],
  );

  return {
    previewState,
    consoleLogs,
    logFilter,
    setLogFilter,
    clearLogs,
    closePreview,
    handleCustomEvent,
    handleCustomRequest,
  };
}
