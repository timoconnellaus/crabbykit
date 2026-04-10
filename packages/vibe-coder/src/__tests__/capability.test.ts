import type { AgentContext, CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/worker-bundler", () => ({
  createWorker: vi.fn().mockResolvedValue({
    mainModule: "index.js",
    modules: { "index.js": "" },
  }),
}));

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

function mockContext(sessionId = "test-session"): AgentContext {
  return {
    agentId: "test-agent",
    sessionId,
    stepNumber: 0,
    emitCost: () => {},
    broadcast: vi.fn(),
    broadcastToAll: vi.fn(),
    broadcastState: vi.fn(),
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
    rateLimit: {
      consume: vi.fn().mockResolvedValue({ allowed: true }),
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

  // promptSections were intentionally removed (commit ce3aa1f) — content moved to vibe-webapp skill.
  it("does not contribute prompt sections", () => {
    const cap = vibeCoder({ provider: mockProvider() });
    expect(cap.promptSections).toBeUndefined();
  });

  it("does not register any slash commands", () => {
    const cap = vibeCoder({ provider: mockProvider() });
    expect(cap.commands).toBeUndefined();
  });

  it("has onConnect hook", () => {
    const cap = vibeCoder({ provider: mockProvider() });
    expect(cap.hooks?.onConnect).toBeInstanceOf(Function);
  });

  describe("show_preview tool", () => {
    it("calls provider.setDevPort and broadcasts", async () => {
      const provider = mockProvider();
      const ctx = mockContext("session-abc");
      const cap = vibeCoder({ provider });
      const tools = cap.tools!(ctx);
      const showPreview = tools.find((t) => t.name === "show_preview")!;
      const result = await showPreview.execute({ port: 5173 }, { toolCallId: "tc1" });
      expect(provider.setDevPort).toHaveBeenCalledWith(5173, "/preview/test-agent/");
      expect(ctx.storage!.put).toHaveBeenCalledWith("preview", {
        port: 5173,
        sessionId: "session-abc",
      });
      expect(ctx.broadcast).toHaveBeenCalledWith("preview_open", {
        port: 5173,
        previewBasePath: "/preview/test-agent/",
      });
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
    it("calls provider.clearDevPort and broadcasts when session owns preview", async () => {
      const provider = mockProvider();
      const ctx = mockContext("session-abc");
      // Mock storage.get to return preview owned by this session
      (ctx.storage!.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        port: 5173,
        sessionId: "session-abc",
      });
      const cap = vibeCoder({ provider });
      const tools = cap.tools!(ctx);
      const hidePreview = tools.find((t) => t.name === "hide_preview")!;
      const result = await hidePreview.execute({}, { toolCallId: "tc1" });
      expect(provider.clearDevPort).toHaveBeenCalled();
      expect(ctx.storage!.delete).toHaveBeenCalledWith("preview");
      expect(ctx.broadcast).toHaveBeenCalledWith("preview_close", {});
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("closed");
    });

    it("rejects when session does not own the preview", async () => {
      const provider = mockProvider();
      const ctx = mockContext("session-xyz");
      // Preview is owned by a different session
      (ctx.storage!.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        port: 5173,
        sessionId: "session-abc",
      });
      const cap = vibeCoder({ provider });
      const tools = cap.tools!(ctx);
      const hidePreview = tools.find((t) => t.name === "hide_preview")!;
      const result = await hidePreview.execute({}, { toolCallId: "tc1" });
      expect(provider.clearDevPort).not.toHaveBeenCalled();
      expect(ctx.storage!.delete).not.toHaveBeenCalled();
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("No active preview");
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

  describe("afterToolExecution hook", () => {
    it("closes preview when owning session de-elevates", async () => {
      const provider = mockProvider();
      const cap = vibeCoder({ provider });
      const hookCtx = {
        agentId: "test-agent",
        sessionId: "session-abc",
        sessionStore: {} as any,
        storage: {
          get: vi.fn().mockResolvedValue({ port: 5173, sessionId: "session-abc" }),
          put: vi.fn(),
          delete: vi.fn().mockResolvedValue(true),
          list: vi.fn(),
        },
        broadcast: vi.fn(),
        capabilityIds: [] as string[],
      };
      await cap.hooks!.afterToolExecution!(
        { toolName: "de_elevate", args: {}, isError: false },
        hookCtx,
      );
      expect(provider.clearDevPort).toHaveBeenCalled();
      expect(hookCtx.storage.delete).toHaveBeenCalledWith("preview");
      expect(hookCtx.broadcast).toHaveBeenCalledWith("preview_close", {});
    });

    it("does NOT close preview when a different session de-elevates", async () => {
      const provider = mockProvider();
      const cap = vibeCoder({ provider });
      const hookCtx = {
        agentId: "test-agent",
        sessionId: "session-xyz", // different session
        sessionStore: {} as any,
        storage: {
          get: vi.fn().mockResolvedValue({ port: 5173, sessionId: "session-abc" }),
          put: vi.fn(),
          delete: vi.fn(),
          list: vi.fn(),
        },
        broadcast: vi.fn(),
        capabilityIds: [] as string[],
      };
      await cap.hooks!.afterToolExecution!(
        { toolName: "de_elevate", args: {}, isError: false },
        hookCtx,
      );
      // Should NOT touch the preview
      expect(provider.clearDevPort).not.toHaveBeenCalled();
      expect(hookCtx.storage.delete).not.toHaveBeenCalled();
      expect(hookCtx.broadcast).not.toHaveBeenCalled();
    });

    it("no-ops for non-de_elevate tools", async () => {
      const provider = mockProvider();
      const cap = vibeCoder({ provider });
      const hookCtx = {
        agentId: "test-agent",
        sessionId: "session-abc",
        sessionStore: {} as any,
        storage: {
          get: vi.fn(),
          put: vi.fn(),
          delete: vi.fn(),
          list: vi.fn(),
        },
        broadcast: vi.fn(),
        capabilityIds: [] as string[],
      };
      await cap.hooks!.afterToolExecution!({ toolName: "exec", args: {}, isError: false }, hookCtx);
      expect(hookCtx.storage.get).not.toHaveBeenCalled();
    });
  });

  describe("onConnect hook", () => {
    it("broadcasts preview_close when no preview stored", async () => {
      const cap = vibeCoder({ provider: mockProvider() });
      const hookCtx = {
        agentId: "test-agent",
        sessionId: "test",
        sessionStore: {} as any,
        storage: {
          get: vi.fn().mockResolvedValue(undefined),
          put: vi.fn(),
          delete: vi.fn(),
          list: vi.fn(),
        },
        broadcast: vi.fn(),
        capabilityIds: [] as string[],
      };
      await cap.hooks!.onConnect!(hookCtx);
      expect(hookCtx.broadcast).toHaveBeenCalledWith("preview_close", {});
    });

    it("re-establishes preview when session owns it and container healthy", async () => {
      const provider = mockProvider();
      const cap = vibeCoder({ provider });
      const hookCtx = {
        agentId: "test-agent",
        sessionId: "session-abc",
        sessionStore: {} as any,
        storage: {
          get: vi.fn().mockResolvedValue({ port: 5173, sessionId: "session-abc" }),
          put: vi.fn(),
          delete: vi.fn(),
          list: vi.fn(),
        },
        broadcast: vi.fn(),
        capabilityIds: [] as string[],
      };
      await cap.hooks!.onConnect!(hookCtx);
      expect(provider.setDevPort).toHaveBeenCalledWith(5173, "/preview/test-agent/");
      expect(hookCtx.broadcast).toHaveBeenCalledWith("preview_open", { port: 5173 });
    });

    it("does not destroy another session's preview state", async () => {
      const provider = mockProvider();
      const cap = vibeCoder({ provider });
      const hookCtx = {
        agentId: "test-agent",
        sessionId: "session-xyz",
        sessionStore: {} as any,
        storage: {
          get: vi.fn().mockResolvedValue({ port: 5173, sessionId: "session-abc" }),
          put: vi.fn(),
          delete: vi.fn().mockResolvedValue(false),
          list: vi.fn(),
        },
        broadcast: vi.fn(),
        capabilityIds: [] as string[],
      };
      await cap.hooks!.onConnect!(hookCtx);
      // Should tell this client to close preview UI
      expect(hookCtx.broadcast).toHaveBeenCalledWith("preview_close", {});
      // Should NOT touch storage or provider — another session owns the preview
      expect(provider.clearDevPort).not.toHaveBeenCalled();
      expect(hookCtx.storage.delete).not.toHaveBeenCalled();
      expect(provider.setDevPort).not.toHaveBeenCalled();
    });

    it("clears stale state when container is dead", async () => {
      const provider = mockProvider();
      (provider.health as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Connection refused"),
      );
      const cap = vibeCoder({ provider });
      const hookCtx = {
        agentId: "test-agent",
        sessionId: "session-abc",
        sessionStore: {} as any,
        storage: {
          get: vi.fn().mockResolvedValue({ port: 5173, sessionId: "session-abc" }),
          put: vi.fn(),
          delete: vi.fn().mockResolvedValue(false),
          list: vi.fn(),
        },
        broadcast: vi.fn(),
        capabilityIds: [] as string[],
      };
      await cap.hooks!.onConnect!(hookCtx);
      expect(hookCtx.storage.delete).toHaveBeenCalledWith("preview");
      expect(hookCtx.broadcast).toHaveBeenCalledWith("preview_close", {});
    });
  });

  describe("cross-session preview scenarios", () => {
    /** Map-backed storage so state persists across tool calls. */
    function createMapStorage(): CapabilityStorage {
      const store = new Map<string, unknown>();
      return {
        get: vi.fn(async (key: string) => store.get(key)),
        put: vi.fn(async (key: string, value: unknown) => {
          store.set(key, value);
        }),
        delete: vi.fn(async (key: string) => store.delete(key)),
        list: vi.fn(async (prefix?: string) => {
          const result = new Map<string, unknown>();
          for (const [k, v] of store) {
            if (!prefix || k.startsWith(prefix)) result.set(k, v);
          }
          return result;
        }),
      } as CapabilityStorage;
    }

    it("session B show_preview overwrites session A's preview", async () => {
      const provider = mockProvider();
      const storage = createMapStorage();

      const ctxA: AgentContext = { ...mockContext("session-a"), storage };
      const ctxB: AgentContext = { ...mockContext("session-b"), storage };

      const cap = vibeCoder({ provider });
      const toolsA = cap.tools!(ctxA);
      const toolsB = cap.tools!(ctxB);
      const showA = toolsA.find((t) => t.name === "show_preview")!;
      const showB = toolsB.find((t) => t.name === "show_preview")!;

      // Session A opens preview
      await showA.execute({ port: 5173 }, { toolCallId: "tc1" });
      expect(await storage.get("preview")).toEqual({ port: 5173, sessionId: "session-a" });

      // Session B opens preview — takes over
      await showB.execute({ port: 3000 }, { toolCallId: "tc2" });
      expect(await storage.get("preview")).toEqual({ port: 3000, sessionId: "session-b" });

      // Session A's hide_preview should now be rejected (B owns it)
      const hideA = toolsA.find((t) => t.name === "hide_preview")!;
      const result = await hideA.execute({}, { toolCallId: "tc3" });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("No active preview");
      expect(provider.clearDevPort).not.toHaveBeenCalled();
    });

    it("session A de-elevates closes preview, session B can open new one", async () => {
      const provider = mockProvider();
      const storage = createMapStorage();

      const ctxA: AgentContext = { ...mockContext("session-a"), storage };
      const ctxB: AgentContext = { ...mockContext("session-b"), storage };

      const cap = vibeCoder({ provider });
      const toolsA = cap.tools!(ctxA);
      const toolsB = cap.tools!(ctxB);

      // Session A opens preview
      const showA = toolsA.find((t) => t.name === "show_preview")!;
      await showA.execute({ port: 5173 }, { toolCallId: "tc1" });

      // Session A de-elevates — afterToolExecution should close preview
      await cap.hooks!.afterToolExecution!(
        { toolName: "de_elevate", args: {}, isError: false },
        {
          agentId: "test-agent",
          sessionId: "session-a",
          sessionStore: {} as any,
          storage,
          broadcast: vi.fn(),
          capabilityIds: [],
        },
      );
      expect(await storage.get("preview")).toBeUndefined();
      expect(provider.clearDevPort).toHaveBeenCalled();
      (provider.clearDevPort as ReturnType<typeof vi.fn>).mockClear();

      // Session B can now open a fresh preview
      const showB = toolsB.find((t) => t.name === "show_preview")!;
      await showB.execute({ port: 3000 }, { toolCallId: "tc2" });
      expect(await storage.get("preview")).toEqual({ port: 3000, sessionId: "session-b" });
      expect(provider.setDevPort).toHaveBeenCalledWith(3000, "/preview/test-agent/");
    });

    it("onConnect cleans up stale preview after idle timeout (container dead)", async () => {
      const provider = mockProvider();
      const storage = createMapStorage();

      // Simulate: session A had a preview, then idle timeout killed the container
      await storage.put("preview", { port: 5173, sessionId: "session-a" });
      (provider.health as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Container stopped"),
      );

      const cap = vibeCoder({ provider });

      // Session A reconnects — container is dead, preview should be cleaned up
      const broadcastA = vi.fn();
      await cap.hooks!.onConnect!({
        agentId: "test-agent",
        sessionId: "session-a",
        sessionStore: {} as any,
        storage,
        broadcast: broadcastA,
        capabilityIds: [],
      });

      expect(await storage.get("preview")).toBeUndefined();
      expect(broadcastA).toHaveBeenCalledWith("preview_close", {});

      // Session B reconnects — no preview state, gets preview_close (no-op for UI)
      const broadcastB = vi.fn();
      (provider.health as ReturnType<typeof vi.fn>).mockResolvedValue({ ready: true });
      await cap.hooks!.onConnect!({
        agentId: "test-agent",
        sessionId: "session-b",
        sessionStore: {} as any,
        storage,
        broadcast: broadcastB,
        capabilityIds: [],
      });
      expect(broadcastB).toHaveBeenCalledWith("preview_close", {});
    });
  });
});
