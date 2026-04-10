import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentContext } from "../../agent-do.js";
import { defineCommand } from "../../commands/define-command.js";
import { resolveCapabilities } from "../resolve.js";
import type { CapabilityStorage } from "../storage.js";
import { createNoopStorage } from "../storage.js";
import type {
  BeforeToolExecutionEvent,
  Capability,
  CapabilityHookContext,
  ToolExecutionEvent,
} from "../types.js";

const mockSchedules = {
  create: async () => ({}) as any,
  update: async () => null,
  delete: async () => {},
  list: () => [],
  get: () => null,
  setTimer: async () => {},
  cancelTimer: async () => {},
};

const mockRateLimit = {
  consume: async () => ({ allowed: true }),
};

const ctx: AgentContext = {
  agentId: "test-agent",
  sessionId: "s1",
  stepNumber: 0,
  emitCost: () => {},
  broadcast: () => {},
  broadcastToAll: () => {},
  requestFromClient: () => Promise.reject(new Error("Not available")),
  storage: createNoopStorage(),
  broadcastState: () => {},
  schedules: mockSchedules,
  rateLimit: mockRateLimit,
};

function makeTool(name: string): AgentTool {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: null }),
  } as unknown as AgentTool;
}

function makeCap(overrides: Partial<Capability> & { id: string }): Capability {
  return {
    name: overrides.id,
    description: `Capability ${overrides.id}`,
    ...overrides,
  };
}

describe("resolveCapabilities", () => {
  it("returns empty result for empty capabilities array", () => {
    const result = resolveCapabilities([], ctx);

    expect(result.tools).toEqual([]);
    expect(result.commands).toEqual([]);
    expect(result.promptSections).toEqual([]);
    expect(result.mcpServers).toEqual([]);
    expect(result.beforeInferenceHooks).toEqual([]);
  });

  it("resolves tools from a single capability", () => {
    const tool = makeTool("search");
    const cap = makeCap({
      id: "web-search",
      tools: () => [tool],
    });

    const result = resolveCapabilities([cap], ctx);

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("search");
  });

  it("resolves multiple prompt sections from a single capability with numbered names", () => {
    const cap = makeCap({
      id: "memory",
      promptSections: () => ["You have access to memory.", "Use it wisely."],
    });

    const result = resolveCapabilities([cap], ctx);

    expect(result.promptSections).toHaveLength(2);
    expect(result.promptSections[0]).toMatchObject({
      name: "memory (1)",
      key: "cap-memory-1",
      content: "You have access to memory.",
    });
    expect(result.promptSections[1]).toMatchObject({
      name: "memory (2)",
      key: "cap-memory-2",
      content: "Use it wisely.",
    });
  });

  it("uses capability name directly when only one prompt section (with stable indexed key)", () => {
    const cap = makeCap({
      id: "web-search",
      name: "Web Search",
      promptSections: () => ["You can search the web."],
    });

    const result = resolveCapabilities([cap], ctx);

    expect(result.promptSections).toHaveLength(1);
    expect(result.promptSections[0]).toMatchObject({
      name: "Web Search",
      // Stable index-suffixed key: single-section capabilities still get `-1`
      // so the key doesn't change if the capability later adds a second section.
      key: "cap-web-search-1",
      content: "You can search the web.",
      lines: 1,
      included: true,
      source: { type: "capability", capabilityId: "web-search", capabilityName: "Web Search" },
    });
  });

  it("surfaces capability sections returned with kind: excluded", () => {
    const cap = makeCap({
      id: "skills",
      name: "Skills",
      promptSections: () => [{ kind: "excluded", reason: "No skills enabled" }],
    });

    const result = resolveCapabilities([cap], ctx);

    expect(result.promptSections).toHaveLength(1);
    expect(result.promptSections[0]).toMatchObject({
      name: "Skills",
      key: "cap-skills-1",
      content: "",
      lines: 0,
      included: false,
      excludedReason: "No skills enabled",
      source: { type: "capability", capabilityId: "skills", capabilityName: "Skills" },
    });
  });

  it("accepts mixed included/excluded sections from one capability", () => {
    const cap = makeCap({
      id: "multi",
      name: "Multi",
      promptSections: () => [
        "Always on section",
        { kind: "excluded", reason: "Feature toggled off" },
        { kind: "included", content: "Custom-named block", name: "Highlights" },
      ],
    });

    const result = resolveCapabilities([cap], ctx);

    expect(result.promptSections).toHaveLength(3);
    expect(result.promptSections[0]).toMatchObject({
      key: "cap-multi-1",
      content: "Always on section",
      included: true,
    });
    expect(result.promptSections[1]).toMatchObject({
      key: "cap-multi-2",
      included: false,
      excludedReason: "Feature toggled off",
    });
    expect(result.promptSections[2]).toMatchObject({
      key: "cap-multi-3",
      name: "Highlights",
      content: "Custom-named block",
      included: true,
    });
  });

  it("resolves MCP servers from a single capability", () => {
    const cap = makeCap({
      id: "mcp-test",
      mcpServers: [{ id: "srv1", name: "Test Server", url: "http://localhost:3000" } as any],
    });

    const result = resolveCapabilities([cap], ctx);

    expect(result.mcpServers).toHaveLength(1);
    expect(result.mcpServers[0].name).toBe("Test Server");
  });

  it("collects beforeInference hooks", async () => {
    const hook = async (msgs: any[]) => msgs;
    const cap = makeCap({
      id: "compaction",
      hooks: { beforeInference: hook },
    });

    const result = resolveCapabilities([cap], ctx);

    expect(result.beforeInferenceHooks).toHaveLength(1);
    // Hook is wrapped — verify it delegates correctly
    const msgs = [{ role: "user", content: "hello" }] as any[];
    const hookCtx: CapabilityHookContext = {
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: createNoopStorage(),
      capabilityIds: [],
    };
    const output = await result.beforeInferenceHooks[0](msgs, hookCtx);
    expect(output).toBe(msgs);
  });

  it("merges multiple capabilities in registration order", () => {
    const cap1 = makeCap({
      id: "cap-a",
      tools: () => [makeTool("tool_a")],
      promptSections: () => ["Section A"],
    });
    const cap2 = makeCap({
      id: "cap-b",
      tools: () => [makeTool("tool_b")],
      promptSections: () => ["Section B"],
    });

    const result = resolveCapabilities([cap1, cap2], ctx);

    expect(result.tools.map((t) => t.name)).toEqual(["tool_a", "tool_b"]);
    expect(result.promptSections.map((s) => s.content)).toEqual(["Section A", "Section B"]);
  });

  it("preserves hook execution order matching registration order", async () => {
    const order: string[] = [];
    const hook1 = async (msgs: any[]) => {
      order.push("first");
      return msgs;
    };
    const hook2 = async (msgs: any[]) => {
      order.push("second");
      return msgs;
    };

    const cap1 = makeCap({ id: "a", hooks: { beforeInference: hook1 } });
    const cap2 = makeCap({ id: "b", hooks: { beforeInference: hook2 } });

    const result = resolveCapabilities([cap1, cap2], ctx);

    expect(result.beforeInferenceHooks).toHaveLength(2);

    // Execute both hooks and verify order
    const hookCtx: CapabilityHookContext = {
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: createNoopStorage(),
      capabilityIds: [],
    };
    const msgs = [] as any[];
    await result.beforeInferenceHooks[0](msgs, hookCtx);
    await result.beforeInferenceHooks[1](msgs, hookCtx);
    expect(order).toEqual(["first", "second"]);
  });

  it("warns and skips duplicate tool names", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cap1 = makeCap({
      id: "cap-a",
      tools: () => [makeTool("shared_name")],
    });
    const cap2 = makeCap({
      id: "cap-b",
      tools: () => [makeTool("shared_name")],
    });

    const result = resolveCapabilities([cap1, cap2], ctx);

    expect(result.tools).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate tool name "shared_name"'),
    );

    warnSpy.mockRestore();
  });

  it("handles capability with no optional fields", () => {
    const cap = makeCap({ id: "bare-minimum" });
    const result = resolveCapabilities([cap], ctx);

    expect(result.tools).toEqual([]);
    expect(result.promptSections).toEqual([]);
    expect(result.mcpServers).toEqual([]);
    expect(result.beforeInferenceHooks).toEqual([]);
  });

  it("passes context with storage to tools and promptSections factories", () => {
    const toolsFn = vi.fn(() => [makeTool("t1")]);
    const promptFn = vi.fn(() => ["prompt"]);

    const cap = makeCap({
      id: "ctx-test",
      tools: toolsFn,
      promptSections: promptFn,
    });

    resolveCapabilities([cap], ctx);

    // Context should have storage added (noop by default)
    expect(toolsFn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        stepNumber: 0,
        storage: expect.any(Object),
      }),
    );
    expect(promptFn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        storage: expect.any(Object),
      }),
    );
  });

  it("provides scoped storage to each capability", () => {
    const storages: (CapabilityStorage | undefined)[] = [];
    const cap1 = makeCap({
      id: "cap-a",
      tools: (ctx) => {
        storages.push(ctx.storage);
        return [];
      },
    });
    const cap2 = makeCap({
      id: "cap-b",
      tools: (ctx) => {
        storages.push(ctx.storage);
        return [];
      },
    });

    const mockStorageFactory = vi.fn((_id: string) => createNoopStorage());
    resolveCapabilities([cap1, cap2], ctx, mockStorageFactory);

    expect(mockStorageFactory).toHaveBeenCalledWith("cap-a");
    expect(mockStorageFactory).toHaveBeenCalledWith("cap-b");
    expect(storages).toHaveLength(2);
    // Each capability gets its own storage instance
    expect(storages[0]).not.toBe(storages[1]);
  });

  it("injects capability-scoped storage into hook context", async () => {
    const hookStorages: CapabilityStorage[] = [];
    const cap1 = makeCap({
      id: "cap-a",
      hooks: {
        beforeInference: async (msgs, ctx) => {
          hookStorages.push(ctx.storage);
          return msgs;
        },
      },
    });
    const cap2 = makeCap({
      id: "cap-b",
      hooks: {
        beforeInference: async (msgs, ctx) => {
          hookStorages.push(ctx.storage);
          return msgs;
        },
      },
    });

    const storageA = createNoopStorage();
    const storageB = createNoopStorage();
    const factory = (id: string) => (id === "cap-a" ? storageA : storageB);

    const result = resolveCapabilities([cap1, cap2], ctx, factory);

    const baseHookCtx: CapabilityHookContext = {
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: createNoopStorage(), // This should be overridden per hook
      capabilityIds: [],
    };
    await result.beforeInferenceHooks[0]([], baseHookCtx);
    await result.beforeInferenceHooks[1]([], baseHookCtx);

    expect(hookStorages[0]).toBe(storageA);
    expect(hookStorages[1]).toBe(storageB);
  });

  it("uses noop storage when no factory provided", async () => {
    let receivedStorage: CapabilityStorage | undefined;
    const cap = makeCap({
      id: "test",
      hooks: {
        beforeInference: async (msgs, ctx) => {
          receivedStorage = ctx.storage;
          return msgs;
        },
      },
    });

    const result = resolveCapabilities([cap], ctx); // No factory

    const hookCtx: CapabilityHookContext = {
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: createNoopStorage(),
      capabilityIds: [],
    };
    await result.beforeInferenceHooks[0]([], hookCtx);

    expect(receivedStorage).toBeDefined();
    expect(await receivedStorage!.get("anything")).toBeUndefined();
    expect(await receivedStorage!.list()).toEqual(new Map());
  });

  it("resolves commands from a single capability", () => {
    const cmd = defineCommand({
      name: "help",
      description: "Show help",
      execute: () => ({ text: "Available commands: /help" }),
    });
    const cap = makeCap({
      id: "cmd-cap",
      commands: () => [cmd],
    });

    const result = resolveCapabilities([cap], ctx);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].name).toBe("help");
  });

  it("merges commands from multiple capabilities", () => {
    const cap1 = makeCap({
      id: "cap-a",
      commands: () => [
        defineCommand({ name: "alpha", description: "Alpha", execute: () => ({ text: "a" }) }),
      ],
    });
    const cap2 = makeCap({
      id: "cap-b",
      commands: () => [
        defineCommand({ name: "beta", description: "Beta", execute: () => ({ text: "b" }) }),
      ],
    });

    const result = resolveCapabilities([cap1, cap2], ctx);

    expect(result.commands.map((c) => c.name)).toEqual(["alpha", "beta"]);
  });

  it("warns and skips duplicate command names", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cap1 = makeCap({
      id: "cap-a",
      commands: () => [
        defineCommand({ name: "dupe", description: "First", execute: () => ({ text: "1" }) }),
      ],
    });
    const cap2 = makeCap({
      id: "cap-b",
      commands: () => [
        defineCommand({ name: "dupe", description: "Second", execute: () => ({ text: "2" }) }),
      ],
    });

    const result = resolveCapabilities([cap1, cap2], ctx);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].description).toBe("First");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Duplicate command name "dupe"'));

    warnSpy.mockRestore();
  });

  it("collects afterToolExecution hooks", async () => {
    const hookFn = vi.fn(async () => {});
    const cap = makeCap({
      id: "observer",
      hooks: { afterToolExecution: hookFn },
    });

    const result = resolveCapabilities([cap], ctx);

    expect(result.afterToolExecutionHooks).toHaveLength(1);

    const event: ToolExecutionEvent = {
      toolName: "file_write",
      args: { path: "test.md" },
      isError: false,
    };
    const hookCtx: CapabilityHookContext = {
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: createNoopStorage(),
      capabilityIds: [],
    };
    await result.afterToolExecutionHooks[0](event, hookCtx);
    expect(hookFn).toHaveBeenCalledWith(event, expect.objectContaining({ sessionId: "s1" }));
  });

  it("preserves afterToolExecution hook execution order", async () => {
    const order: string[] = [];
    const cap1 = makeCap({
      id: "a",
      hooks: {
        afterToolExecution: async () => {
          order.push("first");
        },
      },
    });
    const cap2 = makeCap({
      id: "b",
      hooks: {
        afterToolExecution: async () => {
          order.push("second");
        },
      },
    });

    const result = resolveCapabilities([cap1, cap2], ctx);
    expect(result.afterToolExecutionHooks).toHaveLength(2);

    const event: ToolExecutionEvent = { toolName: "test", args: {}, isError: false };
    const hookCtx: CapabilityHookContext = {
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: createNoopStorage(),
      capabilityIds: [],
    };
    await result.afterToolExecutionHooks[0](event, hookCtx);
    await result.afterToolExecutionHooks[1](event, hookCtx);
    expect(order).toEqual(["first", "second"]);
  });

  it("injects capability-scoped storage into afterToolExecution hook context", async () => {
    let receivedStorage: CapabilityStorage | undefined;
    const cap = makeCap({
      id: "scoped",
      hooks: {
        afterToolExecution: async (_event, ctx) => {
          receivedStorage = ctx.storage;
        },
      },
    });

    const scopedStorage = createNoopStorage();
    const factory = (_id: string) => scopedStorage;
    const result = resolveCapabilities([cap], ctx, factory);

    const event: ToolExecutionEvent = { toolName: "test", args: {}, isError: false };
    const hookCtx: CapabilityHookContext = {
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: createNoopStorage(),
      capabilityIds: [],
    };
    await result.afterToolExecutionHooks[0](event, hookCtx);
    expect(receivedStorage).toBe(scopedStorage);
  });

  it("returns empty afterToolExecutionHooks for empty capabilities", () => {
    const result = resolveCapabilities([], ctx);
    expect(result.afterToolExecutionHooks).toEqual([]);
  });

  it("resolves HTTP handlers from a capability", () => {
    const handler = async () => new Response("ok");
    const cap = makeCap({
      id: "http-cap",
      httpHandlers: () => [
        { method: "GET" as const, path: "/status", handler },
        { method: "POST" as const, path: "/webhook", handler },
      ],
    });

    const result = resolveCapabilities([cap], ctx);

    expect(result.httpHandlers).toHaveLength(2);
    expect(result.httpHandlers[0].method).toBe("GET");
    expect(result.httpHandlers[0].path).toBe("/status");
    expect(result.httpHandlers[0].capabilityId).toBe("http-cap");
    expect(result.httpHandlers[1].method).toBe("POST");
    expect(result.httpHandlers[1].path).toBe("/webhook");
  });

  it("throws on HTTP handler collision", () => {
    const handler = async () => new Response("ok");
    const cap1 = makeCap({
      id: "cap-a",
      httpHandlers: () => [{ method: "GET" as const, path: "/status", handler }],
    });
    const cap2 = makeCap({
      id: "cap-b",
      httpHandlers: () => [{ method: "GET" as const, path: "/status", handler }],
    });

    expect(() => resolveCapabilities([cap1, cap2], ctx)).toThrow(
      /HTTP handler collision.*GET \/status.*cap-b/,
    );
  });

  it("allows same path with different methods", () => {
    const handler = async () => new Response("ok");
    const cap1 = makeCap({
      id: "cap-a",
      httpHandlers: () => [{ method: "GET" as const, path: "/resource", handler }],
    });
    const cap2 = makeCap({
      id: "cap-b",
      httpHandlers: () => [{ method: "POST" as const, path: "/resource", handler }],
    });

    const result = resolveCapabilities([cap1, cap2], ctx);
    expect(result.httpHandlers).toHaveLength(2);
  });

  it("collects onConnect hooks", async () => {
    const hookFn = vi.fn(async () => {});
    const cap = makeCap({
      id: "connect-cap",
      hooks: { onConnect: hookFn },
    });

    const result = resolveCapabilities([cap], ctx);

    expect(result.onConnectHooks).toHaveLength(1);
    expect(result.onConnectHooks[0].capabilityId).toBe("connect-cap");
    await result.onConnectHooks[0].hook({
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: createNoopStorage(),
      capabilityIds: [],
    });
    expect(hookFn).toHaveBeenCalled();
  });

  it("collects beforeToolExecution hooks", async () => {
    const hookFn = vi.fn(async () => {});
    const cap = makeCap({
      id: "guard-cap",
      hooks: { beforeToolExecution: hookFn },
    });

    const result = resolveCapabilities([cap], ctx);

    expect(result.beforeToolExecutionHooks).toHaveLength(1);
    const event: BeforeToolExecutionEvent = {
      toolName: "file_write",
      toolCallId: "call_123",
      args: { path: "test.md" },
    };
    const hookCtx: CapabilityHookContext = {
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: {} as any,
      storage: createNoopStorage(),
      capabilityIds: [],
    };
    await result.beforeToolExecutionHooks[0](event, hookCtx);
    expect(hookFn).toHaveBeenCalledWith(event, expect.objectContaining({ sessionId: "s1" }));
  });

  // --- Disposer collection ---

  it("collects disposers from capabilities with dispose field", () => {
    const disposeFn = vi.fn().mockResolvedValue(undefined);
    const cap = makeCap({ id: "has-dispose", dispose: disposeFn });
    const result = resolveCapabilities([cap], ctx);

    expect(result.disposers).toHaveLength(1);
    expect(result.disposers[0].capabilityId).toBe("has-dispose");
    expect(result.disposers[0].dispose).toBe(disposeFn);
  });

  it("skips capabilities without dispose field", () => {
    const cap = makeCap({ id: "no-dispose" });
    const result = resolveCapabilities([cap], ctx);

    expect(result.disposers).toHaveLength(0);
  });

  it("collects disposers in registration order", () => {
    const cap1 = makeCap({ id: "a", dispose: vi.fn() });
    const cap2 = makeCap({ id: "b", dispose: vi.fn() });
    const cap3 = makeCap({ id: "c" }); // no dispose
    const result = resolveCapabilities([cap1, cap2, cap3], ctx);

    expect(result.disposers).toHaveLength(2);
    expect(result.disposers[0].capabilityId).toBe("a");
    expect(result.disposers[1].capabilityId).toBe("b");
  });

  it("returns empty disposers for empty capabilities", () => {
    const result = resolveCapabilities([], ctx);
    expect(result.disposers).toEqual([]);
  });
});
