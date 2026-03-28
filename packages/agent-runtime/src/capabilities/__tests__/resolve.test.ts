import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentContext } from "../../agent-do.js";
import { defineCommand } from "../../commands/define-command.js";
import { resolveCapabilities } from "../resolve.js";
import type { CapabilityStorage } from "../storage.js";
import { createNoopStorage } from "../storage.js";
import type { Capability, CapabilityHookContext, ToolExecutionEvent } from "../types.js";

const mockSchedules = {
  create: async () => ({}) as any,
  update: async () => null,
  delete: async () => {},
  list: () => [],
  get: () => null,
};

const ctx: AgentContext = {
  sessionId: "s1",
  stepNumber: 0,
  emitCost: () => {},
  schedules: mockSchedules,
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

  it("resolves prompt sections from a single capability", () => {
    const cap = makeCap({
      id: "memory",
      promptSections: () => ["You have access to memory.", "Use it wisely."],
    });

    const result = resolveCapabilities([cap], ctx);

    expect(result.promptSections).toEqual(["You have access to memory.", "Use it wisely."]);
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
      sessionId: "s1",
      sessionStore: {} as any,
      storage: createNoopStorage(),
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
    expect(result.promptSections).toEqual(["Section A", "Section B"]);
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
      sessionId: "s1",
      sessionStore: {} as any,
      storage: createNoopStorage(),
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
      sessionId: "s1",
      sessionStore: {} as any,
      storage: createNoopStorage(), // This should be overridden per hook
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
      sessionId: "s1",
      sessionStore: {} as any,
      storage: createNoopStorage(),
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
      sessionId: "s1",
      sessionStore: {} as any,
      storage: createNoopStorage(),
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
      sessionId: "s1",
      sessionStore: {} as any,
      storage: createNoopStorage(),
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
      sessionId: "s1",
      sessionStore: {} as any,
      storage: createNoopStorage(),
    };
    await result.afterToolExecutionHooks[0](event, hookCtx);
    expect(receivedStorage).toBe(scopedStorage);
  });

  it("returns empty afterToolExecutionHooks for empty capabilities", () => {
    const result = resolveCapabilities([], ctx);
    expect(result.afterToolExecutionHooks).toEqual([]);
  });
});
