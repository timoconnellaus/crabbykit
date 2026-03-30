import type { AgentContext } from "@claw-for-cloudflare/agent-runtime";
import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";
import { describe, expect, it, vi } from "vitest";
import { vibeCoder } from "../capability.js";

function mockProvider(): SandboxProvider {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ready: true }),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    setDevPort: vi.fn().mockResolvedValue(undefined),
    clearDevPort: vi.fn().mockResolvedValue(undefined),
  };
}

function mockContext(): AgentContext {
  return {
    sessionId: "test-session",
    stepNumber: 0,
    emitCost: () => {},
    broadcast: vi.fn(),
    broadcastToAll: vi.fn(),
    requestFromClient: vi.fn().mockResolvedValue({}),
    schedules: {
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(null),
      setTimer: vi.fn().mockResolvedValue(undefined),
      cancelTimer: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue(new Map()),
    },
  };
}

describe("vibeCoder", () => {
  it("has correct id and name", () => {
    const cap = vibeCoder({ provider: mockProvider() });
    expect(cap.id).toBe("vibe-coder");
    expect(cap.name).toBe("Vibe Coder");
  });

  it("provides show_preview, hide_preview, and get_console_logs tools", () => {
    const cap = vibeCoder({ provider: mockProvider() });
    const tools = cap.tools!(mockContext());
    const names = tools.map((t) => t.name);
    expect(names).toContain("show_preview");
    expect(names).toContain("hide_preview");
    expect(names).toContain("get_console_logs");
    expect(tools).toHaveLength(3);
  });

  it("provides prompt sections", () => {
    const cap = vibeCoder({ provider: mockProvider() });
    const sections = cap.promptSections!(mockContext());
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("show_preview");
    expect(sections[0]).toContain("get_console_logs");
  });

  it("has onConnect hook", () => {
    const cap = vibeCoder({ provider: mockProvider() });
    expect(cap.hooks?.onConnect).toBeInstanceOf(Function);
  });

  describe("show_preview tool", () => {
    it("calls provider.setDevPort and broadcasts", async () => {
      const provider = mockProvider();
      const ctx = mockContext();
      const cap = vibeCoder({ provider });
      const tools = cap.tools!(ctx);
      const showPreview = tools.find((t) => t.name === "show_preview")!;
      const result = await showPreview.execute({ port: 5173 }, { toolCallId: "tc1" });
      expect(provider.setDevPort).toHaveBeenCalledWith(5173);
      expect(ctx.storage!.put).toHaveBeenCalledWith("previewPort", 5173);
      expect(ctx.broadcast).toHaveBeenCalledWith("preview_open", { port: 5173 });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Preview opened");
    });

    it("returns error when provider lacks setDevPort", async () => {
      const provider = mockProvider();
      // biome-ignore lint/performance/noDelete: test needs to remove optional method
      delete (provider as unknown as Record<string, unknown>).setDevPort;
      const ctx = mockContext();
      const cap = vibeCoder({ provider });
      const tools = cap.tools!(ctx);
      const showPreview = tools.find((t) => t.name === "show_preview")!;
      const result = await showPreview.execute({ port: 5173 }, { toolCallId: "tc1" });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("does not support");
    });
  });

  describe("hide_preview tool", () => {
    it("calls provider.clearDevPort and broadcasts", async () => {
      const provider = mockProvider();
      const ctx = mockContext();
      const cap = vibeCoder({ provider });
      const tools = cap.tools!(ctx);
      const hidePreview = tools.find((t) => t.name === "hide_preview")!;
      const result = await hidePreview.execute({}, { toolCallId: "tc1" });
      expect(provider.clearDevPort).toHaveBeenCalled();
      expect(ctx.storage!.delete).toHaveBeenCalledWith("previewPort");
      expect(ctx.broadcast).toHaveBeenCalledWith("preview_close", {});
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("closed");
    });
  });

  describe("get_console_logs tool", () => {
    it("returns formatted logs from client", async () => {
      const ctx = mockContext();
      (ctx.requestFromClient as ReturnType<typeof vi.fn>).mockResolvedValue({
        logs: [
          { level: "error", text: "Something broke", ts: 1000 },
          { level: "log", text: "Hello world", ts: 1001 },
        ],
      });
      const cap = vibeCoder({ provider: mockProvider() });
      const tools = cap.tools!(ctx);
      const getLogs = tools.find((t) => t.name === "get_console_logs")!;
      const result = await getLogs.execute({}, { toolCallId: "tc1" });
      expect(ctx.requestFromClient).toHaveBeenCalledWith("get_console_logs", { level: "all" });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("[ERROR] Something broke");
      expect(text).toContain("[LOG] Hello world");
    });

    it("passes level filter to client", async () => {
      const ctx = mockContext();
      (ctx.requestFromClient as ReturnType<typeof vi.fn>).mockResolvedValue({ logs: [] });
      const cap = vibeCoder({ provider: mockProvider() });
      const tools = cap.tools!(ctx);
      const getLogs = tools.find((t) => t.name === "get_console_logs")!;
      await getLogs.execute({ level: "error" }, { toolCallId: "tc1" });
      expect(ctx.requestFromClient).toHaveBeenCalledWith("get_console_logs", { level: "error" });
    });

    it("returns 'no logs' when empty", async () => {
      const ctx = mockContext();
      (ctx.requestFromClient as ReturnType<typeof vi.fn>).mockResolvedValue({ logs: [] });
      const cap = vibeCoder({ provider: mockProvider() });
      const tools = cap.tools!(ctx);
      const getLogs = tools.find((t) => t.name === "get_console_logs")!;
      const result = await getLogs.execute({}, { toolCallId: "tc1" });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("No console logs");
    });

    it("handles client error response", async () => {
      const ctx = mockContext();
      (ctx.requestFromClient as ReturnType<typeof vi.fn>).mockResolvedValue({
        _error: true,
        message: "No handler",
      });
      const cap = vibeCoder({ provider: mockProvider() });
      const tools = cap.tools!(ctx);
      const getLogs = tools.find((t) => t.name === "get_console_logs")!;
      const result = await getLogs.execute({}, { toolCallId: "tc1" });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Could not retrieve logs");
    });

    it("handles timeout error", async () => {
      const ctx = mockContext();
      (ctx.requestFromClient as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Timed out"));
      const cap = vibeCoder({ provider: mockProvider() });
      const tools = cap.tools!(ctx);
      const getLogs = tools.find((t) => t.name === "get_console_logs")!;
      const result = await getLogs.execute({}, { toolCallId: "tc1" });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Failed to retrieve console logs");
      expect(text).toContain("Timed out");
    });
  });

  describe("onConnect hook", () => {
    it("broadcasts preview_close when no port stored", async () => {
      const cap = vibeCoder({ provider: mockProvider() });
      const hookCtx = {
        sessionId: "test",
        sessionStore: {} as any,
        storage: {
          get: vi.fn().mockResolvedValue(undefined),
          put: vi.fn(),
          delete: vi.fn(),
          list: vi.fn(),
        },
        broadcast: vi.fn(),
      };
      await cap.hooks!.onConnect!(hookCtx);
      expect(hookCtx.broadcast).toHaveBeenCalledWith("preview_close", {});
    });

    it("re-establishes preview when port stored and container healthy", async () => {
      const provider = mockProvider();
      const cap = vibeCoder({ provider });
      const hookCtx = {
        sessionId: "test",
        sessionStore: {} as any,
        storage: {
          get: vi.fn().mockResolvedValue(5173),
          put: vi.fn(),
          delete: vi.fn(),
          list: vi.fn(),
        },
        broadcast: vi.fn(),
      };
      await cap.hooks!.onConnect!(hookCtx);
      expect(provider.setDevPort).toHaveBeenCalledWith(5173);
      expect(hookCtx.broadcast).toHaveBeenCalledWith("preview_open", { port: 5173 });
    });

    it("clears stale state when container is dead", async () => {
      const provider = mockProvider();
      (provider.health as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Connection refused"),
      );
      const cap = vibeCoder({ provider });
      const hookCtx = {
        sessionId: "test",
        sessionStore: {} as any,
        storage: {
          get: vi.fn().mockResolvedValue(5173),
          put: vi.fn(),
          delete: vi.fn().mockResolvedValue(false),
          list: vi.fn(),
        },
        broadcast: vi.fn(),
      };
      await cap.hooks!.onConnect!(hookCtx);
      expect(hookCtx.storage.delete).toHaveBeenCalledWith("previewPort");
      expect(hookCtx.broadcast).toHaveBeenCalledWith("preview_close", {});
    });
  });
});
