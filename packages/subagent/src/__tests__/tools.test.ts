import { describe, expect, it, vi } from "vitest";

// Mock cloudflare:workers to avoid resolution failure
class MockDurableObject {}
// biome-ignore lint/style/useNamingConvention: Must match cloudflare:workers export name
vi.mock("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));

const {
  createCallSubagentTool,
  createStartSubagentTool,
  createCheckSubagentTool,
  createCancelSubagentTool,
} = await import("../tools.js");

import type { SubagentHost, SubagentRunResult } from "../host.js";
import type { Mode } from "../types.js";

// ============================================================================
// Helpers
// ============================================================================

const PARENT_SESSION = "parent-session";
const CHILD_SESSION = "child-session-1";

const TEST_MODE: Mode = {
  id: "explorer",
  name: "Explorer",
  description: "Read-only codebase search",
  systemPromptOverride: "Explore the codebase",
  tools: { allow: ["file_read", "grep"] },
};

function mockTool(name: string) {
  return {
    name,
    label: name,
    description: `Mock ${name}`,
    parameters: {},
    execute: async () => ({ content: [{ type: "text" as const, text: "" }], details: {} }),
  };
}

function mockStorage() {
  const store = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => store.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    delete: async (key: string) => store.delete(key),
    list: async <T>(prefix: string) => {
      const result = new Map<string, T>();
      for (const [k, v] of store) {
        if (k.startsWith(prefix)) result.set(k, v as T);
      }
      return result;
    },
  };
}

function mockHost(overrides?: Partial<SubagentHost>): SubagentHost {
  return {
    createSubagentSession: vi.fn().mockReturnValue({ id: CHILD_SESSION }),
    runSubagentBlocking: vi.fn().mockResolvedValue({
      responseText: "Found 5 auth modules",
      success: true,
    } satisfies SubagentRunResult),
    startSubagentAsync: vi.fn(),
    isSessionStreaming: vi.fn().mockReturnValue(false),
    steerSession: vi.fn(),
    promptSession: vi.fn().mockResolvedValue(undefined),
    abortSession: vi.fn().mockResolvedValue(undefined),
    broadcastToSession: vi.fn(),
    ...overrides,
  };
}

function setup(hostOverrides?: Partial<SubagentHost>) {
  const host = mockHost(hostOverrides);
  const storage = mockStorage();
  const broadcast = vi.fn();

  const deps = {
    getHost: () => host,
    getModes: () => [TEST_MODE],
    getParentSessionId: () => PARENT_SESSION,
    getParentSystemPrompt: () => "Parent prompt",
    getParentTools: () => [mockTool("file_read"), mockTool("grep"), mockTool("file_write")],
    getStorage: () => storage,
    getBroadcast: () => broadcast,
  };

  return { host, storage, broadcast, deps };
}

async function exec(
  tool: {
    execute: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown> | unknown;
  },
  args: Record<string, unknown>,
) {
  return (await tool.execute(args, { toolCallId: "test", signal: undefined })) as any;
}

function textContent(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text;
}

// ============================================================================
// call_subagent (blocking)
// ============================================================================

describe("call_subagent tool", () => {
  it("creates child session and returns result", async () => {
    const { host, deps } = setup();
    const tool = createCallSubagentTool(deps);

    const result = await exec(tool, {
      mode: "explorer",
      prompt: "Find auth modules",
    });

    expect(host.createSubagentSession).toHaveBeenCalledWith({
      name: expect.stringContaining("Explorer"),
      parentSessionId: PARENT_SESSION,
    });
    expect(host.runSubagentBlocking).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: CHILD_SESSION,
        prompt: "Find auth modules",
      }),
    );
    expect(textContent(result)).toContain("Found 5 auth modules");
    expect(result.details.success).toBe(true);
  });

  it("returns error for unknown mode", async () => {
    const { deps } = setup();
    const tool = createCallSubagentTool(deps);

    const result = await exec(tool, {
      mode: "nonexistent",
      prompt: "Do something",
    });

    expect(textContent(result)).toContain('Unknown mode "nonexistent"');
    expect(textContent(result)).toContain("explorer");
  });

  it("returns error on agent failure", async () => {
    const { deps } = setup({
      runSubagentBlocking: vi.fn().mockResolvedValue({
        responseText: "",
        success: false,
        error: "Model error",
      }),
    });
    const tool = createCallSubagentTool(deps);

    const result = await exec(tool, {
      mode: "explorer",
      prompt: "Fail please",
    });

    expect(textContent(result)).toContain("failed");
    expect(textContent(result)).toContain("Model error");
  });

  it("handles thrown exceptions", async () => {
    const { deps } = setup({
      runSubagentBlocking: vi.fn().mockRejectedValue(new Error("Connection lost")),
    });
    const tool = createCallSubagentTool(deps);

    const result = await exec(tool, {
      mode: "explorer",
      prompt: "Break",
    });

    expect(textContent(result)).toContain("Connection lost");
  });

  it("filters tools to mode allow list", async () => {
    const { host, deps } = setup();
    const tool = createCallSubagentTool(deps);

    await exec(tool, { mode: "explorer", prompt: "Search" });

    const runCall = (host.runSubagentBlocking as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const toolNames = runCall.tools.map((t: any) => t.name);
    // Explorer mode allows ["file_read", "grep"], parent has ["file_read", "grep", "file_write"]
    expect(toolNames).toEqual(["file_read", "grep"]);
  });
});

// ============================================================================
// start_subagent (non-blocking)
// ============================================================================

describe("start_subagent tool", () => {
  it("returns immediately with subagent ID", async () => {
    const { host, deps } = setup();
    const tool = createStartSubagentTool(deps);

    const result = await exec(tool, {
      mode: "explorer",
      prompt: "Find auth modules",
    });

    expect(textContent(result)).toContain("started");
    expect(result.details.subagentId).toBe(CHILD_SESSION);
    expect(host.startSubagentAsync).toHaveBeenCalled();
  });

  it("stores pending record in storage", async () => {
    const { storage, deps } = setup();
    const tool = createStartSubagentTool(deps);

    await exec(tool, { mode: "explorer", prompt: "Search" });

    const stored = await storage.get(`subagent:${CHILD_SESSION}`);
    expect(stored).toBeDefined();
    expect((stored as any).state).toBe("running");
    expect((stored as any).modeId).toBe("explorer");
  });

  it("broadcasts initial status", async () => {
    const { broadcast, deps } = setup();
    const tool = createStartSubagentTool(deps);

    await exec(tool, { mode: "explorer", prompt: "Search" });

    expect(broadcast).toHaveBeenCalledWith(
      "subagent_status",
      expect.objectContaining({ state: "running", modeId: "explorer" }),
    );
  });

  it("returns error for unknown mode", async () => {
    const { deps } = setup();
    const tool = createStartSubagentTool(deps);

    const result = await exec(tool, {
      mode: "nonexistent",
      prompt: "Do something",
    });

    expect(textContent(result)).toContain("Unknown mode");
  });

  it("completion callback steers when parent is streaming", async () => {
    let capturedCallback: ((result: SubagentRunResult) => void | Promise<void>) | undefined;
    const { host, deps } = setup({
      startSubagentAsync: vi.fn().mockImplementation((_opts, cb) => {
        capturedCallback = cb;
      }),
      isSessionStreaming: vi.fn().mockReturnValue(true),
    });

    const tool = createStartSubagentTool(deps);
    await exec(tool, { mode: "explorer", prompt: "Search" });

    // Simulate completion
    await capturedCallback!({ responseText: "Found stuff", success: true });

    expect(host.steerSession).toHaveBeenCalledWith(
      PARENT_SESSION,
      expect.stringContaining("Found stuff"),
    );
    expect(host.promptSession).not.toHaveBeenCalled();
  });

  it("completion callback prompts when parent is idle", async () => {
    let capturedCallback: ((result: SubagentRunResult) => void | Promise<void>) | undefined;
    const { host, deps } = setup({
      startSubagentAsync: vi.fn().mockImplementation((_opts, cb) => {
        capturedCallback = cb;
      }),
      isSessionStreaming: vi.fn().mockReturnValue(false),
    });

    const tool = createStartSubagentTool(deps);
    await exec(tool, { mode: "explorer", prompt: "Search" });

    await capturedCallback!({ responseText: "Found stuff", success: true });

    expect(host.promptSession).toHaveBeenCalledWith(
      PARENT_SESSION,
      expect.stringContaining("Found stuff"),
    );
    expect(host.steerSession).not.toHaveBeenCalled();
  });

  it("completion callback handles prompt failure gracefully", async () => {
    let capturedCallback: ((result: SubagentRunResult) => void | Promise<void>) | undefined;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = setup({
      startSubagentAsync: vi.fn().mockImplementation((_opts, cb) => {
        capturedCallback = cb;
      }),
      isSessionStreaming: vi.fn().mockReturnValue(false),
      promptSession: vi.fn().mockRejectedValue(new Error("Session busy")),
    });

    const tool = createStartSubagentTool(deps);
    await exec(tool, { mode: "explorer", prompt: "Search" });

    // Should not throw
    await capturedCallback!({ responseText: "Found stuff", success: true });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("completion callback handles failed result", async () => {
    let capturedCallback: ((result: SubagentRunResult) => void | Promise<void>) | undefined;
    const { broadcast, deps } = setup({
      startSubagentAsync: vi.fn().mockImplementation((_opts, cb) => {
        capturedCallback = cb;
      }),
      isSessionStreaming: vi.fn().mockReturnValue(false),
    });

    const tool = createStartSubagentTool(deps);
    await exec(tool, { mode: "explorer", prompt: "Search" });

    await capturedCallback!({
      responseText: "",
      success: false,
      error: "Model error",
    });

    // Should broadcast failed state
    const statusCalls = broadcast.mock.calls.filter(
      (c: any) => c[0] === "subagent_status" && c[1].state === "failed",
    );
    expect(statusCalls.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// check_subagent
// ============================================================================

describe("check_subagent tool", () => {
  it("returns status for active subagent", async () => {
    const { storage, deps } = setup();
    // Pre-populate storage
    await storage.put(`subagent:${CHILD_SESSION}`, {
      subagentId: CHILD_SESSION,
      modeId: "explorer",
      prompt: "Find auth",
      state: "running",
    });

    const tool = createCheckSubagentTool(deps);
    const result = await exec(tool, { subagentId: CHILD_SESSION });

    expect(textContent(result)).toContain("running");
    expect(textContent(result)).toContain("explorer");
  });

  it("returns not found for completed subagent", async () => {
    const { deps } = setup();
    const tool = createCheckSubagentTool(deps);
    const result = await exec(tool, { subagentId: "non-existent" });

    expect(textContent(result)).toContain("No active subagent");
  });
});

// ============================================================================
// cancel_subagent
// ============================================================================

describe("cancel_subagent tool", () => {
  it("aborts running subagent", async () => {
    const { host, storage, broadcast, deps } = setup();
    await storage.put(`subagent:${CHILD_SESSION}`, {
      subagentId: CHILD_SESSION,
      modeId: "explorer",
      childSessionId: CHILD_SESSION,
      state: "running",
    });

    const tool = createCancelSubagentTool(deps);
    const result = await exec(tool, { subagentId: CHILD_SESSION });

    expect(host.abortSession).toHaveBeenCalledWith(CHILD_SESSION);
    expect(textContent(result)).toContain("canceled");
    expect(broadcast).toHaveBeenCalledWith(
      "subagent_status",
      expect.objectContaining({ state: "canceled" }),
    );
  });

  it("returns not found for non-existent", async () => {
    const { deps } = setup();
    const tool = createCancelSubagentTool(deps);
    const result = await exec(tool, { subagentId: "non-existent" });

    expect(textContent(result)).toContain("No active subagent");
  });

  it("returns already completed for non-running", async () => {
    const { storage, deps } = setup();
    await storage.put(`subagent:${CHILD_SESSION}`, {
      subagentId: CHILD_SESSION,
      modeId: "explorer",
      state: "completed",
    });

    const tool = createCancelSubagentTool(deps);
    const result = await exec(tool, { subagentId: CHILD_SESSION });

    expect(textContent(result)).toContain("already completed");
  });
});
