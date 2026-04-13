import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import { createNoopStorage } from "@claw-for-cloudflare/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import type { SessionManager } from "../session-manager.js";
import { createBrowserClearStateTool } from "../tools/browser-clear-state.js";
import { createBrowserClickTool } from "../tools/browser-click.js";
import { createBrowserCloseTool } from "../tools/browser-close.js";
import { createBrowserNavigateTool } from "../tools/browser-navigate.js";
import { createBrowserOpenTool } from "../tools/browser-open.js";
import { createBrowserScreenshotTool } from "../tools/browser-screenshot.js";
import { createBrowserSnapshotTool } from "../tools/browser-snapshot.js";
import { createBrowserTypeTool } from "../tools/browser-type.js";
import type { RefMap } from "../types.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((c) => c.type === "text");
  return block?.text ?? "";
}

/** Mock CDP client. */
function mockCDP() {
  const responses = new Map<string, unknown>();
  const sent: Array<{ method: string; params?: unknown }> = [];
  const eventHandlers = new Map<string, Set<(p: Record<string, unknown>) => void>>();

  return {
    isConnected: true,
    sent,
    send: vi.fn(async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      sent.push({ method, params });
      return (responses.get(method) ?? {}) as T;
    }),
    on(method: string, handler: (p: Record<string, unknown>) => void) {
      let set = eventHandlers.get(method);
      if (!set) {
        set = new Set();
        eventHandlers.set(method, set);
      }
      set.add(handler);
      // Auto-fire Page.loadEventFired for navigation tests
      if (method === "Page.loadEventFired") {
        setTimeout(() => handler({}), 1);
      }
    },
    off(method: string, handler: (p: Record<string, unknown>) => void) {
      eventHandlers.get(method)?.delete(handler);
    },
    close: vi.fn(),
    setResponse(method: string, val: unknown) {
      responses.set(method, val);
    },
  };
}

function mockContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    agentId: "agent-1",
    sessionId: "session-1",
    stepNumber: 1,
    emitCost: vi.fn(),
    broadcast: vi.fn(),
    broadcastToAll: vi.fn(),
    broadcastState: vi.fn(),
    requestFromClient: vi.fn(),
    schedules: {} as AgentContext["schedules"],
    storage: createNoopStorage(),
    rateLimit: { consume: async () => ({ allowed: true }) },
    ...overrides,
  };
}

describe("browser_open", () => {
  it("returns error when session manager throws", async () => {
    const sm = {
      open: vi.fn().mockRejectedValue(new Error("already open")),
    } as unknown as SessionManager;
    const ctx = mockContext();

    const tool = createBrowserOpenTool(sm, ctx);
    const result = await tool.execute({ url: "https://example.com" }, {} as never);

    expect(textOf(result)).toContain("already open");
  });

  it("broadcasts browser_open on success", async () => {
    const sm = {
      open: vi.fn().mockResolvedValue({
        browserbaseId: "bb-1",
        connectUrl: "wss://...",
        debugUrls: {
          debuggerFullscreenUrl: "https://debug.bb.com/fullscreen",
          pages: [{ url: "https://example.com" }],
        },
        cdp: mockCDP(),
      }),
    } as unknown as SessionManager;
    const ctx = mockContext();

    const tool = createBrowserOpenTool(sm, ctx);
    await tool.execute({ url: "https://example.com" }, {} as never);

    expect(ctx.broadcast).toHaveBeenCalledWith("browser_open", {
      debuggerFullscreenUrl: "https://debug.bb.com/fullscreen",
      pageUrl: "https://example.com",
    });
  });
});

describe("browser_navigate", () => {
  it("returns error when no CDP client", async () => {
    const sm = { getCDP: vi.fn().mockReturnValue(undefined) } as unknown as SessionManager;
    const ctx = mockContext();

    const tool = createBrowserNavigateTool(sm, ctx);
    const result = await tool.execute({ url: "https://example.com" }, {} as never);

    expect(textOf(result)).toContain("No browser is open");
  });

  it("sends Page.navigate via CDP", async () => {
    const cdp = mockCDP();
    const sm = { getCDP: vi.fn().mockReturnValue(cdp) } as unknown as SessionManager;
    const ctx = mockContext();

    const tool = createBrowserNavigateTool(sm, ctx);
    await tool.execute({ url: "https://example.com" }, {} as never);

    expect(cdp.sent.some((c) => c.method === "Page.navigate")).toBe(true);
  });
});

describe("browser_snapshot", () => {
  it("returns error when no CDP", async () => {
    const sm = { getCDP: vi.fn().mockReturnValue(undefined) } as unknown as SessionManager;
    const ctx = mockContext();

    const tool = createBrowserSnapshotTool(sm, ctx);
    const result = await tool.execute({}, {} as never);

    expect(textOf(result)).toContain("No browser is open");
  });

  it("returns formatted AX tree with refs", async () => {
    const cdp = mockCDP();
    cdp.setResponse("Accessibility.getFullAXTree", {
      nodes: [
        {
          nodeId: "1",
          ignored: false,
          role: { type: "role", value: "RootWebArea" },
          childIds: ["2"],
        },
        {
          nodeId: "2",
          ignored: false,
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Submit" },
          backendDOMNodeId: 10,
        },
      ],
    });
    cdp.setResponse("Runtime.evaluate", { result: { value: "https://example.com" } });

    const sm = {
      getCDP: vi.fn().mockReturnValue(cdp),
      setRefs: vi.fn(),
    } as unknown as SessionManager;
    const ctx = mockContext();

    const tool = createBrowserSnapshotTool(sm, ctx);
    const result = await tool.execute({}, {} as never);

    expect(textOf(result)).toContain("button");
    expect(textOf(result)).toContain("[ref=e1]");
    expect(sm.setRefs).toHaveBeenCalled();
  });
});

describe("browser_screenshot", () => {
  it("returns error when no CDP", async () => {
    const sm = { getCDP: vi.fn().mockReturnValue(undefined) } as unknown as SessionManager;
    const ctx = mockContext();

    const tool = createBrowserScreenshotTool(sm, ctx);
    const result = await tool.execute({}, {} as never);

    expect(textOf(result)).toContain("No browser is open");
  });

  it("returns base64 image", async () => {
    const cdp = mockCDP();
    cdp.setResponse("Page.captureScreenshot", { data: "iVBORw0KGgoAAAANS..." });

    const sm = { getCDP: vi.fn().mockReturnValue(cdp) } as unknown as SessionManager;
    const ctx = mockContext();

    const tool = createBrowserScreenshotTool(sm, ctx);
    const result = await tool.execute({}, {} as never);

    const imgBlock = result.content.find((c: { type: string }) => c.type === "image");
    expect(imgBlock).toBeDefined();
  });
});

describe("browser_click", () => {
  it("returns error when no CDP", async () => {
    const sm = {
      getCDP: vi.fn().mockReturnValue(undefined),
      getRefs: vi.fn(),
    } as unknown as SessionManager;
    const ctx = mockContext();

    const tool = createBrowserClickTool(sm, ctx);
    const result = await tool.execute({ ref: "e1" }, {} as never);

    expect(textOf(result)).toContain("No browser is open");
  });

  it("returns error when no snapshot refs", async () => {
    const sm = {
      getCDP: vi.fn().mockReturnValue(mockCDP()),
      getRefs: vi.fn().mockReturnValue(undefined),
    } as unknown as SessionManager;
    const ctx = mockContext();

    const tool = createBrowserClickTool(sm, ctx);
    const result = await tool.execute({ ref: "e1" }, {} as never);

    expect(textOf(result)).toContain("No snapshot");
  });

  it("returns error for unknown ref", async () => {
    const refs: RefMap = {
      e1: { nodeId: "1", backendDOMNodeId: 10, role: "button", name: "Submit" },
    };
    const sm = {
      getCDP: vi.fn().mockReturnValue(mockCDP()),
      getRefs: vi.fn().mockReturnValue(refs),
    } as unknown as SessionManager;
    const ctx = mockContext();

    const tool = createBrowserClickTool(sm, ctx);
    const result = await tool.execute({ ref: "e99" }, {} as never);

    expect(textOf(result)).toContain("Unknown ref");
  });

  it("dispatches mouse events at element center", async () => {
    const cdp = mockCDP();
    cdp.setResponse("DOM.resolveNode", { object: { objectId: "obj-1" } });
    cdp.setResponse("DOM.getContentQuads", {
      quads: [[100, 100, 200, 100, 200, 200, 100, 200]],
    });

    const refs: RefMap = {
      e1: { nodeId: "1", backendDOMNodeId: 10, role: "button", name: "Submit" },
    };
    const sm = {
      getCDP: vi.fn().mockReturnValue(cdp),
      getRefs: vi.fn().mockReturnValue(refs),
    } as unknown as SessionManager;
    const ctx = mockContext();

    const tool = createBrowserClickTool(sm, ctx);
    const result = await tool.execute({ ref: "e1" }, {} as never);

    expect(textOf(result)).toContain("Clicked");
    const mouseEvents = cdp.sent.filter((c) => c.method === "Input.dispatchMouseEvent");
    expect(mouseEvents).toHaveLength(2);
  });
});

describe("browser_type", () => {
  it("returns error when no CDP", async () => {
    const sm = {
      getCDP: vi.fn().mockReturnValue(undefined),
      getRefs: vi.fn(),
    } as unknown as SessionManager;
    const ctx = mockContext();

    const tool = createBrowserTypeTool(sm, ctx);
    const result = await tool.execute({ ref: "e1", text: "hello" }, {} as never);

    expect(textOf(result)).toContain("No browser is open");
  });

  it("focuses element and inserts text", async () => {
    const cdp = mockCDP();
    const refs: RefMap = {
      e1: { nodeId: "1", backendDOMNodeId: 10, role: "textbox", name: "Email" },
    };
    const sm = {
      getCDP: vi.fn().mockReturnValue(cdp),
      getRefs: vi.fn().mockReturnValue(refs),
    } as unknown as SessionManager;
    const ctx = mockContext();

    const tool = createBrowserTypeTool(sm, ctx);
    const result = await tool.execute({ ref: "e1", text: "test@example.com" }, {} as never);

    expect(textOf(result)).toContain("Typed");
    expect(cdp.sent.some((c) => c.method === "DOM.focus")).toBe(true);
    expect(cdp.sent.some((c) => c.method === "Input.insertText")).toBe(true);
  });

  it("sends Enter key when pressEnter is true", async () => {
    const cdp = mockCDP();
    const refs: RefMap = {
      e1: { nodeId: "1", backendDOMNodeId: 10, role: "textbox", name: "Search" },
    };
    const sm = {
      getCDP: vi.fn().mockReturnValue(cdp),
      getRefs: vi.fn().mockReturnValue(refs),
    } as unknown as SessionManager;
    const ctx = mockContext();

    const tool = createBrowserTypeTool(sm, ctx);
    await tool.execute({ ref: "e1", text: "query", pressEnter: true }, {} as never);

    const keyEvents = cdp.sent.filter((c) => c.method === "Input.dispatchKeyEvent");
    expect(keyEvents).toHaveLength(2); // keyDown + keyUp
  });
});

describe("browser_close", () => {
  it("emits cost and broadcasts", async () => {
    const sm = {
      close: vi.fn().mockResolvedValue({ durationMinutes: 5 }),
    } as unknown as SessionManager;
    const ctx = mockContext();

    const tool = createBrowserCloseTool(sm, ctx);
    const result = await tool.execute({}, {} as never);

    expect(textOf(result)).toContain("5 minutes");
    expect(ctx.emitCost).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityId: "browserbase",
        toolName: "browser_close",
        amount: 5 * 0.002,
      }),
    );
    expect(ctx.broadcast).toHaveBeenCalledWith("browser_close", {});
  });

  it("calls onClose callback to cancel timers", async () => {
    const sm = {
      close: vi.fn().mockResolvedValue({ durationMinutes: 2 }),
    } as unknown as SessionManager;
    const ctx = mockContext();
    const onClose = vi.fn();

    const tool = createBrowserCloseTool(sm, ctx, undefined, onClose);
    await tool.execute({}, {} as never);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("browser_open callbacks", () => {
  it("calls onOpen callback after successful open", async () => {
    const sm = {
      open: vi.fn().mockResolvedValue({
        browserbaseId: "bb-1",
        connectUrl: "wss://...",
        debugUrls: {
          debuggerFullscreenUrl: "https://debug.bb.com/fullscreen",
          pages: [{ url: "https://example.com" }],
        },
        cdp: mockCDP(),
      }),
    } as unknown as SessionManager;
    const ctx = mockContext();
    const onOpen = vi.fn();

    const tool = createBrowserOpenTool(sm, ctx, onOpen);
    await tool.execute({ url: "https://example.com" }, {} as never);

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("does not call onOpen on failure", async () => {
    const sm = {
      open: vi.fn().mockRejectedValue(new Error("fail")),
    } as unknown as SessionManager;
    const ctx = mockContext();
    const onOpen = vi.fn();

    const tool = createBrowserOpenTool(sm, ctx, onOpen);
    await tool.execute({}, {} as never);

    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("onActivity callbacks", () => {
  it("browser_navigate calls onActivity", async () => {
    const cdp = mockCDP();
    const sm = { getCDP: vi.fn().mockReturnValue(cdp) } as unknown as SessionManager;
    const ctx = mockContext();
    const onActivity = vi.fn();

    const tool = createBrowserNavigateTool(sm, ctx, onActivity);
    await tool.execute({ url: "https://example.com" }, {} as never);

    expect(onActivity).toHaveBeenCalledTimes(1);
  });

  it("browser_snapshot calls onActivity", async () => {
    const cdp = mockCDP();
    cdp.setResponse("Accessibility.getFullAXTree", {
      nodes: [{ nodeId: "1", ignored: false, role: { type: "role", value: "RootWebArea" } }],
    });
    cdp.setResponse("Runtime.evaluate", { result: { value: "https://example.com" } });
    const sm = {
      getCDP: vi.fn().mockReturnValue(cdp),
      setRefs: vi.fn(),
    } as unknown as SessionManager;
    const ctx = mockContext();
    const onActivity = vi.fn();

    const tool = createBrowserSnapshotTool(sm, ctx, onActivity);
    await tool.execute({}, {} as never);

    expect(onActivity).toHaveBeenCalledTimes(1);
  });

  it("browser_screenshot calls onActivity", async () => {
    const cdp = mockCDP();
    cdp.setResponse("Page.captureScreenshot", { data: "base64data" });
    const sm = { getCDP: vi.fn().mockReturnValue(cdp) } as unknown as SessionManager;
    const ctx = mockContext();
    const onActivity = vi.fn();

    const tool = createBrowserScreenshotTool(sm, ctx, onActivity);
    await tool.execute({}, {} as never);

    expect(onActivity).toHaveBeenCalledTimes(1);
  });

  it("does not call onActivity when no CDP client", async () => {
    const sm = { getCDP: vi.fn().mockReturnValue(undefined) } as unknown as SessionManager;
    const ctx = mockContext();
    const onActivity = vi.fn();

    const tool = createBrowserNavigateTool(sm, ctx, onActivity);
    await tool.execute({ url: "https://example.com" }, {} as never);

    expect(onActivity).not.toHaveBeenCalled();
  });
});

describe("browser_clear_state", () => {
  it("clears all state", async () => {
    const sm = { clearState: vi.fn() } as unknown as SessionManager;

    const tool = createBrowserClearStateTool(sm);
    const result = await tool.execute({}, {} as never);

    expect(textOf(result)).toContain("Cleared all browser state");
    expect(sm.clearState).toHaveBeenCalledWith(undefined);
  });

  it("clears state for specific domain", async () => {
    const sm = { clearState: vi.fn() } as unknown as SessionManager;

    const tool = createBrowserClearStateTool(sm);
    const result = await tool.execute({ domain: "github.com" }, {} as never);

    expect(textOf(result)).toContain("github.com");
    expect(sm.clearState).toHaveBeenCalledWith("github.com");
  });
});
