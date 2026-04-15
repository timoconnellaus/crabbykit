import { describe, expect, it, vi } from "vitest";

// Mock cloudflare:workers
class MockDurableObject {}
// biome-ignore lint/style/useNamingConvention: Must match cloudflare:workers export name
vi.mock("cloudflare:workers", () => ({ DurableObject: MockDurableObject }));

const { subagentCapability, createSubagentAuthChecker } = await import("../capability.js");

import type { SubagentHost } from "../host.js";
import type { Mode } from "../types.js";

function mockHost(): SubagentHost {
  return {
    createSubagentSession: vi.fn().mockReturnValue({ id: "child-1" }),
    runSubagentBlocking: vi.fn().mockResolvedValue({ responseText: "ok", success: true }),
    startSubagentAsync: vi.fn(),
    isSessionStreaming: vi.fn().mockReturnValue(false),
    steerSession: vi.fn(),
    promptSession: vi.fn().mockResolvedValue(undefined),
    abortSession: vi.fn().mockResolvedValue(undefined),
    broadcastToSession: vi.fn(),
  };
}

const TEST_MODE: Mode = {
  id: "explorer",
  name: "Explorer",
  description: "Read-only search",
  systemPromptOverride: "Explore",
};

describe("subagentCapability", () => {
  it("has correct id and metadata", () => {
    const cap = subagentCapability({
      host: mockHost(),
      modes: [TEST_MODE],
      getSystemPrompt: () => "Parent prompt",
      getParentTools: () => [],
    });

    expect(cap.id).toBe("subagent");
    expect(cap.name).toBe("Subagent");
  });

  it("provides 4 tools", () => {
    const cap = subagentCapability({
      host: mockHost(),
      modes: [TEST_MODE],
      getSystemPrompt: () => "Parent prompt",
      getParentTools: () => [],
    });

    const mockStorage = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn().mockResolvedValue(new Map()),
    };

    const tools = cap.tools!({
      agentId: "agent-1",
      sessionId: "session-1",
      stepNumber: 0,
      emitCost: vi.fn(),
      broadcast: vi.fn(),
      broadcastToAll: vi.fn(),
      broadcastState: vi.fn(),
      requestFromClient: vi.fn(),
      schedules: {} as any,
      storage: mockStorage,
      rateLimit: { consume: async () => ({ allowed: true }) },
      notifyBundlePointerChanged: async () => {},
    });

    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name);
    expect(names).toContain("call_subagent");
    expect(names).toContain("start_subagent");
    expect(names).toContain("check_subagent");
    expect(names).toContain("cancel_subagent");
  });

  it("provides prompt sections listing profiles", () => {
    const cap = subagentCapability({
      host: mockHost(),
      modes: [TEST_MODE],
      getSystemPrompt: () => "",
      getParentTools: () => [],
    });

    const sections = cap.promptSections!({} as any);
    expect(sections[0]).toContain("explorer");
    expect(sections[0]).toContain("Read-only search");
  });

  it("onConnect detects orphaned subagents", async () => {
    const cap = subagentCapability({
      host: mockHost(),
      modes: [],
      getSystemPrompt: () => "",
      getParentTools: () => [],
    });

    const storage = new Map<string, unknown>();
    // Simulate a pending subagent left from before hibernation
    storage.set("subagent:orphan-1", {
      subagentId: "orphan-1",
      modeId: "explorer",
      childSessionId: "child-1",
      parentSessionId: "parent-1",
      prompt: "Search something",
      state: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const broadcast = vi.fn();
    const mockStorageApi = {
      get: async <T>(key: string) => storage.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
      delete: async (key: string) => storage.delete(key),
      list: async <T>(prefix: string) => {
        const result = new Map<string, T>();
        for (const [k, v] of storage) {
          if (k.startsWith(prefix)) result.set(k, v as T);
        }
        return result;
      },
    };

    await cap.hooks!.onConnect!({
      agentId: "agent-1",
      sessionId: "session-1",
      sessionStore: {} as any,
      storage: mockStorageApi,
      capabilityIds: [],
      broadcast,
      broadcastState: () => {},
    });

    expect(broadcast).toHaveBeenCalledWith(
      "subagent_orphaned",
      expect.objectContaining({ count: 1 }),
    );
    // Orphan should be cleaned up
    expect(storage.has("subagent:orphan-1")).toBe(false);
  });
});

describe("createSubagentAuthChecker", () => {
  it("allows owner session", () => {
    const checker = createSubagentAuthChecker(new Map());
    expect(checker("session-a", "session-a")).toBe(true);
  });

  it("rejects non-owner with no parent chain", () => {
    const checker = createSubagentAuthChecker(new Map());
    expect(checker("session-b", "session-a")).toBe(false);
  });

  it("allows direct child of owner", () => {
    const parentMap = new Map([["child-session", "session-a"]]);
    const checker = createSubagentAuthChecker(parentMap);
    expect(checker("child-session", "session-a")).toBe(true);
  });

  it("allows grandchild of owner", () => {
    const parentMap = new Map([
      ["grandchild", "child"],
      ["child", "session-a"],
    ]);
    const checker = createSubagentAuthChecker(parentMap);
    expect(checker("grandchild", "session-a")).toBe(true);
  });

  it("rejects child of different owner", () => {
    const parentMap = new Map([["child-of-b", "session-b"]]);
    const checker = createSubagentAuthChecker(parentMap);
    expect(checker("child-of-b", "session-a")).toBe(false);
  });

  it("handles circular references without infinite loop", () => {
    const parentMap = new Map([
      ["a", "b"],
      ["b", "a"],
    ]);
    const checker = createSubagentAuthChecker(parentMap);
    // Should terminate without hanging
    expect(checker("a", "c")).toBe(false);
  });
});
