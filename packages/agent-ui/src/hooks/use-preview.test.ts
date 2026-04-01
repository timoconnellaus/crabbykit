import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreview } from "./use-preview";

describe("usePreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------
  it("starts with preview closed and empty logs", () => {
    const { result } = renderHook(() => usePreview());
    expect(result.current.previewState).toEqual({ open: false });
    expect(result.current.consoleLogs).toEqual([]);
    expect(result.current.logFilter).toBe("all");
  });

  // ---------------------------------------------------------------------------
  // handleCustomEvent: preview_open / preview_close
  // ---------------------------------------------------------------------------
  describe("handleCustomEvent", () => {
    it("opens preview on preview_open event", () => {
      const { result } = renderHook(() => usePreview());
      act(() => {
        const handled = result.current.handleCustomEvent("preview_open", {
          port: 3000,
          previewBasePath: "/app",
        });
        expect(handled).toBe(true);
      });
      expect(result.current.previewState).toEqual({
        open: true,
        port: 3000,
        previewBasePath: "/app",
      });
    });

    it("clears console logs on preview_open", () => {
      const { result } = renderHook(() => usePreview());
      // Add a log first via postMessage
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "claw:console", level: "log", text: "old", ts: 1 },
          }),
        );
      });
      expect(result.current.consoleLogs).toHaveLength(1);
      act(() => {
        result.current.handleCustomEvent("preview_open", { port: 3000 });
      });
      expect(result.current.consoleLogs).toEqual([]);
    });

    it("closes preview on preview_close event", () => {
      const { result } = renderHook(() => usePreview());
      act(() => {
        result.current.handleCustomEvent("preview_open", { port: 3000 });
      });
      expect(result.current.previewState.open).toBe(true);
      act(() => {
        const handled = result.current.handleCustomEvent("preview_close", {});
        expect(handled).toBe(true);
      });
      expect(result.current.previewState).toEqual({ open: false });
    });

    it("returns false for unknown events", () => {
      const { result } = renderHook(() => usePreview());
      let handled: boolean;
      act(() => {
        handled = result.current.handleCustomEvent("unknown_event", {});
      });
      expect(handled!).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Console log capture via postMessage
  // ---------------------------------------------------------------------------
  describe("console log capture", () => {
    it("captures claw:console messages from window", () => {
      const { result } = renderHook(() => usePreview());
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "claw:console", level: "error", text: "boom", ts: 123 },
          }),
        );
      });
      expect(result.current.consoleLogs).toEqual([
        { level: "error", text: "boom", ts: 123 },
      ]);
    });

    it("ignores non-claw messages", () => {
      const { result } = renderHook(() => usePreview());
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", { data: { type: "other", text: "hi" } }),
        );
      });
      expect(result.current.consoleLogs).toEqual([]);
    });

    it("caps at MAX_CONSOLE_LOGS (1000)", () => {
      const { result } = renderHook(() => usePreview());
      act(() => {
        for (let i = 0; i < 1005; i++) {
          window.dispatchEvent(
            new MessageEvent("message", {
              data: { type: "claw:console", level: "log", text: `msg-${i}`, ts: i },
            }),
          );
        }
      });
      expect(result.current.consoleLogs).toHaveLength(1000);
      // Oldest entries should have been trimmed
      expect(result.current.consoleLogs[0].text).toBe("msg-5");
      expect(result.current.consoleLogs[999].text).toBe("msg-1004");
    });

    it("stops capturing after unmount", () => {
      const { result, unmount } = renderHook(() => usePreview());
      unmount();
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "claw:console", level: "log", text: "after", ts: 1 },
          }),
        );
      });
      expect(result.current.consoleLogs).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // clearLogs / closePreview
  // ---------------------------------------------------------------------------
  describe("clearLogs", () => {
    it("clears all console logs", () => {
      const { result } = renderHook(() => usePreview());
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "claw:console", level: "log", text: "a", ts: 1 },
          }),
        );
      });
      expect(result.current.consoleLogs).toHaveLength(1);
      act(() => {
        result.current.clearLogs();
      });
      expect(result.current.consoleLogs).toEqual([]);
    });
  });

  describe("closePreview", () => {
    it("sets preview state to closed", () => {
      const { result } = renderHook(() => usePreview());
      act(() => {
        result.current.handleCustomEvent("preview_open", { port: 3000 });
      });
      expect(result.current.previewState.open).toBe(true);
      act(() => {
        result.current.closePreview();
      });
      expect(result.current.previewState).toEqual({ open: false });
    });
  });

  // ---------------------------------------------------------------------------
  // handleCustomRequest: get_console_logs
  // ---------------------------------------------------------------------------
  describe("handleCustomRequest", () => {
    it("returns all logs for level=all", () => {
      const { result } = renderHook(() => usePreview());
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "claw:console", level: "error", text: "e", ts: 1 },
          }),
        );
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "claw:console", level: "log", text: "l", ts: 2 },
          }),
        );
      });
      let response: Record<string, unknown> | null;
      act(() => {
        response = result.current.handleCustomRequest("get_console_logs", { level: "all" });
      });
      expect(response!).toEqual({
        logs: [
          { level: "error", text: "e", ts: 1 },
          { level: "log", text: "l", ts: 2 },
        ],
      });
    });

    it("filters logs by level", () => {
      const { result } = renderHook(() => usePreview());
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "claw:console", level: "error", text: "e", ts: 1 },
          }),
        );
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "claw:console", level: "warn", text: "w", ts: 2 },
          }),
        );
      });
      let response: Record<string, unknown> | null;
      act(() => {
        response = result.current.handleCustomRequest("get_console_logs", { level: "error" });
      });
      expect(response!).toEqual({
        logs: [{ level: "error", text: "e", ts: 1 }],
      });
    });

    it("returns null for unknown requests", () => {
      const { result } = renderHook(() => usePreview());
      let response: Record<string, unknown> | null;
      act(() => {
        response = result.current.handleCustomRequest("unknown", {});
      });
      expect(response!).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // setLogFilter
  // ---------------------------------------------------------------------------
  describe("setLogFilter", () => {
    it("updates the log filter", () => {
      const { result } = renderHook(() => usePreview());
      expect(result.current.logFilter).toBe("all");
      act(() => {
        result.current.setLogFilter("error");
      });
      expect(result.current.logFilter).toBe("error");
    });
  });
});
