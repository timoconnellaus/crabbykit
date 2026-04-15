import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useBrowser } from "./use-browser";

describe("useBrowser", () => {
  it("starts with browser closed", () => {
    const { result } = renderHook(() => useBrowser());
    expect(result.current.browserState.open).toBe(false);
    expect(result.current.browserState.timeoutReason).toBeUndefined();
  });

  it("handles browser_open event", () => {
    const { result } = renderHook(() => useBrowser());
    act(() => {
      const handled = result.current.handleCustomEvent("browser_open", {
        debuggerFullscreenUrl: "https://debug.bb.com/full",
        pageUrl: "https://example.com",
      });
      expect(handled).toBe(true);
    });
    expect(result.current.browserState.open).toBe(true);
    expect(result.current.browserState.debuggerFullscreenUrl).toBe("https://debug.bb.com/full");
    expect(result.current.browserState.pageUrl).toBe("https://example.com");
  });

  it("handles browser_close event", () => {
    const { result } = renderHook(() => useBrowser());
    act(() => {
      result.current.handleCustomEvent("browser_open", {
        debuggerFullscreenUrl: "https://debug.bb.com/full",
      });
    });
    act(() => {
      const handled = result.current.handleCustomEvent("browser_close", {});
      expect(handled).toBe(true);
    });
    expect(result.current.browserState.open).toBe(false);
  });

  it("handles browser_timeout then browser_close sequence", () => {
    const { result } = renderHook(() => useBrowser());
    // Open browser
    act(() => {
      result.current.handleCustomEvent("browser_open", {
        debuggerFullscreenUrl: "https://debug.bb.com/full",
      });
    });
    // Timeout event arrives first
    act(() => {
      const handled = result.current.handleCustomEvent("browser_timeout", {
        reason: "idle",
      });
      expect(handled).toBe(true);
    });
    // Browser is still "open" (timeout sets reason, close event closes panel)
    expect(result.current.browserState.timeoutReason).toBe("idle");

    // Then browser_close arrives
    act(() => {
      result.current.handleCustomEvent("browser_close", {});
    });
    expect(result.current.browserState.open).toBe(false);
    // Timeout reason is preserved so the UI can display it
    expect(result.current.browserState.timeoutReason).toBe("idle");
  });

  it("handles max_duration timeout reason", () => {
    const { result } = renderHook(() => useBrowser());
    act(() => {
      result.current.handleCustomEvent("browser_open", {
        debuggerFullscreenUrl: "https://debug.bb.com/full",
      });
    });
    act(() => {
      result.current.handleCustomEvent("browser_timeout", {
        reason: "max_duration",
      });
    });
    expect(result.current.browserState.timeoutReason).toBe("max_duration");
  });

  it("returns false for unhandled events", () => {
    const { result } = renderHook(() => useBrowser());
    act(() => {
      const handled = result.current.handleCustomEvent("unknown_event", {});
      expect(handled).toBe(false);
    });
  });

  it("handles proactive browser_timeout with expiresAt", () => {
    const { result } = renderHook(() => useBrowser());
    act(() => {
      result.current.handleCustomEvent("browser_open", {
        debuggerFullscreenUrl: "https://debug.bb.com/full",
      });
    });
    const expiresAt = Date.now() + 300_000;
    act(() => {
      const handled = result.current.handleCustomEvent("browser_timeout", {
        expiresAt,
        timeoutSeconds: 300,
      });
      expect(handled).toBe(true);
    });
    expect(result.current.browserState.expiresAt).toBe(expiresAt);
    expect(result.current.browserState.timeoutSeconds).toBe(300);
    // No reason set — this is a proactive countdown, not an auto-close
    expect(result.current.browserState.timeoutReason).toBeUndefined();
  });

  it("updates expiresAt on subsequent timeout events", () => {
    const { result } = renderHook(() => useBrowser());
    act(() => {
      result.current.handleCustomEvent("browser_open", {
        debuggerFullscreenUrl: "https://debug.bb.com/full",
      });
    });
    const first = Date.now() + 300_000;
    act(() => {
      result.current.handleCustomEvent("browser_timeout", {
        expiresAt: first,
        timeoutSeconds: 300,
      });
    });
    const second = Date.now() + 300_000 + 5000;
    act(() => {
      result.current.handleCustomEvent("browser_timeout", {
        expiresAt: second,
        timeoutSeconds: 300,
      });
    });
    expect(result.current.browserState.expiresAt).toBe(second);
  });

  it("closeBrowser closes the panel", () => {
    const { result } = renderHook(() => useBrowser());
    act(() => {
      result.current.handleCustomEvent("browser_open", {
        debuggerFullscreenUrl: "https://debug.bb.com/full",
      });
    });
    act(() => {
      result.current.closeBrowser();
    });
    expect(result.current.browserState.open).toBe(false);
  });
});
